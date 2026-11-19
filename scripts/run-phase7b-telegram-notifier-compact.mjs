import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const token = requiredEnv("ZIQ_TELEGRAM_BOT_TOKEN");
const chatId = requiredEnv("ZIQ_TELEGRAM_CHAT_ID");
const journalPath = requiredEnv("ZIQ_TELEGRAM_JOURNAL_PATH");
const statePath = requiredEnv("ZIQ_TELEGRAM_STATE_PATH");
const symbol = process.env.ZIQ_TELEGRAM_SYMBOL ?? "XAUUSD";
const intervalMs = Math.max(1000, Number(process.env.ZIQ_TELEGRAM_INTERVAL_MS ?? "2000"));
const messageThreadId = optionalNumber(process.env.ZIQ_TELEGRAM_MESSAGE_THREAD_ID);
const monitorUrl = process.env.ZIQ_TELEGRAM_MONITOR_URL?.trim() ?? "";
const monitorApiBase = (process.env.ZIQ_TELEGRAM_MONITOR_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
const sendStartup = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_SEND_STARTUP ?? "true");
const replayExisting = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_REPLAY_EXISTING ?? "false");
const once = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_ONCE ?? "false");
const sendTest = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_SEND_TEST ?? "false");

const interestingEvents = new Set([
  "ENTRY_FILLED",
  "ENTRY_REJECTED",
  "ENTRY_ACCEPTED_POSITION_NOT_RESOLVED",
  "PLUS6_SL_TO_ENTRY",
  "PLUS6_SL_REJECTED",
  "PLUS10_PARTIAL_ONE_THIRD",
  "PLUS10_PARTIAL_REJECTED",
  "STRUCTURAL_SL_TIGHTEN",
  "STRUCTURAL_SL_REJECTED",
  "FVG_HOLD_CONFIRMED",
  "EXIT_EXECUTED",
  "EXIT_REJECTED",
  "MANAGED_POSITION_CLOSED",
  "DEMO_GUARD_BLOCK",
  "UNMANAGED_POSITION_PRESENT",
  "UNEXPECTED_ADDITIONAL_POSITION",
  "CYCLE_ERROR",
]);

fs.mkdirSync(path.dirname(statePath), { recursive: true });
if (!fs.existsSync(journalPath)) fs.writeFileSync(journalPath, "", "utf8");
let state = loadState();

if (sendTest) {
  await sendTestSequence();
  console.log("PHASE7B_TELEGRAM_COMPACT_TEST=PASS");
  process.exit(0);
}

if (!state.initialized) {
  state = {
    version: 4,
    initialized: true,
    offset: replayExisting ? 0 : fs.statSync(journalPath).size,
    sent: 0,
    lastEventAt: null,
    trade: null,
  };
  saveState();
  if (sendStartup) {
    await sendHtml([
      "🤖 <b>XAUUSD AI MASTER · TELEGRAM ĐÃ BẬT</b>",
      `📊 <b>${esc(symbol)}</b> · DEMO`,
      "Chờ: 1 trong 2 mô hình nến + Supertrend M15 và M5 cùng hướng + SL cấu trúc 6–10 giá.",
      "ℹ️ Flip age / FVG / phản ứng gần đường Supertrend chỉ là thông tin & độ tin cậy, không chặn lệnh.",
    ].join("\n"));
  }
}

console.log("PHASE7B_TELEGRAM_COMPACT_NOTIFIER=RUNNING");
console.log(`PHASE7B_TELEGRAM_JOURNAL=${journalPath}`);
console.log(`PHASE7B_TELEGRAM_STATE=${statePath}`);
console.log("PHASE7B_TELEGRAM_ENTRY_GATE=M15_M5_SUPERTREND_ALIGNMENT");
console.log("PHASE7B_TELEGRAM_FLIP_AGE_ROLE=INFO_ONLY");
console.log("PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR");

while (true) {
  try {
    await poll();
  } catch (error) {
    console.error(`PHASE7B_TELEGRAM_ERROR=${errorMessage(error)}`);
  }
  if (once) break;
  await sleep(intervalMs);
}

async function sendTestSequence() {
  await sendHtml([
    "🟢 <b>MUA XAUUSD · ĐÃ VÀO LỆNH</b>",
    "💵 Giá vào: <b>3375.00</b>",
    "🛡 SL: <b>3367.00</b> · −8.00 giá",
    "🎯 TP dự kiến: <b>3385.00</b> · +10.00 giá · chốt 1/3",
    "📦 Khối lượng: <b>0.03 lot</b>",
    "",
    "📝 <b>Lý do vào lệnh:</b>",
    "• Nến nhấn chìm hướng MUA.",
    "• Supertrend M15 = MUA.",
    "• Supertrend M5 = MUA.",
    "• SL cấu trúc hợp lệ 8.00 giá.",
    "⭐ Độ tin cậy: CAO · giá phản ứng gần đường Supertrend M5.",
    "ℹ️ Flip age 3 nến: chỉ tham khảo, không chặn lệnh.",
    "ℹ️ FVG: chỉ bối cảnh, không bắt buộc.",
  ].join("\n"));
  await sleep(250);
  await sendHtml([
    "🛡 <b>MUA · DỜI SL</b>",
    "+6.20 giá · P&L hiện +$18.60",
    "SL → hòa vốn 3375.00.",
  ].join("\n"));
  await sleep(250);
  await sendHtml([
    "💰 <b>MUA · CHỐT 1/3</b>",
    "Chốt +10.00 giá · lãi ≈ +$10.00",
    "Đóng 0.01 lot · còn 0.02 lot.",
  ].join("\n"));
  await sleep(250);
  await sendHtml([
    "🔵 <b>MUA · HOLD</b>",
    "Hiện +14.50 giá · P&L runner +$29.00",
    "Chưa có điều kiện thoát canonical → tiếp tục giữ 0.02 lot.",
  ].join("\n"));
}

async function poll() {
  const stat = fs.statSync(journalPath);
  if (stat.size < state.offset) {
    state.offset = 0;
    saveState();
  }
  if (stat.size === state.offset) return;

  const fd = fs.openSync(journalPath, "r");
  try {
    const length = stat.size - state.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, state.offset);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return;

    const complete = buffer.subarray(0, lastNewline + 1);
    const lines = complete.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (const rawLine of lines) {
      let event;
      try {
        event = JSON.parse(rawLine);
      } catch {
        continue;
      }
      const type = String(event.type ?? "");
      if (!interestingEvents.has(type)) continue;

      const enrichment = await buildEnrichment(event);
      const html = await formatEvent(event, enrichment);
      if (!html) continue;
      await sendHtml(html);
      applyEventState(event, enrichment);
      state.sent += 1;
      state.lastEventAt = String(event.timestamp ?? new Date().toISOString());
      saveState();
    }
    state.offset += lastNewline + 1;
    saveState();
  } finally {
    fs.closeSync(fd);
  }
}

async function buildEnrichment(event) {
  const type = String(event.type ?? "");
  const needsLive = [
    "ENTRY_FILLED",
    "PLUS6_SL_TO_ENTRY",
    "PLUS10_PARTIAL_ONE_THIRD",
    "STRUCTURAL_SL_TIGHTEN",
    "FVG_HOLD_CONFIRMED",
  ].includes(type);
  const live = needsLive ? await getDemoSnapshot() : null;
  const metrics = live ? liveMetrics(live, event) : fallbackMetrics(event);

  let closedTrade = null;
  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {
    closedTrade = await findClosedTradeWithRetry(event);
  }

  let partialPnlEstimate = null;
  if (type === "PLUS10_PARTIAL_ONE_THIRD") {
    partialPnlEstimate = estimatePnlFromPriceMove(
      numberOrNull(event.favorable),
      numberOrNull(event.closedVolume),
      live?.mt5?.spec,
    );
  }

  return { live, metrics, closedTrade, partialPnlEstimate };
}

async function formatEvent(event, enrichment) {
  const type = String(event.type ?? "");

  if (type === "ENTRY_FILLED") {
    const position = event.position ?? {};
    const side = position.side === "LONG" ? "BUY" : position.side === "SHORT" ? "SELL" : normalizeSide(event.side);
    const entry = numberOrNull(position.entry ?? event.fillPrice ?? event.marketEntry ?? event.signalEntry);
    const sl = numberOrNull(position.stopLoss ?? event.stopLoss);
    const slDistance = entry !== null && sl !== null ? sidePriceMove(side, entry, sl) : numberOrNull(event.stopDistance);
    const tp = entry === null ? null : side === "BUY" ? entry + 10 : entry - 10;
    const reasonLines = entryReasonLines(event, enrichment.live, side);
    return [
      `${side === "BUY" ? "🟢" : "🔴"} <b>${side === "BUY" ? "MUA" : "BÁN"} ${esc(symbol)} · ĐÃ VÀO LỆNH</b>`,
      `💵 Giá vào: <b>${fmtPrice(entry)}</b>`,
      `🛡 SL: <b>${fmtPrice(sl)}</b>${slDistance === null ? "" : ` · ${fmtSignedPrice(-Math.abs(slDistance))} giá`}`,
      `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,
      `📦 Khối lượng: <b>${value(position.volume ?? event.volume)} lot</b>`,
      "",
      "📝 <b>Lý do vào lệnh:</b>",
      ...reasonLines,
      "ℹ️ 2/3 runner còn lại không có TP cứng; tiếp tục canonical management.",
    ].join("\n");
  }

  if (type === "PLUS6_SL_TO_ENTRY") {
    const side = currentSide(event, enrichment);
    const m = enrichment.metrics;
    return compactMessage("🛡", side, "DỜI SL", [
      `${fmtMove(m.priceMove)} giá · P&L hiện ${fmtMoney(m.profitUsd, true)}`,
      `SL → hòa vốn ${fmtPrice(m.stopLoss)}.`,
    ]);
  }

  if (type === "PLUS10_PARTIAL_ONE_THIRD") {
    const side = currentSide(event, enrichment);
    return compactMessage("💰", side, "CHỐT 1/3", [
      `Chốt ${fmtMove(numberOrNull(event.favorable))} giá · lãi ${fmtMoney(enrichment.partialPnlEstimate, true, true)}`,
      `Đóng ${value(event.closedVolume)} lot · còn ${value(event.remainingVolume)} lot.`,
    ]);
  }

  if (type === "STRUCTURAL_SL_TIGHTEN") {
    const side = currentSide(event, enrichment);
    const m = enrichment.metrics;
    return compactMessage("🔒", side, "DỜI SL", [
      `SL mới ${fmtPrice(m.stopLoss)} · khóa ${fmtMove(m.slPriceMove)} giá.`,
      `Hiện ${fmtMove(m.priceMove)} giá · P&L ${fmtMoney(m.profitUsd, true)}.`,
    ]);
  }

  if (type === "FVG_HOLD_CONFIRMED") {
    const side = currentSide(event, enrichment);
    const m = enrichment.metrics;
    return compactMessage("🔵", side, "HOLD", [
      `Hiện ${fmtMove(m.priceMove)} giá · P&L ${fmtMoney(m.profitUsd, true)}.`,
      "Chưa có điều kiện thoát canonical → tiếp tục giữ.",
    ]);
  }

  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {
    const closed = enrichment.closedTrade;
    const side = normalizeSide(closed?.side ?? state.trade?.side ?? event.side);
    const pnl = numberOrNull(closed?.netPnl);
    const move = closed ? sidePriceMove(side, Number(closed.entry), Number(closed.exit)) : null;
    const reason = type === "EXIT_EXECUTED" ? event.reason : "MT5 / SL đóng position";
    return compactMessage(pnl !== null && pnl < 0 ? "🛑" : "🏁", side, "ĐÓNG LỆNH", [
      `${fmtMove(move)} giá · P&L tổng ${fmtMoney(pnl, true)}.`,
      `Lý do: ${reasonLabel(reason)}.`,
    ]);
  }

  if (type === "ENTRY_REJECTED" || type === "ENTRY_ACCEPTED_POSITION_NOT_RESOLVED") {
    return warningMessage("VÀO LỆNH", event.message ?? "Position chưa xác định", event.retcode);
  }
  if (type.endsWith("_REJECTED")) {
    return warningMessage("THAO TÁC BỊ TỪ CHỐI", event.message ?? event.response?.message ?? type, event.response?.retcode ?? event.retcode);
  }
  if (["DEMO_GUARD_BLOCK", "UNMANAGED_POSITION_PRESENT", "UNEXPECTED_ADDITIONAL_POSITION", "CYCLE_ERROR"].includes(type)) {
    return warningMessage("HỆ THỐNG", event.message ?? event.reason ?? type, null);
  }
  return null;
}

function entryReasonLines(event, live, side) {
  const d = live?.entryDiagnostics ?? null;
  const pattern = d?.pattern?.name ?? event.pattern ?? "Mô hình hợp lệ";
  const m15 = d?.trend?.m15Supertrend ?? side;
  const m5 = d?.trend?.m5Supertrend ?? side;
  const flipAge = d?.trend?.m5FlipAgeBars;
  const confidence = String(d?.trend?.confidenceLevel ?? event.confidenceLevel ?? "TIÊU_CHUẨN").replaceAll("_", " ");
  const stopDistance = numberOrNull(d?.entry?.stopDistance ?? event.stopDistance);
  const reactions = [];
  if (d?.trend?.m15TrendlineReaction) reactions.push("M15");
  if (d?.trend?.m5TrendlineReaction) reactions.push("M5");
  return [
    `• ${patternLabel(pattern)} hướng ${side === "BUY" ? "MUA" : "BÁN"}.`,
    `• Supertrend M15 = ${m15 === "SELL" ? "BÁN" : "MUA"}.`,
    `• Supertrend M5 = ${m5 === "SELL" ? "BÁN" : "MUA"}.`,
    stopDistance === null ? "• Khoảng SL cấu trúc đã được controller chấp nhận." : `• SL cấu trúc hợp lệ ${stopDistance.toFixed(2)} giá.`,
    `⭐ Độ tin cậy: ${confidence}${reactions.length ? ` · phản ứng gần đường Supertrend ${reactions.join(" + ")}` : ""}.`,
    Number.isFinite(Number(flipAge)) ? `ℹ️ Flip age ${Number(flipAge)} nến: chỉ tham khảo, không chặn lệnh.` : "ℹ️ Flip age: chỉ tham khảo, không chặn lệnh.",
    `ℹ️ FVG: ${d?.fvg?.sameDirectionConfirmed || event.fvgConfirmedAtEntry ? "CÓ" : "KHÔNG"} · chỉ là bối cảnh.`,
  ];
}

function applyEventState(event, enrichment) {
  const type = String(event.type ?? "");
  if (type === "ENTRY_FILLED") {
    const position = event.position ?? {};
    const side = position.side === "LONG" ? "BUY" : position.side === "SHORT" ? "SELL" : normalizeSide(event.side);
    state.trade = {
      ticket: String(position.ticket ?? event.ticket ?? ""),
      side,
      entry: numberOrNull(position.entry ?? event.fillPrice),
      initialVolume: numberOrNull(position.volume),
      remainingVolume: numberOrNull(position.volume),
      stopLoss: numberOrNull(position.stopLoss),
      openedAt: Date.parse(String(event.timestamp ?? new Date().toISOString())),
      realizedPnlEstimate: 0,
    };
    return;
  }
  if (!state.trade) return;
  if (type === "PLUS6_SL_TO_ENTRY" || type === "STRUCTURAL_SL_TIGHTEN") {
    const stop = numberOrNull(event.stopLoss ?? enrichment.metrics?.stopLoss);
    if (stop !== null) state.trade.stopLoss = stop;
  }
  if (type === "PLUS10_PARTIAL_ONE_THIRD") {
    state.trade.remainingVolume = numberOrNull(event.remainingVolume) ?? state.trade.remainingVolume;
    if (enrichment.partialPnlEstimate !== null) {
      state.trade.realizedPnlEstimate = Number(state.trade.realizedPnlEstimate ?? 0) + enrichment.partialPnlEstimate;
    }
  }
  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") state.trade = null;
}

function currentSide(event, enrichment) {
  return normalizeSide(enrichment.live?.state?.managed?.side ?? state.trade?.side ?? event.side);
}

function liveMetrics(snapshot, event) {
  const managed = snapshot?.mt5?.managedPosition ?? null;
  const managedState = snapshot?.state?.managed ?? null;
  const side = normalizeSide(managedState?.side ?? state.trade?.side ?? event.side);
  const entry = numberOrNull(managed?.entry ?? managedState?.entry ?? state.trade?.entry);
  const quote = snapshot?.mt5?.quote ?? null;
  const market = side === "BUY" ? numberOrNull(quote?.bid) : numberOrNull(quote?.ask);
  const stopLoss = numberOrNull(managed?.stopLoss ?? managedState?.lastStructuralStop ?? event.stopLoss ?? state.trade?.stopLoss);
  const volume = numberOrNull(managed?.volume ?? managedState?.expectedRemainingVolume ?? state.trade?.remainingVolume);
  const priceMove = entry !== null && market !== null ? sidePriceMove(side, entry, market) : numberOrNull(event.favorable);
  const slPriceMove = entry !== null && stopLoss !== null ? sidePriceMove(side, entry, stopLoss) : null;
  return {
    side,
    entry,
    market,
    stopLoss,
    volume,
    priceMove,
    slPriceMove,
    profitUsd: numberOrNull(managed?.profit),
  };
}

function fallbackMetrics(event) {
  const side = normalizeSide(state.trade?.side ?? event.side);
  const entry = numberOrNull(state.trade?.entry);
  const stopLoss = numberOrNull(event.stopLoss ?? state.trade?.stopLoss);
  return {
    side,
    entry,
    market: null,
    stopLoss,
    volume: numberOrNull(state.trade?.remainingVolume),
    priceMove: numberOrNull(event.favorable),
    slPriceMove: entry !== null && stopLoss !== null ? sidePriceMove(side, entry, stopLoss) : null,
    profitUsd: null,
  };
}

async function getDemoSnapshot() {
  return fetchJson(`${monitorApiBase}/api/v1/phase7b-demo`, 1800).catch(() => null);
}

async function findClosedTradeWithRetry(event) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const performance = await fetchJson(`${monitorApiBase}/api/v1/mt5/performance?symbol=${encodeURIComponent(symbol)}&days=7`, 3000).catch(() => null);
    const trade = matchClosedTrade(performance?.trades ?? [], event);
    if (trade) return trade;
    if (attempt < 3) await sleep(650);
  }
  return null;
}

function matchClosedTrade(trades, event) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const ticket = String(event.ticket ?? state.trade?.ticket ?? "");
  const side = normalizeSide(state.trade?.side ?? event.side);
  const eventAt = Date.parse(String(event.timestamp ?? new Date().toISOString()));
  const exact = ticket ? trades.find((trade) => String(trade.id ?? "").endsWith(ticket) && trade.ownership === "SYSTEM") : null;
  if (exact) return exact;
  return trades.find((trade) => trade.ownership === "SYSTEM" && normalizeSide(trade.side) === side && Math.abs(Number(trade.closedAt ?? 0) - eventAt) <= 10 * 60_000) ?? null;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function compactMessage(icon, side, action, lines) {
  return [
    `${icon} <b>${side === "BUY" ? "MUA" : "BÁN"} · ${esc(action)}</b>`,
    ...lines,
  ].join("\n");
}

function warningMessage(title, message, retcode) {
  return [
    `⚠️ <b>${esc(title)}</b>`,
    esc(String(message ?? "Kiểm tra journal")),
    retcode === null || retcode === undefined ? "" : `Retcode: ${esc(value(retcode))}`,
  ].filter(Boolean).join("\n");
}

async function sendHtml(text) {
  const payload = {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(messageThreadId === null ? {} : { message_thread_id: messageThreadId }),
    ...(monitorUrl ? { reply_markup: { inline_keyboard: [[{ text: "📊 Mở màn hình DEMO", url: monitorUrl }]] } } : {}),
  };

  let lastError = null;
  const delays = [0, 700, 1600, 3200];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      await sendTelegramHttps(payload);
      if (attempt > 0) console.log(`PHASE7B_TELEGRAM_SEND_RECOVERED_ATTEMPT=${attempt + 1}`);
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code ?? error?.cause?.code ?? "UNKNOWN";
      console.error(`PHASE7B_TELEGRAM_SEND_RETRY=${attempt + 1}/${delays.length} CODE=${code} ERROR=${errorMessage(error)}`);
    }
  }
  throw lastError ?? new Error("Telegram send failed after retries.");
}

function sendTelegramHttps(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      protocol: "https:",
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: "POST",
      family: 4,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "XAUUSD-AI-MASTER-Phase7B/1.0",
        connection: "close",
      },
      timeout: 10_000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = responseText ? JSON.parse(responseText) : null; } catch {}
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300 || parsed?.ok !== true) {
          const error = new Error(`Telegram sendMessage ${response.statusCode ?? 0}: ${responseText}`);
          error.code = `HTTP_${response.statusCode ?? 0}`;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => {
      const error = new Error("Telegram HTTPS request timed out after 10 seconds.");
      error.code = "ETIMEDOUT";
      req.destroy(error);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function loadState() {
  const blank = { version: 4, initialized: false, offset: 0, sent: 0, lastEventAt: null, trade: null };
  if (!fs.existsSync(statePath)) return blank;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
    return {
      version: 4,
      initialized: Boolean(parsed.initialized),
      offset: Number.isFinite(parsed.offset) ? parsed.offset : 0,
      sent: Number.isFinite(parsed.sent) ? parsed.sent : 0,
      lastEventAt: parsed.lastEventAt ?? null,
      trade: parsed.trade && typeof parsed.trade === "object" ? parsed.trade : null,
    };
  } catch {
    return blank;
  }
}

function saveState() {
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, statePath);
}

function estimatePnlFromPriceMove(priceMove, volume, spec) {
  const move = numberOrNull(priceMove);
  const lots = numberOrNull(volume);
  const tickSize = numberOrNull(spec?.tickSize);
  const tickValue = numberOrNull(spec?.effectiveTickValuePerLot);
  if (move === null || lots === null || tickSize === null || tickValue === null || tickSize <= 0) return null;
  return move / tickSize * tickValue * lots;
}

function sidePriceMove(side, entry, price) {
  if (![entry, price].every(Number.isFinite)) return null;
  return side === "SELL" ? entry - price : price - entry;
}

function normalizeSide(raw) {
  const v = String(raw ?? state.trade?.side ?? "BUY").toUpperCase();
  return v === "SELL" || v === "SHORT" ? "SELL" : "BUY";
}

function patternLabel(raw) {
  const v = String(raw ?? "");
  if (v === "ENGULFING") return "Nến nhấn chìm";
  if (v === "TWO_CANDLE_BODY_DOMINANCE" || v === "TWO_CANDLE") return "Hai nến thân chiếm ưu thế";
  return v.replaceAll("_", " ") || "Mô hình hợp lệ";
}

function fmtPrice(raw) {
  const n = numberOrNull(raw);
  return n === null ? "—" : n.toFixed(2);
}

function fmtSignedPrice(raw) {
  const n = numberOrNull(raw);
  if (n === null) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}`;
}

function fmtMove(raw) {
  const n = numberOrNull(raw);
  return n === null ? "—" : fmtSignedPrice(n);
}

function fmtMoney(raw, signed = false, approximate = false) {
  const n = numberOrNull(raw);
  if (n === null) return "—";
  const sign = signed ? (n > 0 ? "+" : n < 0 ? "−" : "") : "";
  return `${approximate ? "≈ " : ""}${sign}$${Math.abs(n).toFixed(2)}`;
}

function reasonLabel(raw) {
  const v = String(raw ?? "UNKNOWN");
  if (v === "REVERSAL_FVG_REJECTION") return "điều kiện thoát canonical";
  if (v === "TREND_MA20") return "điều kiện thoát canonical";
  return v.replaceAll("_", " ");
}

function numberOrNull(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function value(raw) {
  if (raw === null || raw === undefined || raw === "") return "—";
  if (typeof raw === "number") return Number.isInteger(raw) ? String(raw) : String(Math.round(raw * 100000) / 100000);
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

function esc(raw) {
  return String(raw ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function optionalNumber(raw) {
  if (!raw?.trim()) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error("ZIQ_TELEGRAM_MESSAGE_THREAD_ID must be an integer when provided.");
  return parsed;
}

function requiredEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
