import dns from "node:dns";
import net from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  isExpiredTelegramCallbackError,
  nextTelegramUpdateOffset,
  persistedTelegramUpdateOffset,
  telegramModeForCallback,
  telegramModeForCommand,
} from "./phase7c-telegram-mode-logic.mjs";

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);

const fallbackToken = requiredEnv("ZIQ_TELEGRAM_BOT_TOKEN");
const fallbackChatId = requiredEnv("ZIQ_TELEGRAM_CHAT_ID");

const token =
  process.env.ZIQ_TELEGRAM_CONTROL_BOT_TOKEN?.trim() || fallbackToken;
const chatId =
  process.env.ZIQ_TELEGRAM_CONTROL_CHAT_ID?.trim() || fallbackChatId;
const apiBase = (process.env.ZIQ_PHASE7C_CONTROL_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
const intervalMs = Math.max(1000, Number(process.env.ZIQ_PHASE7C_CONTROL_INTERVAL_MS ?? "1500"));
const inheritedRuntimeState = process.env.ZIQ_PHASE7C_REGIME_STATE_FILE?.trim();
const defaultStatusFile = inheritedRuntimeState
  ? resolve(dirname(inheritedRuntimeState), "telegram-mode-status.json")
  : resolve(".runtime/phase7c-telegram-mode-status.json");
const statusFile = resolve(
  process.env.ZIQ_PHASE7C_TELEGRAM_MODE_STATUS_FILE?.trim() || defaultStatusFile,
);
const telegramBase = `https://api.telegram.org/bot${token}`;
const semiModeHelpText = "SEMI = vào lệnh thủ công • SL đầu 6 giá • +6 → BE • +10 → chốt 1/3 • phần còn lại quản lý như Trend";
let updateOffset = await loadUpdateOffset();
let ready = false;
let initialPanelSent = false;
let lastMode = "UNKNOWN";
let nextStartupAttemptAt = 0;
let lastTelegramSuccessAt = 0;
let lastApiSuccessAt = 0;

console.log("PHASE7C_TELEGRAM_MODE_CONTROLLER=RUNNING");
console.log(`PHASE7C_CONTROL_API=${apiBase}`);
console.log(`PHASE7C_TELEGRAM_STATUS_FILE=${statusFile}`);
console.log("PHASE7C_MT5_ORDER_PERMISSION=NONE");
await writeStatus({
  ready: false,
  status: "STARTING",
  startedAt: Date.now(),
  pid: process.pid,
  lastTelegramSuccessAt: null,
  lastApiSuccessAt: null,
});

while (true) {
  const now = Date.now();

  if (!ready && now >= nextStartupAttemptAt) {
    try {
      const initial = await getBotMode();
      lastApiSuccessAt = Date.now();
      lastMode = initial.mode;
      await telegramRequest("getMe");
      lastTelegramSuccessAt = Date.now();
      if (updateOffset === 0) {
        await discardPendingUpdates();
      }
      if (!initialPanelSent) {
        const startupNote = initial.mode === "PAUSE"
          ? "Bot và Telegram vừa khởi động ở chế độ TẠM DỪNG; AUTO chỉ được bật thủ công từ Web sau khi xác minh an toàn."
          : `Bot và Telegram vừa khởi động ở chế độ ${modeVi(initial.mode)}.`;
        await sendPanel(initial.mode, startupNote);
        lastTelegramSuccessAt = Date.now();
        initialPanelSent = true;
      }
      ready = true;
      const successAt = Date.now();
      await writeStatus({
        ready: true,
        status: "READY",
        pid: process.pid,
        mode: lastMode,
        lastApiSuccessAt,
        lastTelegramSuccessAt,
        updatedAt: successAt,
      });
      console.log(`PHASE7C_TELEGRAM_MODE_READY=PASS|MODE=${initial.mode}`);
    } catch (error) {
      const message = errorMessage(error);
      nextStartupAttemptAt = Date.now() + 10_000;
      await writeStatus({
        ready: false,
        status: "STARTUP_RETRY",
        pid: process.pid,
        mode: lastMode,
        lastApiSuccessAt: lastApiSuccessAt || null,
        lastTelegramSuccessAt: lastTelegramSuccessAt || null,
        lastError: message,
        retryAt: nextStartupAttemptAt,
        updatedAt: Date.now(),
      });
      console.error(`PHASE7C_TELEGRAM_MODE_STARTUP_RETRY=${message}`);
    }
  }

  if (ready) {
    try {
      await pollTelegram();
      await syncExternalMode();
      lastTelegramSuccessAt = Date.now();
      await writeStatus({
        ready,
        status: "READY",
        pid: process.pid,
        mode: lastMode,
        lastApiSuccessAt: lastApiSuccessAt || null,
        lastTelegramSuccessAt,
        updatedAt: lastTelegramSuccessAt,
      });
    } catch (error) {
      const message = errorMessage(error);
      await writeStatus({
        ready,
        status: "DEGRADED_RETRYING",
        pid: process.pid,
        mode: lastMode,
        lastApiSuccessAt: lastApiSuccessAt || null,
        lastTelegramSuccessAt: lastTelegramSuccessAt || null,
        lastError: message,
        updatedAt: Date.now(),
      });
      console.error(`PHASE7C_TELEGRAM_CONTROL_ERROR=${message}`);
    }
  }

  await sleep(intervalMs);
}

async function pollTelegram() {
  const query = new URLSearchParams({
    offset: String(updateOffset),
    timeout: "0",
    limit: "25",
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  const payload = await telegramRequest(`getUpdates?${query.toString()}`);
  const updates = Array.isArray(payload.result) ? payload.result : [];

  for (const update of updates) {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
    // A transient control-API failure must not consume the button press.
    updateOffset = nextTelegramUpdateOffset(updateOffset, update.update_id);
  }
}

async function syncExternalMode() {
  const current = await getBotMode();
  lastApiSuccessAt = Date.now();
  if (!current?.mode || current.mode === lastMode) return;
  const previousMode = lastMode;
  lastMode = current.mode;
  await sendPanel(
    current.mode,
    `Web/API đã chuyển chế độ ${modeVi(previousMode)} → ${modeVi(current.mode)}. Bot và Telegram đang hoạt động.`,
  );
  console.log(`PHASE7C_MODE_CHANGED=${current.mode}|SOURCE=EXTERNAL_API`);
}

async function handleCallback(callback) {
  const callbackId = String(callback.id ?? "");
  const callbackChatId = String(callback.message?.chat?.id ?? callback.from?.id ?? "");
  if (callbackChatId !== String(chatId)) {
    if (callbackId) await answerCallback(callbackId, "Không được phép.");
    return;
  }

  const data = String(callback.data ?? "");
  if (data === "p7c:REFRESH") {
    const current = await getBotMode();
    lastApiSuccessAt = Date.now();
    lastMode = current.mode;
    if (callbackId) await answerCallback(callbackId, `Chế độ hiện tại: ${modeVi(current.mode)}`);
    await editPanel(callback.message, current.mode, "Đã làm mới trạng thái.");
    return;
  }

  if (data.toUpperCase() === "P7C:AUTO") {
    const current = await getBotMode();
    lastApiSuccessAt = Date.now();
    lastMode = current.mode;
    if (callbackId) await answerCallback(callbackId, "AUTO chỉ được bật thủ công từ Web.");
    await editPanel(callback.message, current.mode, "Telegram không có quyền bật AUTO. Hãy dùng Web Control Center.");
    return;
  }

  const mode = telegramModeForCallback(data);
  if (!mode) {
    if (callbackId) await answerCallback(callbackId, "Chế độ không hợp lệ.");
    return;
  }

  const state = await setBotMode(mode, "telegram");
  lastApiSuccessAt = Date.now();
  lastMode = state.mode;
  if (callbackId) await answerCallback(callbackId, `Đã chọn ${modeVi(state.mode)}`);
  await editPanel(callback.message, state.mode, `Đã chuyển sang ${modeVi(state.mode)}.`);
  console.log(`PHASE7C_MODE_CHANGED=${state.mode}|SOURCE=TELEGRAM`);
}

async function handleMessage(message) {
  const messageChatId = String(message.chat?.id ?? "");
  if (messageChatId !== String(chatId)) return;
  const raw = String(message.text ?? "").trim();
  if (!raw) return;
  const command = raw.split(/\s+/)[0].toLowerCase().replace(/@[^\s]+$/, "");

  if (command === "/mode" || command === "/bots" || command === "/chedo" || command === "/bot") {
    const current = await getBotMode();
    lastApiSuccessAt = Date.now();
    lastMode = current.mode;
    await sendPanel(current.mode, "Chọn bot bạn muốn cho phép hoạt động. AUTO chỉ bật từ Web.");
    return;
  }

  if (command === "/auto" || command === "/tudong") {
    const current = await getBotMode();
    lastApiSuccessAt = Date.now();
    lastMode = current.mode;
    await sendPanel(current.mode, "Telegram không có quyền bật AUTO. Hãy dùng Web Control Center.");
    return;
  }

  const mode = telegramModeForCommand(command);
  if (!mode) return;
  const state = await setBotMode(mode, "telegram-command");
  lastApiSuccessAt = Date.now();
  lastMode = state.mode;
  await sendPanel(state.mode, `Đã chuyển sang ${modeVi(state.mode)}.`);
  console.log(`PHASE7C_MODE_CHANGED=${state.mode}|SOURCE=TELEGRAM_COMMAND`);
}

async function sendPanel(mode, note) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: panelText(mode, note),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard(mode),
  });
  lastTelegramSuccessAt = Date.now();
}

async function editPanel(message, mode, note) {
  const messageId = message?.message_id;
  const panelChatId = message?.chat?.id;
  if (!messageId || panelChatId === undefined) {
    await sendPanel(mode, note);
    return;
  }
  try {
    await telegramRequest("editMessageText", {
      chat_id: panelChatId,
      message_id: messageId,
      text: panelText(mode, note),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard(mode),
    });
    lastTelegramSuccessAt = Date.now();
  } catch (error) {
    if (!errorMessage(error).includes("message is not modified")) throw error;
  }
}

function modeVi(mode) {
  return {
    TREND: "bot Trend",
    SIDEWAY: "bot Sideway",
    SEMI: "BÁN TỰ ĐỘNG",
    AUTO: "TỰ ĐỘNG",
    PAUSE: "TẠM DỪNG",
    UNKNOWN: "KHÔNG XÁC ĐỊNH",
  }[String(mode ?? "").toUpperCase()] ?? "KHÔNG XÁC ĐỊNH";
}

function panelText(mode, note) {
  const description = {
    TREND: "Chỉ bot Trend được phép tạo chiến lược mới.",
    SIDEWAY: "Chỉ bot Sideway được phép tạo chiến lược mới theo vùng cung/cầu và hồi quy về trung bình.",
    SEMI: "Chỉ nhận lệnh XAUUSD vào thủ công để bảo vệ và quản lý theo Trend; hệ thống không tự tạo entry SEMI.",
    AUTO: "Bộ phân loại trạng thái thị trường tự chọn bot Trend hoặc bot Sideway; AUTO chỉ được kích hoạt thủ công từ Web.",
    PAUSE: "Không bot nào được phép tạo kế hoạch giao dịch mới; executor vẫn chạy để quản lý trạng thái/vị thế hiện có.",
  }[mode] ?? "Trạng thái không xác định.";

  return [
    "🎛 <b>XAUUSD AI MASTER · CHẾ ĐỘ BOT</b>",
    "",
    `Chế độ hiện tại: <b>${escapeHtml(modeVi(mode))}</b>`,
    escapeHtml(description),
    `✋ ${escapeHtml(semiModeHelpText)}`,
    "",
    `ℹ️ ${escapeHtml(note)}`,
    "🔒 Telegram không thể bật AUTO và không gửi lệnh trực tiếp tới MT5.",
  ].join("\n");
}

function keyboard(activeMode) {
  const button = (label, mode) => ({
    text: `${activeMode === mode ? "✅ " : ""}${label}`,
    callback_data: `p7c:${mode}`,
  });
  return {
    inline_keyboard: [
      [button("bot Trend", "TREND"), button("bot Sideway", "SIDEWAY")],
      [button("✋ SEMI", "SEMI"), button("TẠM DỪNG", "PAUSE")],
      [{ text: "🔄 Làm mới", callback_data: "p7c:REFRESH" }],
    ],
  };
}

async function getBotMode() {
  const response = await apiRequest("GET", "/api/v1/phase7c/bot-mode");
  return response.state ?? { mode: "PAUSE" };
}

async function setBotMode(mode, source) {
  const response = await apiRequest("POST", "/api/v1/phase7c/bot-mode", { mode, source });
  return response.state;
}

async function apiRequest(method, endpoint, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${apiBase}${endpoint}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Phase7C API ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function telegramRequest(method, body) {
  const url = `${telegramBase}/${method}`;
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function answerCallback(callbackQueryId, text) {
  try {
    await telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
    lastTelegramSuccessAt = Date.now();
  } catch (error) {
    const message = errorMessage(error);
    if (isExpiredTelegramCallbackError(error)) {
      console.warn(`PHASE7C_TELEGRAM_CALLBACK_EXPIRED=${message}`);
      return;
    }
    throw error;
  }
}

async function discardPendingUpdates() {
  const query = new URLSearchParams({
    offset: "-1",
    timeout: "0",
    limit: "1",
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  const payload = await telegramRequest(`getUpdates?${query.toString()}`);
  const latest = Array.isArray(payload.result) ? payload.result.at(-1) : null;
  if (latest) {
    updateOffset = Number(latest.update_id ?? 0) + 1;
    console.log(`PHASE7C_TELEGRAM_PENDING_DISCARDED_THROUGH=${updateOffset - 1}`);
  }
}

async function loadUpdateOffset() {
  try {
    const parsed = JSON.parse(await readFile(statusFile, "utf8"));
    return persistedTelegramUpdateOffset(parsed);
  } catch {
    return 0;
  }
}

async function writeStatus(next) {
  const now = Date.now();
  const payload = {
    version: 2,
    updateOffset,
    ...next,
    updatedAt: next.updatedAt ?? now,
    updatedAtIso: new Date(next.updatedAt ?? now).toISOString(),
  };
  await mkdir(dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporary, statusFile);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
