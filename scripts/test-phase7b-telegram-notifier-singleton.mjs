import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const notifier = path.join(here, "run-phase7b-telegram-notifier.mjs");
const workDir = await mkdtemp(path.join(tmpdir(), "phase7b-notifier-singleton-"));
const trendJournal = path.join(workDir, "trend.jsonl");
const sidewayJournal = path.join(workDir, "sideway.jsonl");
const statePath = path.join(workDir, "state.json");
const sinkPath = path.join(workDir, "telegram-dry-run.jsonl");

await Promise.all([
  writeFile(trendJournal, "", "utf8"),
  writeFile(sidewayJournal, "", "utf8"),
  writeFile(sinkPath, "", "utf8"),
]);

const env = {
  ...process.env,
  ZIQ_TELEGRAM_BOT_TOKEN: "singleton-test-token",
  ZIQ_TELEGRAM_CHAT_ID: "singleton-test-chat",
  ZIQ_TELEGRAM_JOURNAL_PATH: trendJournal,
  ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: sidewayJournal,
  ZIQ_TELEGRAM_STATE_PATH: statePath,
  ZIQ_TELEGRAM_INTERVAL_MS: "1000",
  ZIQ_TELEGRAM_SEND_STARTUP: "false",
  ZIQ_TELEGRAM_REPLAY_EXISTING: "false",
  ZIQ_TELEGRAM_SEND_TEST: "false",
  ZIQ_TELEGRAM_ONCE: "false",
  ZIQ_TELEGRAM_DRY_RUN: "true",
  ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath,
  ZIQ_PHASE7C_ACCOUNT_MODE: "LIVE",
};

function startNotifier(label) {
  const child = spawn(process.execPath, [notifier], {
    cwd: path.dirname(here),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  return {
    label,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return await new Promise((resolve) => {
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

async function terminate(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!(await waitForExit(child, 1500))) {
    child.kill("SIGKILL");
    await waitForExit(child, 1500);
  }
}

let first;
let second;
try {
  first = startNotifier("first");
  await waitFor(
    () => first.stdout().includes("PHASE7B_TELEGRAM_NOTIFIER=RUNNING"),
    3000,
    "first notifier to become RUNNING",
  );

  second = startNotifier("second");
  const secondExited = await waitForExit(second.child, 2000);

  assert.equal(
    secondExited,
    true,
    [
      "Singleton contract violated: second notifier remained alive.",
      `firstPid=${first.child.pid}`,
      `secondPid=${second.child.pid}`,
      `secondStdout=${JSON.stringify(second.stdout())}`,
      `secondStderr=${JSON.stringify(second.stderr())}`,
    ].join(" "),
  );

  assert.equal(
    first.child.exitCode,
    null,
    "Singleton owner must remain alive while duplicate startup is rejected.",
  );

  console.log("PHASE7B_TELEGRAM_NOTIFIER_SINGLETON_CONTRACT=PASS");
} finally {
  if (second) await terminate(second.child);
  if (first) await terminate(first.child);
}
