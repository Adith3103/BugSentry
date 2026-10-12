
import { isIP } from "node:net";
import mongoose from "mongoose";
import { spawn } from "node:child_process";
import * as dns from "node:dns";

const windowsDnsServerCommand =
  "Get-DnsClientServerAddress | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique | ConvertTo-Json -Compress";

function createWindowsDnsDiscoveryError(code) {
  const error = new Error("Windows DNS server discovery failed.");
  error.code = code;
  return error;
}

function collectMongoErrorDetails(error) {
  const pending = [error];
  const visited = new Set();
  const messages = [];
  let code = null;
  let isSrvLookup = false;

  while (pending.length > 0) {
    const current = pending.shift();

    if (
      !current ||
      typeof current !== "object" ||
      visited.has(current)
    ) {
      continue;
    }

    visited.add(current);

    if (
      !code &&
      typeof current.code === "string" &&
      /^[A-Z0-9_]{1,64}$/.test(current.code)
    ) {
      code = current.code;
    }

    if (
      typeof current.syscall === "string" &&
      /querysrv/i.test(current.syscall)
    ) {
      isSrvLookup = true;
    }

    if (typeof current.message === "string") {
      messages.push(current.message);

      if (/querysrv/i.test(current.message)) {
        isSrvLookup = true;
      }

      if (!code) {
        const match = current.message.match(
          /\b(ECONNREFUSED|ETIMEDOUT|ETIMEOUT|ENOTFOUND|EAI_AGAIN|ESERVFAIL|ERR_INVALID_IP_ADDRESS|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|AuthenticationFailed)\b/
        );

        if (match) {
          code = match[1];
        }
      }
    }

    if (
      !code &&
      typeof current.code === "number" &&
      Number.isInteger(current.code)
    ) {
      code = String(current.code);
    }

    pending.push(current.cause, current.reason);

    if (Array.isArray(current.errors)) {
      pending.push(...current.errors);
    }

    const servers = current.reason?.servers;

    if (servers && typeof servers.values === "function") {
      pending.push(...servers.values());
    }
  }

  const name =
    typeof error?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
      ? error.name
      : "Error";

  return {
    name,
    code,
    isSrvLookup,
    message: messages.join(" "),
  };
}

export function classifyMongoConnectionFailure(error) {
  const details = collectMongoErrorDetails(error);
  const text = `${details.name} ${details.message}`;

  if (details.isSrvLookup || /querysrv/i.test(text)) {
    return "atlas-srv-lookup";
  }

  if (
    /authenticationfailed|authentication failed|auth failed|scram/i.test(
      text
    ) ||
    details.code === "18"
  ) {
    return "mongodb-authentication";
  }

  if (
    /tls|ssl|certificate/i.test(text) ||
    [
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN",
    ].includes(details.code)
  ) {
    return "mongodb-tls";
  }

  if (
    /server.?selection|MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError/i.test(
      text
    ) ||
    ["ECONNREFUSED", "ETIMEDOUT", "ETIMEOUT"].includes(details.code)
  ) {
    return "mongodb-server-selection";
  }

  return "mongodb-connection";
}

export function createMongoConnectionDiagnostic(stage, error) {
  const details = collectMongoErrorDetails(error);
  let message = "MongoDB connection failed.";

  if (stage === "windows-dns-discovery") {
    message = "Windows DNS server discovery failed.";
  } else if (stage === "dns-set-servers") {
    message = "Node rejected a discovered DNS server address.";
  } else if (stage === "atlas-srv-lookup") {
    message =
      details.code === "ECONNREFUSED"
        ? "Atlas SRV DNS lookup was refused."
        : "Atlas SRV DNS lookup failed.";
  } else if (stage === "mongodb-authentication") {
    message = "MongoDB authentication failed.";
  } else if (stage === "mongodb-tls") {
    message = "MongoDB TLS negotiation failed.";
  } else if (stage === "mongodb-server-selection") {
    message = "MongoDB server selection failed.";
  }

  return {
    stage,
    name: details.name,
    code: details.code,
    message,
  };
}

function logMongoConnectionFailure(stage, error) {
  console.error(createMongoConnectionDiagnostic(stage, error));
}

export function readWindowsDnsServers(spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawnProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsDnsServerCommand,
        ],
        { windowsHide: true, shell: false }
      );
    } catch {
      reject(
        createWindowsDnsDiscoveryError(
          "WINDOWS_DNS_DISCOVERY_START_FAILED"
        )
      );
      return;
    }

    let output = "";
    let settled = false;
    let timer;

    const finish = (error, value) => {
      if (settled) return;

      settled = true;

      if (timer) clearTimeout(timer);

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    timer = setTimeout(() => {
      child.kill();
      finish(
        createWindowsDnsDiscoveryError(
          "WINDOWS_DNS_DISCOVERY_TIMEOUT"
        )
      );
    }, 5000);

    child.stdout.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      output += chunk;

      if (Buffer.byteLength(output, "utf8") > 16384) {
        child.kill();

        finish(
          createWindowsDnsDiscoveryError(
            "WINDOWS_DNS_DISCOVERY_OUTPUT_TOO_LARGE"
          )
        );
      }
    });

    child.stderr.on("data", () => {});

    child.once("error", () => {
      finish(
        createWindowsDnsDiscoveryError(
          "WINDOWS_DNS_DISCOVERY_FAILED"
        )
      );
    });

    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          createWindowsDnsDiscoveryError(
            "WINDOWS_DNS_DISCOVERY_FAILED"
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(output.trim());
        const candidates = Array.isArray(parsed)
          ? parsed
          : [parsed];

        const servers = candidates
          .filter(
            (server) =>
              typeof server === "string" && server.trim()
          )
          .map((server) => server.trim());

        if (servers.length === 0) {
          finish(
            createWindowsDnsDiscoveryError(
              "WINDOWS_DNS_SERVERS_NOT_FOUND"
            )
          );
          return;
        }

        finish(null, [...new Set(servers)]);
      } catch {
        finish(
          createWindowsDnsDiscoveryError(
            "WINDOWS_DNS_DISCOVERY_INVALID_OUTPUT"
          )
        );
      }
    });
  });
}

export async function connectDatabase(
  uri = process.env.MONGODB_URI,
  {
    platform = process.platform,
    dnsResolver = dns,
    windowsDnsServerProvider = readWindowsDnsServers,
  } = {}
) {
  if (typeof uri !== "string" || !uri.trim()) {
    throw new Error(
      "MONGODB_URI is required to connect to the issue database."
    );
  }

  if (platform === "win32") {
    let systemDnsServers;

    try {
      systemDnsServers = await windowsDnsServerProvider();
    } catch (error) {
      logMongoConnectionFailure(
        "windows-dns-discovery",
        error
      );
      throw error;
    }

    try {
      const ipv4DnsServers = systemDnsServers.filter(
        (server) => isIP(server) === 4
      );

      const dnsServersToUse =
        ipv4DnsServers.length > 0
          ? ipv4DnsServers
          : systemDnsServers;

      dnsResolver.setServers(dnsServersToUse);
    } catch (error) {
      logMongoConnectionFailure("dns-set-servers", error);
      throw error;
    }
  }

  try {
    return await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
  } catch (error) {
    logMongoConnectionFailure(
      classifyMongoConnectionFailure(error),
      error
    );

    throw error;
  }
}

export function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}
