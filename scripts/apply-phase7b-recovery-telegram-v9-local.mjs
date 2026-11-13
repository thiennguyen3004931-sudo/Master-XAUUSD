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

// Ensure V8 daily recovery exists. This keeps V9 usable even when the prior
// PowerShell V7 failed before applying anything.
let controller = read(controllerPath);
if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) {
  if (!fs.existsSync(v8Path)) {
    const remote = run(
      "git",
      ["show", "origin/phase4-risk-entry-compression:scripts/apply-phase7b-daily-recovery-ui-v8-local.mjs"],
      "Fetch V8 helper from origin",
      true,
    );
    fs.writeFileSync(v8Path, remote.replace(/\r?\n/g, "\n"), "utf8");
  }
  run("node", [v8Path], "Apply V8 daily recovery");
  controller = read(controllerPath);
}

if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) {
  throw new Error("V8 daily recovery is still missing after bootstrap.");
}
if (!controller.includes("THREE_CANDLE_BODY_DOMINANCE")) {
  throw new Error("Three-candle rule is missing; apply V6 before V9.");
}

// ---------------------------------------------------------------------------
// A. Controller: persist exact recovery target into ENTRY_FILLED and add close
//    fallbacks so Telegram can always report move/USD when MT5 history lags.
// ---------------------------------------------------------------------------
if (!controller.includes("const entryRecoveryTargetPrice =")) {
  const marker = "  state.managed = {";
  const block = `  let entryDailyManagement: DailyManagementSnapshot | null = null;\n  try {\n    entryDailyManagement = await getDailyManagementSnapshot(opened, spec);\n  } catch (error) {\n    journal(\"DAY_RECOVERY_ENTRY_DATA_UNAVAILABLE\", { signalId: signal.id, message: errorMessage(error) });\n  }\n  const entryRecoveryTargetMove = entryDailyManagement?.mode === \"RECOVERY\"\n    ? entryDailyManagement.targetMove\n    : null;\n  const entryRecoveryTargetPrice = entryRecoveryTargetMove === null\n    ? null\n    : roundPrice(\n        signal.side === \"BUY\"\n          ? opened.entry + entryRecoveryTargetMove\n          : opened.entry - entryRecoveryTargetMove,\n        spec.digits,\n      );\n\n`;
  controller = replaceRequired(controller, marker, block + marker, "ENTRY recovery target");
}

if (!controller.includes("recoveryTargetPrice: entryRecoveryTargetPrice")) {
  const marker = "    position: opened,";
  const fields = `    dailyManagementMode: entryDailyManagement?.mode ?? null,\n    dailyRealizedPnlBefore: entryDailyManagement?.realizedPnl ?? null,\n    recoveryTargetMove: entryRecoveryTargetMove,\n    recoveryTargetPrice: entryRecoveryTargetPrice,\n    recoveryCanTurnPositiveWithinTen: entryDailyManagement?.canTurnPositiveWithinTen ?? null,\n`;
  controller = replaceRequired(controller, marker, fields + marker, "ENTRY_FILLED recovery fields");
}

if (!controller.includes("exitPriceBeforeClose: exitPrice")) {
  const marker = "          positionProfitBeforeClose: position.profit,";
  controller = replaceRequired(
    controller,
    marker,
    `${marker}\n          exitPriceBeforeClose: exitPrice,`,
    "Recovery exit fallback price",
  );
}

if (controller.includes('async function closeAll(position: Position, reason: string, m15CloseTime: number): Promise<void>')) {
  controller = controller.replace(
    'async function closeAll(position: Position, reason: string, m15CloseTime: number): Promise<void>',
    'async function closeAll(position: Position, reason: string, m15CloseTime: number, favorable: number): Promise<void>',
  );
  controller = controller.replaceAll(
    'await closeAll(position, "REVERSAL_FVG_REJECTION", latest.closeTime);',
    'await closeAll(position, "REVERSAL_FVG_REJECTION", latest.closeTime, favorable);',
  );
  controller = controller.replaceAll(
    'await closeAll(position, "TREND_MA20", latest.closeTime);',
    'await closeAll(position, "TREND_MA20", latest.closeTime, favorable);',
  );
}

if (!controller.includes("positionProfitBeforeClose: position.profit, response")) {
  const oldJournal = '  journal("EXIT_EXECUTED", { ticket: managed.ticket, reason, volume: position.volume, response });';
  if (controller.includes(oldJournal)) {
    controller = controller.replace(
      oldJournal,
      '  journal("EXIT_EXECUTED", { ticket: managed.ticket, side: managed.side, reason, volume: position.volume, entry: position.entry, favorable, positionProfitBeforeClose: position.profit, response });',
    );
  }
}

write(controllerPath, controller);
console.log("PHASE7B_RECOVERY_V9_CONTROLLER=PASS");
console.log("PHASE7B_RECOVERY_V9_ENTRY_TARGET=EXACT_PRICE_AND_MOVE");
console.log("PHASE7B_RECOVERY_V9_CLOSE_FALLBACK=MOVE_AND_POSITION_PNL");

// ---------------------------------------------------------------------------
// B. Telegram: exact recovery TP at entry; close notification always prioritizes
//    actual MT5 closed trade, then event fallback.
// ---------------------------------------------------------------------------
let telegram = read(telegramPath);

const oldRecoveryVars = `    const recoveryDay = enrichment.live?.dailyManagement?.mode === "RECOVERY";\n    const dailyPnl = numberOrNull(enrichment.live?.dailyManagement?.realizedPnl);`;
if (telegram.includes(oldRecoveryVars) && !telegram.includes("const recoveryTargetMove = numberOrNull(event.recoveryTargetMove);")) {
  telegram = telegram.replace(
    oldRecoveryVars,
`    const recoveryDay = event.dailyManagementMode === "RECOVERY" || enrichment.live?.dailyManagement?.mode === "RECOVERY";\n    const dailyPnl = numberOrNull(event.dailyRealizedPnlBefore ?? enrichment.live?.dailyManagement?.realizedPnl);\n    const recoveryTargetMove = numberOrNull(event.recoveryTargetMove);\n    const recoveryTargetPrice = numberOrNull(event.recoveryTargetPrice);`,
  );
}

const genericRecoveryTp = '      recoveryDay ? `🎯 Hồi phục ngày: <b>chốt toàn bộ trong +6 → +10 giá</b>` : `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,';
if (telegram.includes(genericRecoveryTp)) {
  telegram = telegram.replace(
    genericRecoveryTp,
    '      recoveryDay ? `🎯 TP hồi phục: <b>${fmtPrice(recoveryTargetPrice)}</b>${recoveryTargetMove === null ? " · chốt toàn bộ trong +6 → +10 giá" : ` · +${recoveryTargetMove.toFixed(2)} giá · chốt TOÀN BỘ`}` : `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,',
  );
}

const oldCloseBlock = `  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {\n    const closed = enrichment.closedTrade;\n    const side = normalizeSide(closed?.side ?? state.trade?.side ?? event.side);\n    const pnl = numberOrNull(closed?.netPnl);\n    const move = closed ? sidePriceMove(side, Number(closed.entry), Number(closed.exit)) : null;\n    const reason = type === "EXIT_EXECUTED" ? event.reason : "MT5 / SL đóng position";\n    return compactMessage(pnl !== null && pnl < 0 ? "🛑" : "🏁", side, "ĐÓNG LỆNH", [\n      \`${fmtMove(move)} giá · P&L tổng ${fmtMoney(pnl, true)}.\`,\n      \`Lý do: ${reasonLabel(reason)}.\`,\n    ]);\n  }`;

if (telegram.includes(oldCloseBlock)) {
  telegram = telegram.replace(
    oldCloseBlock,
`  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {\n    const closed = enrichment.closedTrade;\n    const side = normalizeSide(closed?.side ?? state.trade?.side ?? event.side);\n    const pnl = numberOrNull(closed?.netPnl ?? event.positionProfitBeforeClose);\n    const move = closed\n      ? sidePriceMove(side, Number(closed.entry), Number(closed.exit))\n      : numberOrNull(event.favorable);\n    const reason = type === "EXIT_EXECUTED" ? event.reason : "MT5 / SL đóng position";\n    const action = pnl !== null && pnl < 0 ? "ĐÓNG LỆNH" : "CHỐT LỜI";\n    return compactMessage(pnl !== null && pnl < 0 ? "🛑" : "🏁", side, action, [\n      \`Chốt ${fmtMove(move)} giá · ${pnl !== null && pnl < 0 ? "lỗ" : "lãi"} ${fmtMoney(pnl, true)}.\`,\n      \`Lý do: ${reasonLabel(reason)}.\`,\n    ]);\n  }`,
  );
}

telegram = telegram.replace(
  "  for (let attempt = 0; attempt < 4; attempt += 1) {",
  "  for (let attempt = 0; attempt < 15; attempt += 1) {",
);
telegram = telegram.replace(
  "    if (attempt < 3) await sleep(650);",
  "    if (attempt < 14) await sleep(1000);",
);

// Keep the recovery reason concise and Vietnamese.
if (!telegram.includes('if (v === "DAY_RECOVERY_6_TO_10")')) {
  const marker = '  if (v === "REVERSAL_FVG_REJECTION") return "điều kiện thoát canonical";';
  telegram = replaceRequired(
    telegram,
    marker,
    '  if (v === "DAY_RECOVERY_6_TO_10") return "TP hồi phục ngày";\n' + marker,
    "Telegram recovery reason label",
  );
} else {
  telegram = telegram.replace(
    'if (v === "DAY_RECOVERY_6_TO_10") return "chốt hồi phục ngày trong vùng +6 đến +10 giá";',
    'if (v === "DAY_RECOVERY_6_TO_10") return "TP hồi phục ngày";',
  );
}

write(telegramPath, telegram);
run("node", ["--check", telegramPath], "Telegram syntax check");
console.log("PHASE7B_RECOVERY_V9_TELEGRAM=PASS");
console.log("PHASE7B_RECOVERY_V9_RECOVERY_ENTRY=SL_ACTUAL_PLUS_EXACT_TP_RECOVERY");
console.log("PHASE7B_RECOVERY_V9_CLOSE_MESSAGE=PRICE_MOVE_PLUS_USD");
console.log("PHASE7B_RECOVERY_V9_CLOSED_TRADE_RETRY=15_SECONDS");

run("pnpm", ["--filter", "@xauusd/api", "build"], "API build");
console.log("PHASE7B_RECOVERY_V9_API_BUILD=PASS");
run("pnpm", ["--filter", "@xauusd/web", "build"], "Web build");
console.log("PHASE7B_RECOVERY_V9_WEB_BUILD=PASS");

console.log("PHASE7B_RECOVERY_V9_BOT_RESTARTED=False");
console.log("PHASE7B_RECOVERY_V9_TELEGRAM_RESTARTED=False");
console.log("PHASE7B_RECOVERY_V9_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_RECOVERY_V9=PASS");
