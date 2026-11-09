import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const opsPath = path.join(root, "apps", "api", "src", "routes", "phase7b-ops.route.ts");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}
function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

let source = read(opsPath).replace(/\r\n/g, "\n");

const oldTelegramStop = `    await endScheduledTaskIfExists(TELEGRAM_TASK);
    const pids = new Set<number>();
    if (Number.isInteger(runtime?.pid) && (runtime?.pid ?? 0) > 0) pids.add(runtime!.pid!);
    if (Number.isInteger(runtime?.wrapperPid) && (runtime?.wrapperPid ?? 0) > 0) pids.add(runtime!.wrapperPid!);
    for (const pid of pids) {
      if (isPidAlive(pid)) await killProcessTree(pid);
    }
    markTelegramStopped(runtimePath, runtime);`;

const newTelegramStop = `    await endScheduledTaskIfExists(TELEGRAM_TASK);
    // Never kill arbitrary/stale wrapper PIDs. Windows can recycle PIDs after a
    // notifier exits, and an old wrapperPid may then belong to the API or another
    // unrelated process. Only terminate the notifier PID when runtime status,
    // heartbeat freshness, and PID liveness all agree that Telegram is alive.
    const telegramStatus = getTelegramRuntimeStatus(runtime);
    if (telegramStatus.alive && Number.isInteger(runtime?.pid) && (runtime?.pid ?? 0) > 0) {
      await killProcessTree(runtime!.pid!);
    }
    markTelegramStopped(runtimePath, runtime);`;

if (source.includes(oldTelegramStop)) {
  source = source.replace(oldTelegramStop, newTelegramStop);
}
if (!source.includes("Never kill arbitrary/stale wrapper PIDs")) {
  throw new Error("Telegram stop safety marker not found/applied.");
}

const oldBotKill = `    await endScheduledTaskIfExists(BOT_TASK);
    if (isPidAlive(runtime?.pid)) await killProcessTree(runtime!.pid!);
    markBotStopped(runtimePath, runtime);`;
const newBotKill = `    await endScheduledTaskIfExists(BOT_TASK);
    const botHeartbeatAge = runtime?.heartbeatAt ? Math.max(0, Date.now() - Number(runtime.heartbeatAt)) : Number.POSITIVE_INFINITY;
    const botRuntimeAlive = Boolean(
      runtime?.status === "RUNNING" &&
      runtime?.armed === true &&
      botHeartbeatAge <= 10_000 &&
      isPidAlive(runtime?.pid)
    );
    if (botRuntimeAlive) await killProcessTree(runtime!.pid!);
    markBotStopped(runtimePath, runtime);`;
if (source.includes(oldBotKill)) {
  source = source.replace(oldBotKill, newBotKill);
}
if (!source.includes("const botRuntimeAlive = Boolean(")) {
  throw new Error("Bot stop safety marker not found/applied.");
}

write(opsPath, source);
console.log("PHASE7B_V16_TELEGRAM_STOP_STALE_PID_GUARD=PASS");
console.log("PHASE7B_V16_TELEGRAM_WRAPPER_PID_KILL=False");
console.log("PHASE7B_V16_BOT_STOP_HEARTBEAT_GUARD=PASS");
console.log("PHASE7B_V16_API_RESTART_REQUIRED=True");
console.log("PHASE7B_V16_BOT_RESTART_REQUIRED=False");
console.log("PHASE7B_V16=PASS");
