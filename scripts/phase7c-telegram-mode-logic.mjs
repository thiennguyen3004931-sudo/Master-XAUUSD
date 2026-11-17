const TELEGRAM_COMMAND_MODES = new Map([
  ["/trend", "TREND"],
  ["/sideway", "SIDEWAY"],
  ["/pause", "PAUSE"],
  ["/xuhuong", "TREND"],
  ["/dingang", "SIDEWAY"],
  ["/tamdung", "PAUSE"],
]);

const TELEGRAM_CALLBACK_MODES = new Set(["TREND", "SIDEWAY", "SEMI", "PAUSE"]);

export function nextTelegramUpdateOffset(currentOffset, updateId) {
  const current = Number.isInteger(Number(currentOffset)) ? Number(currentOffset) : 0;
  const next = Number.isInteger(Number(updateId)) ? Number(updateId) + 1 : current;
  return Math.max(current, next);
}

export function persistedTelegramUpdateOffset(payload) {
  const value = Number(payload?.updateOffset);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function isExpiredTelegramCallbackError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("query is too old") || message.includes("query ID is invalid");
}

export function telegramModeForCommand(rawCommand) {
  const command = String(rawCommand ?? "").trim().toLowerCase().replace(/@[^\s]+$/, "");
  return TELEGRAM_COMMAND_MODES.get(command) ?? null;
}

export function telegramModeForCallback(rawData) {
  const data = String(rawData ?? "").trim();
  const mode = data.startsWith("p7c:") ? data.slice(4).toUpperCase() : "";
  return TELEGRAM_CALLBACK_MODES.has(mode) ? mode : null;
}
