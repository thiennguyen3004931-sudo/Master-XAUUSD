import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const controllerPath = path.join(root, "scripts", "run-phase7b-demo-controller.ts");
const wrapperPath = path.join(root, "scripts", "run-phase7b-telegram-notifier-local.ps1");
const compactPath = path.join(root, "scripts", "run-phase7b-telegram-notifier-compact.mjs");
const v13Path = path.join(root, "scripts", "repair-phase7b-clamp-telegram-v13-local.mjs");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}
function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}
function run(cmd, args, label, capture = false) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${label} failed: ${result.status}${detail}`);
  }
  return capture ? String(result.stdout ?? "") : "";
}

// Bootstrap V13 if the local checkout has not received it yet.
let controller = read(controllerPath);
let wrapper = read(wrapperPath);
let compact = read(compactPath);
const needV13 =
  controller.includes("clamp(rawRequiredMove, DAY_RECOVERY_MIN_MOVE, DAY_RECOVERY_MAX_MOVE)") ||
  !wrapper.includes('run-phase7b-telegram-notifier-compact.mjs') ||
  !compact.includes("PHASE7B_TELEGRAM_OPEN_POSITION_SYNC");

if (needV13) {
  if (!fs.existsSync(v13Path)) {
    const remote = run(
      "git",
      ["show", "origin/phase4-risk-entry-compression:scripts/repair-phase7b-clamp-telegram-v13-local.mjs"],
      "Fetch V13 helper",
      true,
    );
    fs.writeFileSync(v13Path, remote.replace(/\r?\n/g, "\n"), "utf8");
  }
  run(process.execPath, [v13Path], "Apply V13 bootstrap");
  controller = read(controllerPath);
  wrapper = read(wrapperPath);
  compact = read(compactPath);
}

// A. Daily recovery clamp must be safe before Bot is restarted.
const brokenClamp = "  const targetMove = clamp(rawRequiredMove, DAY_RECOVERY_MIN_MOVE, DAY_RECOVERY_MAX_MOVE);";
const safeClamp = "  const targetMove = Math.min(DAY_RECOVERY_MAX_MOVE, Math.max(DAY_RECOVERY_MIN_MOVE, rawRequiredMove));";
if (controller.includes(brokenClamp)) controller = controller.replace(brokenClamp, safeClamp);
if (!controller.includes(safeClamp)) throw new Error("Safe daily recovery clamp is missing.");
write(controllerPath, controller);
console.log("PHASE7B_V14_DAILY_RECOVERY_CLAMP=PASS");

// B. Wrapper must always use the current compact notifier.
wrapper = wrapper.replace(
  '$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier.mjs"',
  '$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-compact.mjs"',
);
if (!wrapper.includes('$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-compact.mjs"')) {
  throw new Error("Telegram wrapper is not using compact notifier.");
}
write(wrapperPath, wrapper);
console.log("PHASE7B_V14_TELEGRAM_WRAPPER=COMPACT");

// C. Never suppress broker/SL close solely because Telegram started after entry.
compact = compact.replace(
  '  if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;\n\n',
  "",
);
compact = compact.replace(
  '  if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;\r\n\r\n',
  "",
);
if (compact.includes('if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;')) {
  throw new Error("Managed-position close suppression is still present.");
}

// D. When syncing an already-open position, seed notifier trade state so a later
// broker SL close has entry/side/ticket context even if ENTRY_FILLED was missed.
if (!compact.includes("PHASE7B_TELEGRAM_SYNC_TRADE_STATE=SEEDED")) {
  const marker = "  const volume = numberOrNull(position.volume ?? managed.expectedRemainingVolume);";
  if (!compact.includes(marker)) throw new Error("Open-position sync volume marker missing.");
  const seed = [
    marker,
    "  state.trade = {",
    "    ticket,",
    "    side,",
    "    entry,",
    "    initialVolume: volume,",
    "    remainingVolume: volume,",
    "    stopLoss: sl,",
    "    openedAt: Date.now(),",
    "    realizedPnlEstimate: 0,",
    "  };",
    "  saveState();",
    '  console.log(`PHASE7B_TELEGRAM_SYNC_TRADE_STATE=SEEDED TICKET=${ticket}`);',
  ].join("\n");
  compact = compact.replace(marker, seed);
}

// E. Close formatter must also use event.lastKnownState when notifier state is empty.
compact = compact.replace(
  "    const side = normalizeSide(closed?.side ?? state.trade?.side ?? event.side);",
  "    const lastKnown = event.lastKnownState ?? {};\n    const side = normalizeSide(closed?.side ?? state.trade?.side ?? lastKnown.side ?? event.side);",
);

// F. If Telegram starts after the position has already closed, replay only the
// latest missed close once, based on state.lastEventAt. No MT5 write permission.
if (!compact.includes("PHASE7B_TELEGRAM_MISSED_CLOSE_SYNC=PASS")) {
  const noPositionBlock = [
    "  if (!managed || !position) {",
    '    console.log("PHASE7B_TELEGRAM_OPEN_POSITION_SYNC=NONE");',
    "    return;",
    "  }",
  ].join("\n");
  if (!compact.includes(noPositionBlock)) throw new Error("Open-position NONE block missing.");
  compact = compact.replace(
    noPositionBlock,
    [
      "  if (!managed || !position) {",
      "    await sendLatestMissedCloseSnapshot(snapshot);",
      '    console.log("PHASE7B_TELEGRAM_OPEN_POSITION_SYNC=NONE");',
      "    return;",
      "  }",
    ].join("\n"),
  );

  const functionMarker = "async function sendTestSequence() {";
  if (!compact.includes(functionMarker)) throw new Error("Notifier function insertion marker missing.");
  const fn = `async function sendLatestMissedCloseSnapshot(snapshot) {
  const recent = Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : [];
  const closeEvent = recent.find((event) => {
    const type = String(event?.type ?? "");
    return type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED";
  }) ?? null;
  if (!closeEvent) {
    console.log("PHASE7B_TELEGRAM_MISSED_CLOSE_SYNC=NONE");
    return;
  }

  const closeAtText = String(closeEvent.timestamp ?? "");
  const closeAt = Date.parse(closeAtText);
  const lastSentAt = state.lastEventAt ? Date.parse(String(state.lastEventAt)) : NaN;
  if (Number.isFinite(closeAt) && Number.isFinite(lastSentAt) && lastSentAt >= closeAt) {
    console.log("PHASE7B_TELEGRAM_MISSED_CLOSE_SYNC=ALREADY_SENT");
    return;
  }

  const enrichment = await buildEnrichment(closeEvent);
  const html = await formatEvent(closeEvent, enrichment);
  if (!html) {
    console.log("PHASE7B_TELEGRAM_MISSED_CLOSE_SYNC=NO_MESSAGE");
    return;
  }
  await sendHtml(html);
  state.sent = Number(state.sent ?? 0) + 1;
  state.lastEventAt = closeAtText || new Date().toISOString();
  state.trade = null;
  saveState();
  console.log(\`PHASE7B_TELEGRAM_MISSED_CLOSE_SYNC=PASS TICKET=\${String(closeEvent.ticket ?? closeEvent.lastKnownState?.ticket ?? "UNKNOWN")}\`);
}

`;
  compact = compact.replace(functionMarker, fn + functionMarker);
}

write(compactPath, compact);
run(process.execPath, ["--check", compactPath], "Compact notifier syntax check");
console.log("PHASE7B_V14_TELEGRAM_CLOSE_SUPPRESSION=False");
console.log("PHASE7B_V14_TELEGRAM_CLOSE_FALLBACK=LAST_KNOWN_STATE_PLUS_MT5_HISTORY");
console.log("PHASE7B_V14_TELEGRAM_MISSED_CLOSE_REPLAY=PASS");
console.log("PHASE7B_V14_TELEGRAM_ORDER_PERMISSION=READ_ONLY");
console.log("PHASE7B_V14_BOT_RESTART_REQUIRED=True");
console.log("PHASE7B_V14_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V14=PASS");
