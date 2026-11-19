import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const controllerPath = path.join(root, "scripts", "run-phase7b-demo-controller.ts");
const telegramPath = path.join(root, "scripts", "run-phase7b-telegram-notifier-compact.mjs");
const v8Path = path.join(root, "scripts", "apply-phase7b-daily-recovery-ui-v8-local.mjs");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function run(cmd, args, label, capture = false) {
  const executable = process.platform === "win32" && cmd === "pnpm" ? "pnpm.cmd" : cmd;
  const result = spawnSync(executable, args, {
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

function replaceRequired(text, from, to, name) {
  if (!text.includes(from)) throw new Error(`${name} marker not found.`);
  return text.replace(from, to);
}

// Bootstrap the V8 daily-recovery patch when V7 previously failed at parse time.
let controller = read(controllerPath);
if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) {
  if (!fs.existsSync(v8Path)) {
    const remote = run(
      "git",
      ["show", "origin/phase4-risk-entry-compression:scripts/apply-phase7b-daily-recovery-ui-v8-local.mjs"],
      "Fetch V8 helper",
      true,
    );
    fs.writeFileSync(v8Path, remote.replace(/\r?\n/g, "\n"), "utf8");
  }
  run("node", [v8Path], "Apply V8 daily recovery");
  controller = read(controllerPath);
}

if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) throw new Error("Daily recovery V8 is missing.");
if (!controller.includes("THREE_CANDLE_BODY_DOMINANCE")) throw new Error("Three-candle V6 rule is missing.");

// ---------------------------------------------------------------------------
// Controller: calculate the exact recovery target when the position is filled.
// ---------------------------------------------------------------------------
if (!controller.includes("const entryRecoveryTargetPrice =")) {
  const marker = "  state.managed = {";
  const block = [
    "  let entryDailyManagement: DailyManagementSnapshot | null = null;",
    "  try {",
    "    entryDailyManagement = await getDailyManagementSnapshot(opened, spec);",
    "  } catch (error) {",
    '    journal("DAY_RECOVERY_ENTRY_DATA_UNAVAILABLE", { signalId: signal.id, message: errorMessage(error) });',
    "  }",
    '  const entryRecoveryTargetMove = entryDailyManagement?.mode === "RECOVERY"',
    "    ? entryDailyManagement.targetMove",
    "    : null;",
    "  const entryRecoveryTargetPrice = entryRecoveryTargetMove === null",
    "    ? null",
    "    : roundPrice(",
    '        signal.side === "BUY"',
    "          ? opened.entry + entryRecoveryTargetMove",
    "          : opened.entry - entryRecoveryTargetMove,",
    "        spec.digits,",
    "      );",
    "",
  ].join("\n");
  controller = replaceRequired(controller, marker, block + marker, "ENTRY recovery target");
}

if (!controller.includes("recoveryTargetPrice: entryRecoveryTargetPrice")) {
  const marker = "    position: opened,";
  const fields = [
    "    dailyManagementMode: entryDailyManagement?.mode ?? null,",
    "    dailyRealizedPnlBefore: entryDailyManagement?.realizedPnl ?? null,",
    "    recoveryTargetMove: entryRecoveryTargetMove,",
    "    recoveryTargetPrice: entryRecoveryTargetPrice,",
    "    recoveryCanTurnPositiveWithinTen: entryDailyManagement?.canTurnPositiveWithinTen ?? null,",
  ].join("\n") + "\n";
  controller = replaceRequired(controller, marker, fields + marker, "ENTRY_FILLED recovery fields");
}

if (!controller.includes("exitPriceBeforeClose: exitPrice")) {
  const marker = "          positionProfitBeforeClose: position.profit,";
  controller = replaceRequired(
    controller,
    marker,
    marker + "\n          exitPriceBeforeClose: exitPrice,",
    "Recovery exit fallback price",
  );
}

// Add favorable/PnL fallback data to canonical close events too.
const oldCloseSignature = "async function closeAll(position: Position, reason: string, m15CloseTime: number): Promise<void>";
if (controller.includes(oldCloseSignature)) {
  controller = controller.replace(
    oldCloseSignature,
    "async function closeAll(position: Position, reason: string, m15CloseTime: number, favorable: number): Promise<void>",
  );
  controller = controller.replace(
    /await closeAll\(position, ([^,]+), latest\.closeTime\);/g,
    "await closeAll(position, $1, latest.closeTime, favorable);",
  );
}

const oldExitJournal = '  journal("EXIT_EXECUTED", { ticket: managed.ticket, reason, volume: position.volume, response });';
if (controller.includes(oldExitJournal)) {
  controller = controller.replace(
    oldExitJournal,
    '  journal("EXIT_EXECUTED", { ticket: managed.ticket, side: managed.side, reason, volume: position.volume, entry: position.entry, favorable, positionProfitBeforeClose: position.profit, response });',
  );
}

write(controllerPath, controller);
console.log("PHASE7B_RECOVERY_V10_CONTROLLER=PASS");
console.log("PHASE7B_RECOVERY_V10_ENTRY_TARGET=EXACT_RECOVERY_PRICE");
console.log("PHASE7B_RECOVERY_V10_CLOSE_FALLBACK=FAVORABLE_PLUS_POSITION_PNL");

// ---------------------------------------------------------------------------
// Telegram: actual SL + exact recovery TP, then concise close move + USD.
// ---------------------------------------------------------------------------
let telegram = read(telegramPath);

const oldRecoveryVars = [
  '    const recoveryDay = enrichment.live?.dailyManagement?.mode === "RECOVERY";',
  "    const dailyPnl = numberOrNull(enrichment.live?.dailyManagement?.realizedPnl);",
].join("\n");
if (telegram.includes(oldRecoveryVars) && !telegram.includes("const recoveryTargetMove = numberOrNull(event.recoveryTargetMove);")) {
  telegram = telegram.replace(
    oldRecoveryVars,
    [
      '    const recoveryDay = event.dailyManagementMode === "RECOVERY" || enrichment.live?.dailyManagement?.mode === "RECOVERY";',
      "    const dailyPnl = numberOrNull(event.dailyRealizedPnlBefore ?? enrichment.live?.dailyManagement?.realizedPnl);",
      "    const recoveryTargetMove = numberOrNull(event.recoveryTargetMove);",
      "    const recoveryTargetPrice = numberOrNull(event.recoveryTargetPrice);",
    ].join("\n"),
  );
}

const genericRecoveryTp = '      recoveryDay ? `🎯 Hồi phục ngày: <b>chốt toàn bộ trong +6 → +10 giá</b>` : `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,';
if (telegram.includes(genericRecoveryTp)) {
  telegram = telegram.replace(
    genericRecoveryTp,
    '      recoveryDay ? `🎯 TP hồi phục: <b>${fmtPrice(recoveryTargetPrice)}</b>${recoveryTargetMove === null ? " · chốt toàn bộ trong +6 → +10 giá" : ` · +${recoveryTargetMove.toFixed(2)} giá · chốt TOÀN BỘ`}` : `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,',
  );
}

const closeRegex = /  if \(type === "EXIT_EXECUTED" \|\| type === "MANAGED_POSITION_CLOSED"\) \{[\s\S]*?\n  \}\n\n  if \(type === "ENTRY_REJECTED"/;
if (closeRegex.test(telegram) && !telegram.includes("closed?.netPnl ?? event.positionProfitBeforeClose")) {
  const replacement = [
    '  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {',
    "    const closed = enrichment.closedTrade;",
    "    const side = normalizeSide(closed?.side ?? state.trade?.side ?? event.side);",
    "    const pnl = numberOrNull(closed?.netPnl ?? event.positionProfitBeforeClose);",
    "    const move = closed",
    "      ? sidePriceMove(side, Number(closed.entry), Number(closed.exit))",
    "      : numberOrNull(event.favorable);",
    '    const reason = type === "EXIT_EXECUTED" ? event.reason : "MT5 / SL đóng position";',
    '    const action = pnl !== null && pnl < 0 ? "ĐÓNG LỆNH" : "CHỐT LỜI";',
    '    return compactMessage(pnl !== null && pnl < 0 ? "🛑" : "🏁", side, action, [',
    '      `Chốt ${fmtMove(move)} giá · ${pnl !== null && pnl < 0 ? "lỗ" : "lãi"} ${fmtMoney(pnl, true)}.`,',
    '      `Lý do: ${reasonLabel(reason)}.`,',
    "    ]);",
    "  }",
    "",
    '  if (type === "ENTRY_REJECTED"',
  ].join("\n");
  telegram = telegram.replace(closeRegex, replacement);
}

// Wait longer for MT5/performance to expose the final deal before falling back.
telegram = telegram.replace(
  "  for (let attempt = 0; attempt < 4; attempt += 1) {",
  "  for (let attempt = 0; attempt < 15; attempt += 1) {",
);
telegram = telegram.replace(
  "    if (attempt < 3) await sleep(650);",
  "    if (attempt < 14) await sleep(1000);",
);

telegram = telegram.replace(
  'if (v === "DAY_RECOVERY_6_TO_10") return "chốt hồi phục ngày trong vùng +6 đến +10 giá";',
  'if (v === "DAY_RECOVERY_6_TO_10") return "TP hồi phục ngày";',
);
if (!telegram.includes('if (v === "DAY_RECOVERY_6_TO_10")')) {
  const marker = '  if (v === "REVERSAL_FVG_REJECTION") return "điều kiện thoát canonical";';
  telegram = replaceRequired(
    telegram,
    marker,
    '  if (v === "DAY_RECOVERY_6_TO_10") return "TP hồi phục ngày";\n' + marker,
    "Recovery reason label",
  );
}

write(telegramPath, telegram);
run("node", ["--check", telegramPath], "Telegram syntax check");
console.log("PHASE7B_RECOVERY_V10_TELEGRAM=PASS");
console.log("PHASE7B_RECOVERY_V10_RECOVERY_ENTRY=ACTUAL_SL_AND_EXACT_RECOVERY_TP");
console.log("PHASE7B_RECOVERY_V10_CLOSE_MESSAGE=CHOT_PRICE_MOVE_AND_USD");
console.log("PHASE7B_RECOVERY_V10_HISTORY_WAIT_SECONDS=15");

run("pnpm", ["--filter", "@xauusd/api", "build"], "API build");
console.log("PHASE7B_RECOVERY_V10_API_BUILD=PASS");
run("pnpm", ["--filter", "@xauusd/web", "build"], "Web build");
console.log("PHASE7B_RECOVERY_V10_WEB_BUILD=PASS");

console.log("PHASE7B_RECOVERY_V10_BOT_RESTARTED=False");
console.log("PHASE7B_RECOVERY_V10_TELEGRAM_RESTARTED=False");
console.log("PHASE7B_RECOVERY_V10_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_RECOVERY_V10=PASS");
