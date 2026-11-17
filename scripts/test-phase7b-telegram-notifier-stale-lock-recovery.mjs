import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const notifier = path.join(here, "run-phase7b-telegram-notifier.mjs");
const workDir = await mkdtemp(path.join(tmpdir(), "phase7b-notifier-stale-lock-"));
const trendJournal = path.join(workDir, "trend.jsonl");
const sidewayJournal = path.join(workDir, "sideway.jsonl");
const statePath = path.join(workDir, "state.json");
const lockPath = `${statePath}.lock`;
const sinkPath = path.join(workDir, "telegram-dry-run.jsonl");

await Promise.all([
  writeFile(trendJournal, "", "utf8"),
  writeFile(sidewayJournal, "", "utf8"),
  writeFile(sinkPath, "", "utf8"),
  writeFile(lockPath, "2147483647\n", "utf8"),
]);

const env = {
  ...process.env,
  ZIQ_TELEGRAM_BOT_TOKEN: "stale-lock-test-token",
  ZIQ_TELEGRAM_CHAT_ID: "stale-lock-test-chat",
  ZIQ_TELEGRAM_JOURNAL_PATH: trendJournal,
  ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: sidewayJournal,
  ZIQ_TELEGRAM_STATE_PATH: statePath,
  ZIQ_TELEGRAM_INTERVAL_MS: "1000",
  ZIQ_TELEGRAM_SEND_STARTUP: "false",
  ZIQ_TELEGRAM_REPLAY_EXISTING: "false",
  ZIQ_TELEGRAM_DRY_RUN: "true",
  ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath,
  ZIQ_TELEGRAM_SEND_TEST: "false",
  ZIQ_TELEGRAM_ONCE: "false",
  ZIQ_PHASE7C_ACCOUNT_MODE: "LIVE",
};

const child = spawn(process.execPath, [notifier], {
  cwd: path.dirname(here),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

function waitForExit(timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function waitForRunning(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.includes("PHASE7B_TELEGRAM_NOTIFIER=RUNNING")) return true;
    if (child.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function terminate() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!(await waitForExit(1500))) {
    child.kill("SIGKILL");
    await waitForExit(1500);
  }
}

try {
  const running = await waitForRunning(3000);

  assert.equal(
    running,
    true,
    [
      "Stale singleton lock must be reclaimed when its PID is not alive.",
      `exitCode=${child.exitCode}`,
      `stdout=${JSON.stringify(stdout)}`,
      `stderr=${JSON.stringify(stderr)}`,
    ].join(" "),
  );

  assert.equal(
    child.exitCode,
    null,
    "Notifier must remain alive after reclaiming a stale singleton lock.",
  );

  console.log("PHASE7B_TELEGRAM_NOTIFIER_STALE_LOCK_RECOVERY_CONTRACT=PASS");
} finally {
  await terminate();
}
