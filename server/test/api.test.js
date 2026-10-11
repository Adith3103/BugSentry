import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createApp, resolvePythonExecutable } from "../src/server.js";

const server = createServer(createApp({ pythonCommand: "bugsentry-python-not-installed" }));
let baseUrl;

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

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
});

test("health endpoint reports that the API is available", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
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
