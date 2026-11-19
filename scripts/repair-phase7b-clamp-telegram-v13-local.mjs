import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const controllerPath = path.join(root, "scripts", "run-phase7b-demo-controller.ts");
const wrapperPath = path.join(root, "scripts", "run-phase7b-telegram-notifier-local.ps1");
const compactPath = path.join(root, "scripts", "run-phase7b-telegram-notifier-compact.mjs");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}
function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}
function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed: ${result.status}`);
}

// A. Repair daily recovery target calculation. V8/V10 called clamp(), but the
// local controller has no clamp helper. Use explicit Math.min/Math.max instead.
let controller = read(controllerPath);
const brokenClamp = "  const targetMove = clamp(rawRequiredMove, DAY_RECOVERY_MIN_MOVE, DAY_RECOVERY_MAX_MOVE);";
const safeClamp = "  const targetMove = Math.min(DAY_RECOVERY_MAX_MOVE, Math.max(DAY_RECOVERY_MIN_MOVE, rawRequiredMove));";
if (controller.includes(brokenClamp)) controller = controller.replace(brokenClamp, safeClamp);
if (!controller.includes(safeClamp)) throw new Error("Daily recovery target calculation marker not found.");
if (controller.includes("clamp(rawRequiredMove, DAY_RECOVERY_MIN_MOVE, DAY_RECOVERY_MAX_MOVE)")) {
  throw new Error("Broken daily recovery clamp call is still present.");
}
write(controllerPath, controller);
console.log("PHASE7B_V13_DAILY_RECOVERY_CLAMP=PASS");
console.log("PHASE7B_V13_BOT_RESTARTED=False");

// B. Make the PowerShell wrapper launch the compact notifier that carries the
// current Supertrend/recovery/close-message implementation.
let wrapper = read(wrapperPath);
wrapper = wrapper.replace(
  '$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier.mjs"',
  '$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-compact.mjs"',
);
if (!wrapper.includes('$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-compact.mjs"')) {
  throw new Error("Telegram wrapper could not be switched to compact notifier.");
}
write(wrapperPath, wrapper);
console.log("PHASE7B_V13_TELEGRAM_WRAPPER=COMPACT");

// C. If Telegram starts after a trade was already filled, send one current-open
// snapshot for that notifier process instead of silently skipping the old
// ENTRY_FILLED journal event. This is read-only and never sends MT5 commands.
let compact = read(compactPath);
if (!compact.includes("ZIQ_TELEGRAM_SYNC_OPEN_POSITION_ON_START")) {
  const marker = 'const sendTest = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_SEND_TEST ?? "false");';
  if (!compact.includes(marker)) throw new Error("Compact notifier sendTest marker not found.");
  compact = compact.replace(
    marker,
    marker + '\nconst syncOpenPositionOnStart = !/^(0|false|no|off)$/i.test(process.env.ZIQ_TELEGRAM_SYNC_OPEN_POSITION_ON_START ?? "true");',
  );
}

if (!compact.includes("PHASE7B_TELEGRAM_OPEN_POSITION_SYNC")) {
  const runMarker = 'console.log("PHASE7B_TELEGRAM_COMPACT_NOTIFIER=RUNNING");';
  if (!compact.includes(runMarker)) throw new Error("Compact notifier RUNNING marker not found.");
  compact = compact.replace(
    runMarker,
`if (syncOpenPositionOnStart) {
  try {
    await sendOpenPositionSnapshot();
  } catch (error) {
    console.error(\`PHASE7B_TELEGRAM_OPEN_POSITION_SYNC_ERROR=\${errorMessage(error)}\`);
  }
}

${runMarker}`,
  );

  const functionMarker = "async function sendTestSequence() {";
  if (!compact.includes(functionMarker)) throw new Error("Compact notifier test function marker not found.");
  const syncFunction = `async function sendOpenPositionSnapshot() {
  const snapshot = await getDemoSnapshot();
  const managed = snapshot?.state?.managed ?? null;
  const position = snapshot?.mt5?.managedPosition ?? null;
  if (!managed || !position) {
    console.log("PHASE7B_TELEGRAM_OPEN_POSITION_SYNC=NONE");
    return;
  }

  const side = normalizeSide(managed.side ?? position.side);
  const ticket = String(position.ticket ?? managed.ticket ?? "");
  const entry = numberOrNull(position.entry ?? managed.entry);
  const sl = numberOrNull(position.stopLoss ?? managed.lastStructuralStop);
  const pnl = numberOrNull(position.profit);
  const volume = numberOrNull(position.volume ?? managed.expectedRemainingVolume);
  const daily = snapshot?.dailyManagement ?? null;
  const recent = Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : [];
  const entryEvent = recent.find((event) => {
    if (String(event?.type ?? "") !== "ENTRY_FILLED") return false;
    const eventTicket = String(event?.position?.ticket ?? event?.ticket ?? "");
    return ticket && eventTicket === ticket;
  }) ?? null;
  const recoveryMove = numberOrNull(entryEvent?.recoveryTargetMove);
  const recoveryPrice = numberOrNull(entryEvent?.recoveryTargetPrice);

  const lines = [
    \`🔄 <b>\${side === "BUY" ? "MUA" : "BÁN"} \${esc(symbol)} · LỆNH ĐANG MỞ</b>\`,
    \`💵 Giá vào: <b>\${fmtPrice(entry)}</b>\`,
    \`🛡 SL: <b>\${fmtPrice(sl)}</b>\`,
    \`📦 Khối lượng: <b>\${value(volume)} lot</b>\`,
    \`💰 P&L đang mở: <b>\${fmtMoney(pnl, true)}</b>\`,
  ];

  if (daily?.mode === "RECOVERY") {
    lines.push(\`📅 P&L Bot hôm nay: <b>\${fmtMoney(numberOrNull(daily.realizedPnl), true)}</b> · HỒI PHỤC NGÀY\`);
    lines.push(
      recoveryMove !== null && recoveryPrice !== null
        ? \`🎯 TP hồi phục: <b>\${fmtPrice(recoveryPrice)}</b> · +\${recoveryMove.toFixed(2)} giá · chốt TOÀN BỘ\`
        : "⚠️ TP hồi phục của lệnh này chưa có trong ENTRY_FILLED; controller cần được nạp bản sửa trước lệnh kế tiếp.",
    );
  } else {
    lines.push("📈 Chế độ: GỒNG THEO TREND");
  }
  lines.push("ℹ️ Telegram được bật/sync sau khi position đã tồn tại; notifier chỉ đọc, không điều khiển MT5.");
  await sendHtml(lines.join("\\n"));
  console.log(\`PHASE7B_TELEGRAM_OPEN_POSITION_SYNC=PASS TICKET=\${ticket}\`);
}

`;
  compact = compact.replace(functionMarker, syncFunction + functionMarker);
}

write(compactPath, compact);
run(process.execPath, ["--check", compactPath], "Compact notifier syntax check");
console.log("PHASE7B_V13_TELEGRAM_OPEN_POSITION_SYNC=PASS");
console.log("PHASE7B_V13_TELEGRAM_ORDER_PERMISSION=READ_ONLY");
console.log("PHASE7B_V13_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V13=PASS");
