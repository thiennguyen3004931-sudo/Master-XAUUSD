import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const entry = join(projectRoot, "apps", "api", "dist", "index.js");
const host = "127.0.0.1";
const port = 3721;
const healthUrl = `http://${host}:${port}/api/v1/health`;
const timeoutMs = 10000;

function fail(reason, detail = "") {
  console.error("PHASE7B_API_NODE_PRODUCTION_RUNTIME=FAIL");
  console.error(`REASON=${reason}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

function getHealth() {
  return new Promise((resolveHealth) => {
    const req = request(healthUrl, { method: "GET", timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolveHealth(false);
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolveHealth(parsed?.success === true && parsed?.data?.status === "OK");
        } catch {
          resolveHealth(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolveHealth(false);
    });
    req.on("error", () => resolveHealth(false));
    req.end();
  });
}

function waitForExit(milliseconds) {
  if (exited) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), milliseconds);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

const child = spawn(process.execPath, [entry], {
  cwd: projectRoot,
  env: {
    ...process.env,
    HOST: host,
    PORT: String(port),
    NODE_ENV: "test",
    MT5_BRIDGE_ENABLED: "false",
    PHASE7B_LOCAL_CONTROL_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let exited = false;
let exitCode = null;
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.on("exit", (code) => {
  exited = true;
  exitCode = code;
});

const deadline = Date.now() + timeoutMs;
let ready = false;
while (Date.now() < deadline) {
  if (exited) break;
  if (await getHealth()) {
    ready = true;
    break;
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
}

if (!ready) {
  if (!exited) child.kill("SIGTERM");
  const detail = [
    `ENTRY=${entry}`,
    `EXIT_CODE=${exitCode ?? "RUNNING"}`,
    stdout ? `STDOUT:\n${stdout}` : "",
    stderr ? `STDERR:\n${stderr}` : "",
  ].filter(Boolean).join("\n");
  fail(exited ? "PROCESS_EXITED_BEFORE_HEALTH" : "HEALTH_TIMEOUT", detail);
}

child.kill("SIGTERM");
const stoppedGracefully = await waitForExit(2000);
if (!stoppedGracefully) {
  child.kill("SIGKILL");
  await waitForExit(2000);
}

child.stdout.destroy();
child.stderr.destroy();

console.log("PHASE7B_API_NODE_PRODUCTION_RUNTIME=PASS");
console.log("ENTRY=node apps/api/dist/index.js");
console.log("HEALTH=/api/v1/health");
