import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import {
  classifyMongoConnectionFailure,
  connectDatabase,
  createMongoConnectionDiagnostic,
  readWindowsDnsServers,
} from "../src/database.js";
import { createApp, resolvePythonExecutable } from "../src/server.js";

const server = createServer(createApp({
  pythonCommand: "bugsentry-python-not-installed",
  databaseReady: () => true,
}));
const issueId = "507f1f77bcf86cd799439011";
const issueItems = [];
let nextIssueNumber = 1;

class FakeIssueModel {
  static find(filter) {
    if (FakeIssueModel.failQueries) return { sort: async () => { throw new Error("database secret"); } };
    const matching = issueItems.filter((issue) => {
      if (filter.status && issue.status !== filter.status) return false;
      if (filter.severity && issue.severity !== filter.severity) return false;
      if (filter.$or && !filter.$or.some((field) => field.title?.test(issue.title)
        || field.project?.test(issue.project) || field.description?.test(issue.description))) return false;
      return true;
    });
    return { sort: async () => matching };
  }

  static async findById(id) {
    return issueItems.find((issue) => issue._id === id) || null;
  }

  static async create(payload) {
    const issue = {
      _id: `${String(nextIssueNumber++).padStart(24, "0")}`,
      status: "Open",
      severity: "Medium",
      assignee: "AK",
      createdAt: new Date("2026-10-12T00:00:00.000Z"),
      ...payload,
    };
    issueItems.unshift(issue);
    return issue;
  }

  static async findByIdAndUpdate(id, payload) {
    const issue = issueItems.find((item) => item._id === id);
    if (issue) Object.assign(issue, payload);
    return issue || null;
  }

  static async findByIdAndDelete(id) {
    const index = issueItems.findIndex((item) => item._id === id);
    if (index < 0) return null;
    return issueItems.splice(index, 1)[0];
  }
}

const issueServer = createServer(createApp({
  pythonCommand: "bugsentry-python-not-installed",
  IssueModel: FakeIssueModel,
  databaseReady: () => true,
}));
let baseUrl;
let issueBaseUrl;

test("uses PYTHON_EXECUTABLE when configured", () => {
  assert.equal(
    resolvePythonExecutable({ PYTHON_EXECUTABLE: "D:\\Python\\python.exe" }, "win32"),
    "D:\\Python\\python.exe",
  );
});

test("uses the verified Python interpreter as the Windows fallback", () => {
  assert.equal(
    resolvePythonExecutable({}, "win32"),
    "C:\\Users\\adith\\AppData\\Local\\Python\\bin\\python.exe",
  );
});

test("uses python3 as the non-Windows fallback", () => {
  assert.equal(resolvePythonExecutable({}, "linux"), "python3");
});

test("uses Windows system DNS servers before connecting to MongoDB", async () => {
  const systemDnsServers = ["system-dns-from-os"];
  const calls = [];
  const dnsResolver = {
    setServers: (servers) => calls.push(["setServers", servers]),
  };
  const originalConnect = mongoose.connect;
  mongoose.connect = async (...args) => {
    calls.push(["connect", ...args]);
    return "connected";
  };

  try {
    assert.equal(await connectDatabase("mongodb://localhost/test", {
      platform: "win32",
      dnsResolver,
      windowsDnsServerProvider: async () => systemDnsServers,
    }), "connected");
    assert.deepEqual(calls, [
      ["setServers", systemDnsServers],
      ["connect", "mongodb://localhost/test", { serverSelectionTimeoutMS: 5_000 }],
    ]);
  } finally {
    mongoose.connect = originalConnect;
  }
});

test("does not replace the Node resolver on non-Windows platforms", async () => {
  let providerCalled = false;
  const originalConnect = mongoose.connect;
  mongoose.connect = async () => "connected";

  try {
    assert.equal(await connectDatabase("mongodb://localhost/test", {
      platform: "linux",
      windowsDnsServerProvider: async () => {
        providerCalled = true;
        return [];
      },
    }), "connected");
    assert.equal(providerCalled, false);
  } finally {
    mongoose.connect = originalConnect;
  }
});

test("MongoDB connection diagnostics distinguish DNS, SRV, auth, TLS, and selection failures", () => {
  const cases = [
    [{ name: "Error", code: "ENOENT", message: "Windows DNS configuration failed" }, "windows-dns-discovery", "Windows DNS server discovery failed."],
    [{ name: "TypeError", code: "ERR_INVALID_IP_ADDRESS", message: "invalid address" }, "dns-set-servers", "Node rejected a discovered DNS server address."],
    [{ name: "Error", message: "querySrv ECONNREFUSED private-host" }, "atlas-srv-lookup", "Atlas SRV DNS lookup was refused."],
    [{ name: "MongoServerError", code: 18, message: "Authentication failed" }, "mongodb-authentication", "MongoDB authentication failed."],
    [{ name: "MongoNetworkError", code: "CERT_HAS_EXPIRED", message: "TLS certificate failure" }, "mongodb-tls", "MongoDB TLS negotiation failed."],
    [{ name: "MongooseServerSelectionError", code: "ETIMEDOUT", message: "server selection timed out" }, "mongodb-server-selection", "MongoDB server selection failed."],
  ];

  for (const [error, expectedStage, expectedMessage] of cases) {
    const stage = expectedStage === "windows-dns-discovery" || expectedStage === "dns-set-servers"
      ? expectedStage
      : classifyMongoConnectionFailure(error);
    const diagnostics = createMongoConnectionDiagnostic(stage, error);
    assert.equal(diagnostics.stage, expectedStage);
    assert.equal(diagnostics.message, expectedMessage);
    assert.equal(Object.keys(diagnostics).sort().join(","), "code,message,name,stage");
    assert.equal(JSON.stringify(diagnostics).includes("private-host"), false);
    assert.equal(JSON.stringify(diagnostics).includes("password"), false);
  }
});

function fakePowerShellSpawn(output, exitCode = 0) {
  return (executable, args, options) => {
    assert.equal(executable, "powershell.exe");
    assert.equal(options.windowsHide, true);
    assert.ok(args.some((arg) => arg.includes("Get-DnsClientServerAddress")));
    assert.equal(args.some((arg) => arg.includes("IPv4,IPv6")), false);

    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.end(output, () => {
        child.stderr.end();
        child.emit("close", exitCode);
      });
    });
    return child;
  };
}

test("Windows DNS discovery parses the system-configured resolver list", async () => {
  const servers = await readWindowsDnsServers(fakePowerShellSpawn('["resolver-from-windows","second-resolver"]'));
  assert.deepEqual(servers, ["resolver-from-windows", "second-resolver"]);
});

test("Windows DNS discovery fails safely when PowerShell cannot return configuration", async () => {
  await assert.rejects(
    readWindowsDnsServers(fakePowerShellSpawn("", 1)),
    (error) => error.code === "WINDOWS_DNS_DISCOVERY_FAILED"
      && error.message === "Windows DNS server discovery failed.",
  );
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  issueServer.listen(0, "127.0.0.1");
  await once(issueServer, "listening");
  issueBaseUrl = `http://127.0.0.1:${issueServer.address().port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  issueServer.close();
  await once(issueServer, "close");
});

beforeEach(() => {
  issueItems.length = 0;
  nextIssueNumber = 1;
  FakeIssueModel.failQueries = false;
});

test("health endpoint reports healthy when MongoDB is connected", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("health endpoint reports unavailable when MongoDB is disconnected", async () => {
  const disconnectedServer = createServer(createApp({ databaseReady: () => false }));
  disconnectedServer.listen(0, "127.0.0.1");
  await once(disconnectedServer, "listening");

  try {
    const response = await fetch(`http://127.0.0.1:${disconnectedServer.address().port}/api/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "unavailable",
      error: "MongoDB is not connected.",
    });
  } finally {
    disconnectedServer.close();
    await once(disconnectedServer, "close");
  }
});

test("analysis rejects a missing code field", async () => {
  const response = await fetch(`${baseUrl}/api/analyze/python`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /code.*string/i);
});

test("analysis rejects a non-string code field", async () => {
  const response = await fetch(`${baseUrl}/api/analyze/python`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: 123 }),
  });
  assert.equal(response.status, 400);
});

test("analysis rejects empty source", async () => {
  const response = await fetch(`${baseUrl}/api/analyze/python`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "  " }),
  });
  assert.equal(response.status, 400);
});

test("analysis reports a clear error when Python cannot be started", async () => {
  const response = await fetch(`${baseUrl}/api/analyze/python`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "value = 1 / 0" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Python 3 is unavailable/);
});

test("issues can be created and listed with validated fields", async () => {
  const response = await fetch(`${issueBaseUrl}/api/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Login failure", description: "Login returns 500", project: "Authentication", severity: "High" }),
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).issue;
  assert.equal(created.title, "Login failure");
  assert.equal(created.status, "Open");
  assert.ok(created.createdAt);

  const listResponse = await fetch(`${issueBaseUrl}/api/issues`);
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).issues.length, 1);
});

test("issue list supports status, severity, and escaped search filters", async () => {
  issueItems.push(
    { _id: issueId, title: "Login issue", project: "Auth", description: "Bad login", severity: "Critical", status: "Open" },
    { _id: "507f1f77bcf86cd799439012", title: "Search issue", project: "Dashboard", description: "Filter results", severity: "Low", status: "Resolved" },
  );
  const response = await fetch(`${issueBaseUrl}/api/issues?status=Open&severity=Critical&search=Login`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).issues.length, 1);

  const literalSearch = await fetch(`${issueBaseUrl}/api/issues?search=.*`);
  assert.equal((await literalSearch.json()).issues.length, 0);
});

test("issue validation rejects missing fields, invalid severity, and invalid status", async () => {
  const missing = await fetch(`${issueBaseUrl}/api/issues`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Missing details" }),
  });
  assert.equal(missing.status, 400);
  const invalidSeverity = await fetch(`${issueBaseUrl}/api/issues`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Issue", description: "Details", project: "Project", severity: "Urgent" }),
  });
  assert.equal(invalidSeverity.status, 400);
  const invalidStatus = await fetch(`${issueBaseUrl}/api/issues/${issueId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "Fixed" }),
  });
  assert.equal(invalidStatus.status, 400);
});

test("issues can be fetched, status-updated, and deleted", async () => {
  issueItems.push({ _id: issueId, title: "A bug", description: "Details", project: "Dashboard", severity: "Medium", status: "Open" });
  const fetched = await fetch(`${issueBaseUrl}/api/issues/${issueId}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).issue.title, "A bug");

  const updated = await fetch(`${issueBaseUrl}/api/issues/${issueId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "Resolved" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).issue.status, "Resolved");

  const deleted = await fetch(`${issueBaseUrl}/api/issues/${issueId}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal(issueItems.length, 0);
});

test("issue endpoints reject invalid IDs and report missing issues", async () => {
  const invalidId = await fetch(`${issueBaseUrl}/api/issues/not-an-id`);
  assert.equal(invalidId.status, 400);
  const missing = await fetch(`${issueBaseUrl}/api/issues/${issueId}`);
  assert.equal(missing.status, 404);
});

test("database failures return safe errors and unavailable storage returns 503", async () => {
  FakeIssueModel.failQueries = true;
  const databaseError = await fetch(`${issueBaseUrl}/api/issues`);
  assert.equal(databaseError.status, 500);
  const body = await databaseError.json();
  assert.equal(body.error, "Could not load issues.");
  assert.equal(JSON.stringify(body).includes("database secret"), false);

  const unavailable = createServer(createApp({ databaseReady: () => false }));
  unavailable.listen(0, "127.0.0.1");
  await once(unavailable, "listening");
  const response = await fetch(`http://127.0.0.1:${unavailable.address().port}/api/issues`);
  assert.equal(response.status, 503);
  unavailable.close();
  await once(unavailable, "close");
});
