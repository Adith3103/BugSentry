import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import cors from "cors";
import express from "express";

const analyzerPath = fileURLToPath(new URL("./python_analyzer.py", import.meta.url));
const maxCodeCharacters = 48_000;
const maxOutputBytes = 256_000;
const windowsPythonFallback = "C:\\Users\\adith\\AppData\\Local\\Python\\bin\\python.exe";

export function resolvePythonExecutable(env = process.env, platform = process.platform) {
  return env.PYTHON_EXECUTABLE || (platform === "win32" ? windowsPythonFallback : "python3");
}

function analyzeWithPython(code, { pythonCommand, timeoutMs }) {
  return new Promise((resolveResult) => {
    const child = spawn(pythonCommand, [analyzerPath], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ status: 504, body: { error: "Python analysis timed out." } });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
        child.kill();
        finish({ status: 502, body: { error: "Analyzer returned too much output." } });
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4_000);
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish({
          status: 503,
          body: { error: "Python 3 is unavailable. Install Python or set PYTHON_EXECUTABLE." },
        });
        return;
      }
      finish({ status: 500, body: { error: "Could not start the Python analyzer." } });
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        finish({
          status: 500,
          body: {
            error: "The Python analyzer failed.",
            details: stderr.trim() || `Analyzer exited with code ${exitCode}.`,
          },
        });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.diagnostics)) throw new Error("Missing diagnostics.");
        finish({ status: 200, body: result });
      } catch {
        finish({ status: 502, body: { error: "The Python analyzer returned invalid output." } });
      }
    });

    child.stdin.on("error", () => {
      // The close handler reports a useful error if the analyzer cannot read input.
    });
    child.stdin.end(JSON.stringify({ code }));
  });
}

export function createApp({
  pythonCommand = resolvePythonExecutable(),
  timeoutMs = 3_000,
} = {}) {
  const app = express();

  app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/api/analyze/python", async (request, response) => {
    const code = request.body?.code;
    if (typeof code !== "string") {
      response.status(400).json({ error: 'Request body must include a "code" string.' });
      return;
    }
    if (!code.trim()) {
      response.status(400).json({ error: 'The "code" string cannot be empty.' });
      return;
    }
    if (code.length > maxCodeCharacters) {
      response.status(413).json({ error: `Code must be ${maxCodeCharacters} characters or fewer.` });
      return;
    }

    const result = await analyzeWithPython(code, { pythonCommand, timeoutMs });
    response.status(result.status).json(result.body);
  });

  app.use((error, _request, response, _next) => {
    if (error.type === "entity.too.large") {
      response.status(413).json({ error: "Request body is too large." });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    response.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}

export const app = createApp();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5000;
  app.listen(port, () => {
    process.stdout.write(`BugSentry API listening on port ${port}\n`);
  });
}
