import { canonicalHoldReason } from "./phase7c-hold-observability.mjs";
import {
  DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD,
  DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS,
  evaluateTransientSystemAlertDebounce,
  isMt5CycleErrorEvent,
} from "./phase7c-system-alert-debounce.mjs";
import fs from "node:fs";
import path from "node:path";

const fallbackToken = requiredEnv("ZIQ_TELEGRAM_BOT_TOKEN");
const fallbackChatId = requiredEnv("ZIQ_TELEGRAM_CHAT_ID");

const tradeToken =
  process.env.ZIQ_TELEGRAM_TRADE_BOT_TOKEN?.trim() || fallbackToken;
const tradeChatId =
  process.env.ZIQ_TELEGRAM_TRADE_CHAT_ID?.trim() || fallbackChatId;

const controlToken =
  process.env.ZIQ_TELEGRAM_CONTROL_BOT_TOKEN?.trim() || fallbackToken;
const controlChatId =
  process.env.ZIQ_TELEGRAM_CONTROL_CHAT_ID?.trim() || fallbackChatId;
const trendJournalPath = requiredEnv("ZIQ_TELEGRAM_JOURNAL_PATH");
const journalPath = trendJournalPath;
const sidewayJournalPath =
  process.env.ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH?.trim() || "";
const statePath = requiredEnv("ZIQ_TELEGRAM_STATE_PATH");
fs.mkdirSync(path.dirname(statePath), { recursive: true });
const singletonPath = `${statePath}.lock`;
let singletonFd;
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    singletonFd = fs.openSync(singletonPath, "wx");
    fs.writeFileSync(singletonFd, `${process.pid}\n`, "utf8");
    break;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;

    let ownerPid = null;
    try {
      const rawOwnerPid = fs.readFileSync(singletonPath, "utf8").trim();
      const parsedOwnerPid = Number(rawOwnerPid);
      if (Number.isInteger(parsedOwnerPid) && parsedOwnerPid > 0) {
        ownerPid = parsedOwnerPid;
      }
    } catch {}

    let ownerAlive = false;
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (ownerError) {
        ownerAlive = ownerError?.code === "EPERM";
      }
    }

    if (ownerAlive) {
      console.log(`PHASE7B_TELEGRAM_NOTIFIER_DUPLICATE=EXIT singleton=${singletonPath}`);
      process.exit(0);
    }

    try {
      fs.unlinkSync(singletonPath);
      console.log(`PHASE7B_TELEGRAM_NOTIFIER_STALE_LOCK=RECLAIMED singleton=${singletonPath}`);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
  }
}

if (singletonFd === undefined) {
  throw new Error(`Unable to acquire Telegram notifier singleton lock: ${singletonPath}`);
}

const releaseSingleton = () => {
  try {
    if (singletonFd !== undefined) fs.closeSync(singletonFd);
  } catch {}
  try {
    fs.unlinkSync(singletonPath);
  } catch {}
};
process.once("exit", releaseSingleton);
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
const symbol = process.env.ZIQ_TELEGRAM_SYMBOL ?? "XAUUSD";
const accountMode = normalizeAccountMode(
  process.env.ZIQ_PHASE7C_ACCOUNT_MODE ?? "DEMO",
);
const phaseBanner = `PHASE 7C · ${accountMode}`;
const intervalMs = Math.max(1000, Number(process.env.ZIQ_TELEGRAM_INTERVAL_MS ?? "2000"));
const tradeMessageThreadId = optionalNumber(
  process.env.ZIQ_TELEGRAM_TRADE_MESSAGE_THREAD_ID ??
    process.env.ZIQ_TELEGRAM_MESSAGE_THREAD_ID,
);
const controlMessageThreadId = optionalNumber(
  process.env.ZIQ_TELEGRAM_CONTROL_MESSAGE_THREAD_ID,
);
const monitorUrl = process.env.ZIQ_TELEGRAM_MONITOR_URL?.trim() ?? "";
const monitorApiBase = (process.env.ZIQ_TELEGRAM_MONITOR_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
const sendStartup = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_SEND_STARTUP ?? "true");
const replayExisting = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_REPLAY_EXISTING ?? "false");
const once = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_ONCE ?? "false");
const sendTest = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_SEND_TEST ?? "false");
const dryRun = /^(1|true|yes|on)$/i.test(process.env.ZIQ_TELEGRAM_DRY_RUN ?? "false");
const dryRunSinkPath = process.env.ZIQ_TELEGRAM_DRY_RUN_SINK?.trim() ?? "";
if (dryRun && !dryRunSinkPath) {
  throw new Error("ZIQ_TELEGRAM_DRY_RUN_SINK is required when ZIQ_TELEGRAM_DRY_RUN=true");
}

const interestingEvents = new Set([
  "ENTRY_SUBMIT",
  "ENTRY_FILLED",
  "ENTRY_REJECTED",
  "ENTRY_ACCEPTED_POSITION_NOT_RESOLVED",
  "PLUS6_SL_TO_ENTRY",
  "PLUS6_SL_REJECTED",
  "PLUS10_PARTIAL_ONE_THIRD",
  "PLUS10_PARTIAL_REJECTED",
  "STRUCTURAL_SL_TIGHTEN",
  "M5_STRUCTURAL_SL_TIGHTEN",
  "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN",
  "STRUCTURAL_SL_REJECTED",
  "FVG_HOLD_CONFIRMED",
  "HOLD_POSITION",
  "FVG_ADDON_SIGNAL_SHADOW",
  "EXIT_EXECUTED",
  "EXIT_REJECTED",
  "MANAGED_POSITION_CLOSED",
  "DEMO_GUARD_BLOCK",
  "UNMANAGED_POSITION_PRESENT",
  "UNEXPECTED_ADDITIONAL_POSITION",
  "CYCLE_ERROR",

  "TP1_PARTIAL_FILLED",
  "TP1_PARTIAL_REJECTED",
  "TP1_BREAK_EVEN_APPLIED",
  "TP1_BREAK_EVEN_REJECTED",
  "POSITION_CLOSED",
  "POSITION_CLOSE_REJECTED",]);

const sidewayLifecycleEvents = new Set([
  "ENTRY_SUBMIT",
  "ENTRY_FILLED",
  "ENTRY_REJECTED",
  "ENTRY_ACCEPTED_POSITION_NOT_RESOLVED",
  "MANAGED_POSITION_CLOSED",
  "HOLD_POSITION",
  "PLUS6_SL_TO_ENTRY",
  "PLUS6_SL_REJECTED",
  "PLUS10_PARTIAL_ONE_THIRD",
  "PLUS10_PARTIAL_REJECTED",
  "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN",

  // Legacy Sideway journal compatibility only. Current executor emits the
  // canonical +6/+10 event names above.
  "TP1_PARTIAL_FILLED",
  "TP1_PARTIAL_REJECTED",
  "TP1_BREAK_EVEN_APPLIED",
  "TP1_BREAK_EVEN_REJECTED",
  "POSITION_CLOSED",
  "POSITION_CLOSE_REJECTED",]);
const systemAlertTypes = new Set([
  "DEMO_GUARD_BLOCK",
  "UNMANAGED_POSITION_PRESENT",
  "UNEXPECTED_ADDITIONAL_POSITION",
  "CYCLE_ERROR",
]);

const systemRecoveryQuietMs = Math.max(
  30_000,
  Number(
    process.env.ZIQ_TELEGRAM_SYSTEM_RECOVERY_QUIET_MS ??
      "30000",
  ),
);

const requestedTransientMt5ReadAlertThreshold = Number(
  process.env.ZIQ_TELEGRAM_TRANSIENT_MT5_READ_ALERT_THRESHOLD ??
    DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD,
);
const transientMt5ReadAlertThreshold =
  Number.isFinite(requestedTransientMt5ReadAlertThreshold)
    ? Math.max(2, Math.trunc(requestedTransientMt5ReadAlertThreshold))
    : DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD;

const requestedTransientMt5ReadAlertWindowMs = Number(
  process.env.ZIQ_TELEGRAM_TRANSIENT_MT5_READ_ALERT_WINDOW_MS ??
    DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS,
);
const transientMt5ReadAlertWindowMs =
  Number.isFinite(requestedTransientMt5ReadAlertWindowMs)
    ? Math.max(15_000, Math.trunc(requestedTransientMt5ReadAlertWindowMs))
    : DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS;

let nextSystemHealthCheckAt = 0;

if (!fs.existsSync(trendJournalPath)) {
  fs.writeFileSync(trendJournalPath, "", "utf8");
}

const journalFeeds = [
  {
    key: "trend",
    source: "TREND",
    path: trendJournalPath,
  },
];

if (sidewayJournalPath) {
  if (fs.existsSync(sidewayJournalPath)) {
    journalFeeds.push({
      key: "sideway",
      source: "SIDEWAY",
      path: sidewayJournalPath,
    });
  } else {
    console.warn(
      `PHASE7B_TELEGRAM_SIDEWAY_JOURNAL_MISSING=${sidewayJournalPath}`,
    );
  }
}

let state = loadState();

if (sendTest) {
  await sendHtml([
    "🧪 <b>XAUUSD AI MASTER · TELEGRAM TEST</b>",
    "",
    `📊 <b>${esc(symbol)}</b> · ${phaseBanner}`,
    "✅ Kết nối Telegram thành công",
    "🔒 Notifier chỉ đọc journal/API monitor, không có quyền đặt lệnh",
  ].join("\n"));
  console.log("PHASE7B_TELEGRAM_TEST=PASS");
  process.exit(0);
}

if (!state.initialized) {
  state = {
    version: 2,
    initialized: true,
    offset: replayExisting ? 0 : fs.statSync(journalPath).size,
    sent: 0,
    lastEventAt: null,
    trade: null,
    hold: null,
    holdM15ByTicketReason: {},
    systemAlerts: {},
  };
  saveState();
  if (sendStartup) {
    await sendHtml([
      "🤖 <b>XAUUSD AI MASTER · TELEGRAM ONLINE</b>",
      "",
      `📊 <b>${esc(symbol)}</b> · ${phaseBanner}`,
      "🟢 Theo dõi Trade: Trend + Sideway · chờ entry hợp lệ",
      "🧩 FVG: xác nhận bổ sung, không bắt buộc entry",
      "🔒 Read-only notifier · không điều khiển MT5",
    ].join("\n"));
  }
}

state.offsets ??= {};
state.hold ??= null;
state.holdM15ByTicketReason ??= {};

if (!Number.isFinite(Number(state.offsets.trend))) {
  state.offsets.trend = Number.isFinite(Number(state.offset))
    ? Number(state.offset)
    : replayExisting
      ? 0
      : fs.statSync(trendJournalPath).size;
}

for (const feed of journalFeeds) {
  if (!Number.isFinite(Number(state.offsets[feed.key]))) {
    state.offsets[feed.key] = replayExisting
      ? 0
      : fs.statSync(feed.path).size;
  }
}

state.offset = Number(state.offsets.trend ?? 0);
state.version = 3;
saveState();
console.log("PHASE7B_TELEGRAM_NOTIFIER=RUNNING");
console.log(`PHASE7B_TELEGRAM_ACCOUNT_MODE=${accountMode}`);
console.log(`PHASE7B_TELEGRAM_PHASE_BANNER=${phaseBanner}`);
console.log(`PHASE7B_TELEGRAM_JOURNAL=${trendJournalPath}`);
console.log(
  `PHASE7B_TELEGRAM_SIDEWAY_JOURNAL=${
    sidewayJournalPath || "DISABLED"
  }`,
);
console.log(
  `PHASE7B_TELEGRAM_ACTIVE_FEEDS=${journalFeeds
    .map((feed) => feed.source)
    .join(",")}`,
);
console.log(`PHASE7B_TELEGRAM_STATE=${statePath}`);
console.log(`PHASE7B_TELEGRAM_INTERVAL_MS=${intervalMs}`);
console.log(`PHASE7B_TELEGRAM_MONITOR_API=${monitorApiBase}`);
console.log(`PHASE7B_TELEGRAM_DRY_RUN=${dryRun}`);
console.log("PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR");

while (true) {
  try {
    await poll();
    await reconcileSystemAlerts();
  } catch (error) {
    console.error(`PHASE7B_TELEGRAM_ERROR=${errorMessage(error)}`);
  }
  if (once) break;
  await sleep(intervalMs);
}

async function poll() {
  for (const feed of journalFeeds) {
    await pollJournalFeed(feed);
  }
}

async function pollJournalFeed(feed) {
  const stat = fs.statSync(feed.path);

  state.offsets ??= {};

  let offset =
    Number(state.offsets[feed.key] ?? 0);

  if (!Number.isFinite(offset) || offset < 0) {
    offset = replayExisting
      ? 0
      : stat.size;
  }

  if (stat.size < offset) {
    offset = 0;
  }

  if (stat.size === offset) {
    state.offsets[feed.key] = offset;

    if (feed.key === "trend") {
      state.offset = offset;
    }

    return;
  }

  const fd = fs.openSync(feed.path, "r");

  try {
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);

    fs.readSync(
      fd,
      buffer,
      0,
      length,
      offset,
    );

    const lastNewline =
      buffer.lastIndexOf(0x0a);

    if (lastNewline < 0) return;

    const complete =
      buffer.subarray(
        0,
        lastNewline + 1,
      );

    const lines =
      complete
        .toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    for (const rawLine of lines) {
      let rawEvent;

      try {
        rawEvent = JSON.parse(rawLine);
      } catch {
        continue;
      }

      const event =
        normalizeJournalEvent(
          rawEvent,
          feed,
        );

      const type =
        String(event.type ?? "");

      if (
        feed.source === "SIDEWAY" &&
        !sidewayLifecycleEvents.has(type)
      ) {
        continue;
      }

      if (!interestingEvents.has(type)) {
        continue;
      }

      const route =
        notificationRoute(type);

      if (
        route === "control" &&
        shouldSuppressSystemAlert(event)
      ) {
        continue;
      }

      if (
        isHoldEvent(event) &&
        shouldSuppressHold(event)
      ) {
        continue;
      }

      if (
        type === "FVG_ADDON_SIGNAL_SHADOW" &&
        shouldSuppressHoldAddon(event)
      ) {
        continue;
      }

      const enrichment =
        await buildEnrichment(event);

      const html =
        await formatEvent(
          event,
          enrichment,
        );

      if (!html) continue;

      await sendHtml(
        html,
        route,
        {
          includePhase:
            !isHoldEvent(event) &&
            ![
              "STRUCTURAL_SL_TIGHTEN",
              "M5_STRUCTURAL_SL_TIGHTEN",
              "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN",
            ].includes(type),
        },
      );

      if (route === "control") {
        markSystemAlert(event);
      }

      // HOLD becomes active only AFTER the Telegram send succeeded.
      if (isHoldEvent(event)) {
        markHold(event);
      }

      applyEventState(
        event,
        enrichment,
      );

      state.sent += 1;

      state.lastEventAt =
        String(
          event.timestamp ??
          new Date().toISOString(),
        );

      saveState();
    }

    offset += lastNewline + 1;

    state.offsets[feed.key] =
      offset;

    if (feed.key === "trend") {
      state.offset = offset;
    }

    saveState();
  } finally {
    fs.closeSync(fd);
  }
}
function normalizeJournalEvent(rawEvent, feed) {
  const canonicalType = String(
    rawEvent?.type ??
    rawEvent?.event ??
    "",
  );

  return {
    ...rawEvent,
    type: canonicalType,
    journalSource: feed.source,
  };
}
async function buildEnrichment(event) {
  const type =
    String(event.type ?? "");

  const needsLive = [
    "PLUS6_SL_TO_ENTRY",
    "PLUS10_PARTIAL_ONE_THIRD",
    "STRUCTURAL_SL_TIGHTEN",
    "FVG_HOLD_CONFIRMED",
    "FVG_ADDON_SIGNAL_SHADOW",
    "TP1_PARTIAL_FILLED",
    "TP1_BREAK_EVEN_APPLIED",
  ].includes(type);

  const live =
    needsLive
      ? await getDemoSnapshot()
      : null;

  const metrics =
    live
      ? liveMetrics(live, event)
      : fallbackMetrics(event);

  let closedTrade = null;
  let dailyRecoveryAfterClose = null;
  let canonicalRealized = null;

  const isCloseEvent = [
    "EXIT_EXECUTED",
    "MANAGED_POSITION_CLOSED",
    "POSITION_CLOSED",
  ].includes(type);

  if (isCloseEvent) {
    closedTrade =
      await findClosedTradeWithRetry(event);

    canonicalRealized =
      await getCanonicalRealizedPositionWithRetry(event);

    if (
      isRecoveryContext(event) &&
      Number(canonicalRealized?.dealCount) > 0
    ) {
      const previewVolume =
        numberOrNull(
          state.trade?.initialVolume,
        ) ??
        numberOrNull(
          event?.lastKnownState?.initialVolume,
        ) ??
        numberOrNull(
          event?.management?.initialVolume,
        ) ??
        0.03;

      dailyRecoveryAfterClose =
        await getDailyRecoverySnapshotWithRetry(
          previewVolume,
        );
    }
  } else if (
    type === "PLUS10_PARTIAL_ONE_THIRD" ||
    type === "TP1_PARTIAL_FILLED"
  ) {
    canonicalRealized =
      await getCanonicalRealizedPositionWithRetry(event);
  }

  return {
    live,
    metrics,
    closedTrade,
    canonicalRealized,
    dailyRecoveryAfterClose,
  };
}
async function formatEvent(event, enrichment) {
  const type =
    String(event.type ?? "");

  const time =
    telegramTime(event.timestamp);

  if (type === "ENTRY_SUBMIT") {
    const side =
      normalizeSide(event.side);

    const recovery =
      recoveryMetadata(event);

    const isSideway =
      event.journalSource === "SIDEWAY";
    const entryPolicy = String(event.entryPolicy ?? "").trim().toUpperCase();
    const isReversal =
      !isSideway &&
      (
        entryPolicy.startsWith("REVERSAL_") ||
        Boolean(event.reversalContext)
      );

    const entry =
      event.marketEntry ??
      event.signalEntry ??
      event.plan?.entry;

    const stopLoss =
      event.stopLoss ??
      event.plan?.stopLoss;

    const stopDistance =
      event.stopDistance ??
      event.plan?.stopDistance;

    if (recovery.active) {
      return fullCard(
        "🛟",
        `🟡 DAILY RECOVERY ${side} PENDING · ${symbol} · CHỜ MT5 XÁC NHẬN`,
        [
          line(
            "⏱",
            isSideway ? "M5" : "M15",
            time,
          ),
          line(
            "🤖",
            "Regime",
            isSideway
              ? "SIDEWAY"
              : isReversal
                ? "REVERSAL"
                : "TREND",
          ),
          line(
            "🧠",
            isSideway
              ? "Confirmation"
              : "Pattern",
            event.confirmation ??
              event.pattern,
          ),
          line("🎯", "Entry", entry),
          line(
            "🛡",
            "SL",
            `${fmtPrice(stopLoss)} · ${fmtSignedPrice(
              -Math.abs(
                Number(stopDistance ?? 0),
              ),
            )} giá`,
          ),
          line(
            "📦",
            "Volume",
            `${value(event.volume)} lot`,
          ),
          line(
            "💵",
            "Daily P/L",
            fmtMoney(
              recovery.dailyNetPnl,
              true,
            ),
          ),
          line(
            "🎯",
            "Recovery TP",
            `${fmtPrice(
              recovery.takeProfit,
            )} · ${fmtSignedPrice(
              recovery.tpDistance,
            )} giá`,
          ),
          line(
            "📈",
            "Target ngày",
            `+${value(
              recovery.targetNetPnl ?? 1,
            )} USD net`,
          ),
          "",
          "🔒 <b>Lot escalation OFF</b> · martingale OFF · không force entry.",
        ],
      );
    }

    if (isSideway) {
      return fullCard(
        sideIcon(side),
        `🟡 ${side} SIDEWAY PENDING · ${symbol} · CHỜ MT5 XÁC NHẬN`,
        [
          line("⏱", "M5", time),
          line(
            "🧠",
            "Confirmation",
            event.confirmation,
          ),
          line("🎯", "Entry", entry),
          line(
            "🛡",
            "SL",
            fmtPrice(stopLoss),
          ),
          line(
            "📦",
            "Volume",
            `${value(event.volume)} lot`,
          ),
          line(
            "1️⃣",
            "TP1",
            event.plan?.tp1,
          ),
          line(
            "2️⃣",
            "TP2",
            event.plan?.takeProfit,
          ),
        ],
      );
    }

    return fullCard(
      sideIcon(side),
      `🟡 ${side} PENDING · ${symbol} · CHỜ MT5 XÁC NHẬN`,
      [
        line("⏱", "M15", time),
        line(
          "🧠",
          "Pattern",
          event.pattern,
        ),
        line("🎯", "Entry", entry),
        line(
          "🛡",
          "SL",
          `${fmtPrice(stopLoss)} · ${fmtSignedPrice(
            -Math.abs(
              Number(stopDistance ?? 0),
            ),
          )} giá`,
        ),
        line(
          "📦",
          "Volume",
          `${value(event.volume)} lot`,
        ),
        line(
          "🧩",
          "FVG",
          event.fvgConfirmedAtEntry
            ? "CONFIRMED"
            : "OPTIONAL",
        ),
      ],
    );
  }

  if (type === "ENTRY_FILLED") {
    const position =
      event.position ?? {};

    const side =
      position.side === "LONG"
        ? "BUY"
        : position.side === "SHORT"
          ? "SELL"
          : normalizeSide(event.side);

    const entry =
      firstPositiveNumber(
        position.entry,
        event.fillPrice,
        event.management?.entry,
        event.lastKnownState?.entry,
      );

    const sl =
      firstPositiveNumber(
        position.stopLoss,
        event.stopLoss,
        event.management?.stopLoss,
        event.lastKnownState?.stopLoss,
      );

    const entryVolume =
      firstPositiveNumber(
        position.volume,
        event.volume,
        event.management?.expectedRemainingVolume,
        event.management?.initialVolume,
        event.lastKnownState?.expectedRemainingVolume,
        event.lastKnownState?.initialVolume,
      );

    const slDistance =
      entry !== null &&
      sl !== null
        ? sidePriceMove(
            side,
            entry,
            sl,
          )
        : null;

    const recovery =
      recoveryMetadata(event);

    const isSideway =
      event.journalSource === "SIDEWAY";
    const entryPolicy = String(event.entryPolicy ?? "").trim().toUpperCase();
    const isReversal =
      !isSideway &&
      (
        entryPolicy.startsWith("REVERSAL_") ||
        Boolean(event.reversalContext)
      );

    if (recovery.active) {
      return fullCard(
        side === "BUY"
          ? "✅🛟🟢"
          : "✅🛟🔴",
        `DAILY RECOVERY ${side} FILLED · ${symbol}`,
        [
          line(
            "🤖",
            "Regime",
            isSideway
              ? "SIDEWAY"
              : isReversal
                ? "REVERSAL"
                : "TREND",
          ),
          line(
            "🎫",
            "Ticket",
            position.ticket ?? event.ticket,
          ),
          line(
            "💵",
            "Entry",
            fmtPrice(entry),
          ),
          line(
            "📦",
            "Lot",
            `${value(
              entryVolume,
            )} lot`,
          ),
          line(
            "🛡",
            "SL",
            `${fmtPrice(sl)} · ${fmtSignedPrice(
              slDistance,
            )} giá`,
          ),
          line(
            "💵",
            "Daily P/L lúc vào",
            fmtMoney(
              recovery.dailyNetPnl,
              true,
            ),
          ),
          line(
            "🎯",
            "Recovery TP",
            `${fmtPrice(
              recovery.takeProfit,
            )} · ${fmtSignedPrice(
              recovery.tpDistance,
            )} giá`,
          ),
          "",
          isSideway
            ? "<b>Rule:</b> +6 → BE · full-position Recovery TP · không +10 partial."
            : "<b>Rule:</b> +6 → BE · full-position Recovery TP · không +10 partial/runner.",
          "🔒 <b>Lot escalation OFF</b> · martingale OFF.",
        ],
      );
    }

    if (isSideway) {
      return fullCard(
        side === "BUY"
          ? "✅🟢"
          : "✅🔴",
        `${side} SIDEWAY FILLED · ${symbol}`,
        [
          line("🤖", "Regime", "SIDEWAY"),
          line(
            "🎫",
            "Ticket",
            position.ticket ?? event.ticket,
          ),
          line(
            "💵",
            "Entry",
            fmtPrice(entry),
          ),
          line(
            "📦",
            "Lot",
            `${value(
              entryVolume,
            )} lot`,
          ),
          line(
            "🛡",
            "SL",
            fmtPrice(sl),
          ),
          line(
            "1️⃣",
            "TP1",
            event.management?.tp1,
          ),
          line(
            "2️⃣",
            "TP2",
            fmtPrice(event.management?.tp2),
          ),
          "",
          "<b>Rule:</b> +6 → BE · +10 → chốt 1/3 · giữ 2/3 với SL không dưới BE · TP2 biên đối diện.",
        ],
      );
    }

    return fullCard(
      side === "BUY"
        ? "✅🟢"
        : "✅🔴",
      `${side} FILLED · ${symbol}`,
      [
        line("🤖", "Regime", isReversal ? "REVERSAL" : "TREND"),
        line(
          "🎫",
          "Ticket",
          position.ticket ?? event.ticket,
        ),
        line(
          "💵",
          "Entry",
          fmtPrice(entry),
        ),
        line(
          "📦",
          "Lot",
          `${value(
            position.volume,
          )} lot`,
        ),
        line(
          "🛡",
          "SL",
          `${fmtPrice(sl)} · ${fmtSignedPrice(
            slDistance,
          )} giá`,
        ),
        line("🎯", "TP", "RUNNER M15"),
        line(
          "🧩",
          "FVG",
          event.fvgConfirmedAtEntry
            ? "YES"
            : "NO · vẫn hợp lệ",
        ),
        "",
        "<b>Rule:</b> +6 → BE · +10 → chốt 1/3 · runner swing M15",
      ],
    );
  }

  if (type === "PLUS6_SL_TO_ENTRY") {
    const side =
      currentSide(
        event,
        enrichment,
      );

    const m = enrichment.metrics;

    return compactTradeCard(
      "🛡",
      side,
      "+6 → BE",
      [
        ...lifecycleContextLines(event, enrichment),
        compactStats(m),
        `🔒 <b>SL:</b> <code>${fmtPrice(
          m.stopLoss,
        )}</code> · khóa <code>${fmtSignedPrice(
          m.slPriceMove,
        )} giá</code> · <code>${fmtMoney(
          m.lockedPnlUsd,
          true,
        )}</code>`,
      ],
    );
  }

  if (type === "PLUS10_PARTIAL_ONE_THIRD") {
    const side =
      currentSide(
        event,
        enrichment,
      );

    const m = enrichment.metrics;
    const realizedDeal =
      matchCanonicalRealizedDeal(
        enrichment.canonicalRealized,
        event,
      );

    return compactTradeCard(
      "💰",
      side,
      "CHỐT 1/3",
      [
        ...lifecycleContextLines(event, enrichment),
        `📈 <b>Chốt tại:</b> <code>${fmtSignedPrice(
          numberOrNull(event.favorable),
        )} giá</code> · <b>Realized P&L:</b> <code>${
          realizedDeal
            ? fmtMoney(
                realizedDeal.netPnl,
                true,
              )
            : "đang chờ MT5 deal"
        }</code>`,
        `📤 <b>Đóng:</b> <code>${value(
          event.closedVolume,
        )} lot</code> · còn <code>${value(
          event.remainingVolume,
        )} lot</code>`,
        `🛡 <b>SL:</b> <code>${fmtPrice(
          m.stopLoss,
        )}</code> · khóa <code>${fmtSignedPrice(
          m.slPriceMove,
        )} giá</code> · <code>${fmtMoney(
          m.lockedPnlUsd,
          true,
        )}</code>`,
        m.profitUsd === null
          ? ""
          : `💵 <b>P&L runner:</b> <code>${fmtMoney(
              m.profitUsd,
              true,
            )}</code>`,
      ].filter(Boolean),
    );
  }

  if (type === "TP1_PARTIAL_FILLED") {
    const side =
      currentSide(
        event,
        enrichment,
      );

    return compactTradeCard(
      "💰",
      side,
      "SIDEWAY TP1 · CHỐT 1/3",
      [
        ...lifecycleContextLines(event, enrichment),
        `🎯 <b>TP1:</b> <code>${fmtPrice(
          event.tp1,
        )}</code> · ${esc(
          String(
            event.tp1Kind ?? "TARGET",
          ),
        )}`,
        `📤 <b>Đóng:</b> <code>${value(
          event.closedVolume,
        )} lot</code> · còn <code>${value(
          event.remainingVolume,
        )} lot</code>`,
        `💵 <b>Giá:</b> <code>${fmtPrice(
          event.marketPrice,
        )}</code>`,
      ],
    );
  }

  if (type === "TP1_BREAK_EVEN_APPLIED") {
    const side =
      currentSide(
        event,
        enrichment,
      );

    return compactTradeCard(
      "🛡",
      side,
      "SIDEWAY · BREAK EVEN",
      [
        ...lifecycleContextLines(event, enrichment),
        `🔒 <b>SL:</b> <code>${fmtPrice(
          event.stopLoss,
        )}</code> · đã đưa về Entry.`,
      ],
    );
  }

  if (isHoldEvent(event)) {
    const side =
      currentSide(
        event,
        enrichment,
      );

    const canonical =
      canonicalHoldReason(
        event.journalSource,
        {
          dailyMode:
            event.dailyMode ??
            state.trade?.dailyMode ??
            null,
        },
      );

    const reason =
      String(
        event.reason ??
        canonical?.reason ??
        "",
      ).trim();

    if (!reason) return null;

    const ticket = String(
      event.ticket ??
      event.position?.ticket ??
      "",
    ).trim();

    if (!ticket) return null;

    const sideMarker = side === "BUY" ? "🟢" : "🔴";

    return [
      `🧩 ${sideMarker} <b>${esc(side)} · HOLD</b>`,
      `🎫 <b>Ticket:</b> <code>${esc(ticket)}</code>`,
      `🧾 <b>${esc(reason)}</b>`,
    ].join("\n");
  }

  if (
    [
      "STRUCTURAL_SL_TIGHTEN",
      "M5_STRUCTURAL_SL_TIGHTEN",
      "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN",
    ].includes(type)
  ) {
    const side =
      currentSide(
        event,
        enrichment,
      );

    const ticket = String(
      event.ticket ??
      event.position?.ticket ??
      "",
    ).trim();
    const previousStopLoss = firstPositiveNumber(event.previousStopLoss);
    const newStopLoss = firstPositiveNumber(event.stopLoss, enrichment.metrics?.stopLoss);

    if (!ticket || previousStopLoss === null || newStopLoss === null) return null;

    const isM5 = type !== "STRUCTURAL_SL_TIGHTEN";
    const sideMarker = side === "BUY" ? "🟢" : "🔴";

    return [
      `🛡 ${sideMarker} <b>${esc(side)} · ${isM5 ? "SL → STRUCTURE M5" : "SL → STRUCTURE"}</b>`,
      `🎫 <b>Ticket:</b> <code>${esc(ticket)}</code>`,
      `🛡 <b>SL:</b> <code>${fmtPrice(previousStopLoss)} → ${fmtPrice(newStopLoss)}</code>`,
      `🧾 <b>${isM5 ? "Dời StopLoss theo cấu trúc M5 đã xác nhận." : "Dời StopLoss theo cấu trúc đã xác nhận."}</b>`,
    ].join("\n");
  }

  if (type === "FVG_ADDON_SIGNAL_SHADOW") {
    const side =
      currentSide(
        event,
        enrichment,
      );

    const m = enrichment.metrics;

    return compactTradeCard(
      "👀",
      side,
      "ADD-ON SHADOW",
      [
        compactStats(m),
        "⚠️ Chỉ ghi nhận tín hiệu · <b>không mở thêm lot</b>.",
      ],
    );
  }

  if (
    [
      "EXIT_EXECUTED",
      "MANAGED_POSITION_CLOSED",
      "POSITION_CLOSED",
    ].includes(type)
  ) {
    const closed =
      enrichment.closedTrade;

    const side =
      normalizeSide(
        closed?.side ??
        state.trade?.side ??
        event.side,
      );

    const canonicalDealCount =
      numberOrNull(
        enrichment.canonicalRealized?.dealCount,
      );

    const pnl =
      canonicalDealCount !== null &&
      canonicalDealCount > 0
        ? numberOrNull(
            enrichment.canonicalRealized?.realizedNetPnl,
          )
        : null;

    const averageMove =
      closed
        ? sidePriceMove(
            side,
            Number(closed.entry),
            Number(closed.exit),
          )
        : null;

    const reason =
      type === "EXIT_EXECUTED" ||
      type === "POSITION_CLOSED"
        ? event.reason
        : "MT5 / SL đóng position";

    const wasRecovery =
      isRecoveryContext(event);

    if (wasRecovery) {
      const daily =
        enrichment.dailyRecoveryAfterClose;

      const canonicalCloseSynchronized =
        canonicalDealCount !== null &&
        canonicalDealCount > 0;

      const dailyPnl =
        canonicalCloseSynchronized
          ? numberOrNull(
              daily?.dailyNetPnl,
            )
          : null;

      const completed =
        canonicalCloseSynchronized &&
        (dailyPnl !== null
          ? dailyPnl >= 0
          : daily?.dailyMode === "NORMAL");

      return compactTradeCard(
        completed
          ? "✅🛟"
          : "🛟",
        side,
        completed
          ? "DAILY RECOVERY COMPLETED"
          : "RECOVERY TRADE CLOSED",
        [
          ...lifecycleContextLines(event, enrichment),
          pnl !== null
            ? `💵 <b>P&L lệnh:</b> <code>${fmtMoney(
                pnl,
                true,
              )}</code>`
            : "💵 <b>P&L lệnh:</b> <code>đang đồng bộ MT5 deal canonical</code>",
          !canonicalCloseSynchronized
            ? "📅 <b>Daily P/L sau đóng:</b> <code>đang đồng bộ MT5 deal canonical</code>"
            : dailyPnl === null
              ? "📅 <b>Daily P/L sau đóng:</b> <code>chưa đọc được</code>"
              : `📅 <b>Daily P/L sau đóng:</b> <code>${fmtMoney(
                  dailyPnl,
                  true,
                )}</code>`,
          closed
            ? `🎯 <b>Exit TB:</b> <code>${fmtPrice(
                closed.exit,
              )}</code>`
            : "",
          `🧠 <b>Lý do:</b> ${esc(
            reasonLabel(reason),
          )}`,
          "",
          completed
            ? "✅ Daily Recovery kết thúc · lệnh kế tiếp trở về native theo regime."
            : "🟠 Daily Recovery vẫn còn hiệu lực cho lệnh hợp lệ kế tiếp · không tăng lot.",
        ].filter(Boolean),
      );
    }

    const icon =
      pnl !== null &&
      pnl < 0
        ? "🛑"
        : "🏁";

    return compactTradeCard(
      icon,
      side,
      pnl !== null &&
      pnl < 0
        ? "CLOSED / STOP"
        : "CHỐT LỆNH",
      [
        ...lifecycleContextLines(event, enrichment),
        pnl !== null
          ? `💵 <b>P&L tổng:</b> <code>${fmtMoney(
              pnl,
              true,
            )}</code>`
          : "💵 <b>P&L:</b> <code>đang đồng bộ MT5 deal canonical</code>",
        closed
          ? `📈 <b>Biến động TB:</b> <code>${fmtSignedPrice(
              averageMove,
            )} giá</code>`
          : "",
        closed
          ? `🎯 <b>Exit TB:</b> <code>${fmtPrice(
              closed.exit,
            )}</code>`
          : "",
        `🧠 <b>Lý do:</b> ${esc(
          reasonLabel(reason),
        )}`,
      ].filter(Boolean),
    );
  }

  if (type === "ENTRY_REJECTED") {
    return warningCard(
      "⛔ ENTRY · KHÔNG VÀO MT5",
      event.reason ??
        event.message ??
        event.response?.reason ??
        event.response?.message ??
        event.response?.detail?.reason ??
        "ENTRY_REJECTED",
      event.response?.status ??
        event.status ??
        event.response?.retcode ??
        event.retcode,
    );
  }

  if (type === "ENTRY_ACCEPTED_POSITION_NOT_RESOLVED") {
    return warningCard(
      "⚠️ ENTRY",
      event.message ??
        "Position chưa resolve",
      event.retcode,
    );
  }

  if (type.endsWith("_REJECTED")) {
    return warningCard(
      "⚠️ ACTION REJECTED",
      event.message ??
        event.response?.message ??
        type,
      event.response?.retcode ??
        event.retcode,
    );
  }

  if (
    [
      "DEMO_GUARD_BLOCK",
      "UNMANAGED_POSITION_PRESENT",
      "UNEXPECTED_ADDITIONAL_POSITION",
      "CYCLE_ERROR",
    ].includes(type)
  ) {
    return warningCard(
      "🚨 SYSTEM",
      event.message ??
        event.reason ??
        type,
      null,
    );
  }

  return null;
}
function recoveryMetadata(event) {
  const management =
    event?.management ??
    event?.lastKnownState ??
    {};

  const dailyMode =
    String(
      event?.dailyMode ??
      management?.dailyMode ??
      state.trade?.dailyMode ??
      "",
    ).toUpperCase();

  return {
    active:
      dailyMode === "RECOVERY_TP",

    dailyMode,

    dailyNetPnl:
      numberOrNull(
        event?.dailyNetPnlAtEntry ??
        event?.dailyNetPnl ??
        management?.dailyNetPnlAtEntry ??
        state.trade?.dailyNetPnlAtEntry,
      ),

    targetNetPnl:
      numberOrNull(
        event?.recoveryTargetNetPnl ??
        management?.recoveryTargetNetPnl ??
        state.trade?.recoveryTargetNetPnl,
      ),

    tpDistance:
      numberOrNull(
        event?.recoveryTpDistance ??
        management?.recoveryTpDistance ??
        state.trade?.recoveryTpDistance,
      ),

    takeProfit:
      firstPositiveNumber(
        event?.recoveryTakeProfit,
        management?.recoveryTakeProfit,
        management?.tp2,
        event?.plan?.takeProfit,
        state.trade?.recoveryTakeProfit,
        state.trade?.takeProfit,
      ),
  };
}

function isRecoveryContext(event) {
  return recoveryMetadata(event).active;
}

function isHoldEvent(event) {
  const type =
    String(event?.type ?? "");

  return (
    type === "FVG_HOLD_CONFIRMED" ||
    type === "HOLD_POSITION"
  );
}

function holdReasonCode(event) {
  const canonical =
    canonicalHoldReason(
      event?.journalSource,
      {
        dailyMode:
          event?.dailyMode ??
          state.trade?.dailyMode ??
          null,
      },
    );

  return String(
    event?.reasonCode ??
    canonical?.reasonCode ??
    "",
  );
}

function holdM15CloseTime(event) {
  const explicit = Number(event?.m15CloseTime);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  const timestampMs = Date.parse(String(event?.timestamp ?? ""));
  if (Number.isFinite(timestampMs)) {
    return Math.floor(timestampMs / (15 * 60_000)) * (15 * 60_000);
  }

  return 0;
}

function holdKey(event) {
  const ticket =
    String(
      event?.ticket ??
      state.trade?.ticket ??
      "",
    );

  return `${ticket}|${holdReasonCode(event)}`;
}

function holdM15Key(event) {
  return `${holdKey(event)}|${holdM15CloseTime(event)}`;
}

function shouldSuppressHold(event) {
  const key = holdKey(event);
  const m15CloseTime = holdM15CloseTime(event);

  state.holdM15ByTicketReason ??= {};

  if (
    m15CloseTime > 0 &&
    Number(state.holdM15ByTicketReason[key]) === m15CloseTime
  ) {
    if (state.hold?.key === key) {
      state.hold.lastSeenAt =
        String(
          event?.timestamp ??
          new Date().toISOString(),
        );
      state.hold.lastM15CloseTime = m15CloseTime;
      state.hold.m15Key = holdM15Key(event);
    }

    saveState();
    return true;
  }

  return false;
}

function shouldSuppressHoldAddon(event) {
  if (
    state.hold?.active !== true
  ) {
    return false;
  }

  const ticket =
    String(
      event?.ticket ??
      state.trade?.ticket ??
      "",
    );

  return (
    ticket !== "" &&
    ticket ===
      String(
        state.hold?.ticket ?? "",
      )
  );
}

function markHold(event) {
  const key = holdKey(event);
  const m15CloseTime = holdM15CloseTime(event);
  const reasonCode = holdReasonCode(event);
  const confirmedAt =
    String(
      event?.timestamp ??
      new Date().toISOString(),
    );

  state.holdM15ByTicketReason ??= {};
  if (m15CloseTime > 0) {
    state.holdM15ByTicketReason[key] = m15CloseTime;
  }

  state.hold = {
    active: true,
    key,
    m15Key: holdM15Key(event),
    reasonCode,
    ticket:
      String(
        event?.ticket ??
        state.trade?.ticket ??
        "",
      ),
    side:
      normalizeSide(
        event?.side ??
        state.trade?.side,
      ),
    confirmedAt,
    lastSeenAt: confirmedAt,
    lastM15CloseTime:
      m15CloseTime > 0
        ? m15CloseTime
        : null,
  };
}

function releaseHold(reason) {
  if (
    !state.hold ||
    state.hold.active !== true
  ) {
    return;
  }

  state.hold = {
    ...state.hold,
    active: false,
    releasedAt:
      new Date().toISOString(),
    releaseReason:
      String(
        reason ??
        "STATE_TRANSITION",
      ),
  };
}
function notificationRoute(type) {
  return systemAlertTypes.has(String(type ?? ""))
    ? "control"
    : "trade";
}

function systemAlertKey(event) {
  const type = String(event?.type ?? "");

  if (type === "CYCLE_ERROR") {
    return isMt5CycleErrorEvent(event)
      ? "CYCLE_ERROR"
      : "CYCLE_ERROR_RUNTIME";
  }

  return type;
}

function shouldSuppressSystemAlert(event) {
  const key = systemAlertKey(event);
  state.systemAlerts ??= {};

  const current = state.systemAlerts[key];
  if (current?.active) {
    current.lastSeenAt = String(
      event?.timestamp ?? new Date().toISOString(),
    );
    current.lastSeenAtMs = Date.now();
    current.message = String(
      event?.message ??
        event?.reason ??
        event?.type ??
        current.message ??
        "",
    );

    saveState();
    return true;
  }

  const transientRead = evaluateTransientSystemAlertDebounce({
    event,
    current,
    nowMs: Date.now(),
    threshold: transientMt5ReadAlertThreshold,
    windowMs: transientMt5ReadAlertWindowMs,
  });

  if (transientRead.matched) {
    state.systemAlerts[key] = transientRead.next;
    saveState();

    if (transientRead.suppress) {
      console.warn(
        `PHASE7B_TELEGRAM_TRANSIENT_MT5_READ_SUPPRESSED=count=${transientRead.count}|threshold=${transientMt5ReadAlertThreshold}`,
      );
      return true;
    }

    console.warn(
      `PHASE7B_TELEGRAM_TRANSIENT_MT5_READ_ESCALATED=count=${transientRead.count}|threshold=${transientMt5ReadAlertThreshold}`,
    );
  }

  return false;
}

function markSystemAlert(event) {
  const key = systemAlertKey(event);
  state.systemAlerts ??= {};

  state.systemAlerts[key] = {
    active: true,
    type: String(event?.type ?? ""),
    message: String(
      event?.message ??
        event?.reason ??
        event?.type ??
        "",
    ),
    startedAt: String(
      event?.timestamp ?? new Date().toISOString(),
    ),
    lastSeenAt: String(
      event?.timestamp ?? new Date().toISOString(),
    ),
    lastSeenAtMs: Date.now(),
  };
}

async function reconcileSystemAlerts() {
  state.systemAlerts ??= {};

  const legacyCycleError = state.systemAlerts.CYCLE_ERROR;
  if (
    legacyCycleError?.active &&
    !isMt5CycleErrorEvent({
      type: "CYCLE_ERROR",
      message: legacyCycleError.message,
    })
  ) {
    state.systemAlerts.CYCLE_ERROR_RUNTIME = {
      ...legacyCycleError,
      type: "CYCLE_ERROR",
    };
    delete state.systemAlerts.CYCLE_ERROR;
    saveState();
  }

  const activeKeys = Object.keys(state.systemAlerts).filter(
    (key) => state.systemAlerts[key]?.active,
  );

  if (activeKeys.length === 0) return;

  const now = Date.now();
  if (now < nextSystemHealthCheckAt) return;
  nextSystemHealthCheckAt = now + 10_000;

  const snapshot = await getDemoSnapshot();
  if (!snapshot) return;

  const mt5 = snapshot?.mt5 ?? {};
  const health = mt5?.health ?? {};
  const positions = Array.isArray(mt5?.positions)
    ? mt5.positions
    : [];

  const demoGuardHealthy =
    mt5?.reachable === true &&
    health?.accountMode === "demo" &&
    health?.connected === true &&
    health?.tradingEnabled === true &&
    health?.terminalTradeAllowed === true &&
    health?.expertTradeAllowed === true;

  const alertLastSeenMs = (key) => {
    const alert = state.systemAlerts[key];
    const numeric = Number(alert?.lastSeenAtMs);

    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const parsed = Date.parse(
      String(alert?.lastSeenAt ?? alert?.startedAt ?? ""),
    );

    return Number.isFinite(parsed) ? parsed : now;
  };

  const quietEnough = (key) =>
    now - alertLastSeenMs(key) >= systemRecoveryQuietMs;

  let silentStateChanged = false;
  if (
    state.systemAlerts.CYCLE_ERROR_RUNTIME?.active &&
    quietEnough("CYCLE_ERROR_RUNTIME")
  ) {
    delete state.systemAlerts.CYCLE_ERROR_RUNTIME;
    silentStateChanged = true;
  }

  const recovered = [];

  if (
    state.systemAlerts.DEMO_GUARD_BLOCK?.active &&
    quietEnough("DEMO_GUARD_BLOCK") &&
    demoGuardHealthy
  ) {
    recovered.push([
      "DEMO_GUARD_BLOCK",
      "DEMO GUARD đã hoạt động bình thường trở lại",
    ]);
  }

  if (
    state.systemAlerts.CYCLE_ERROR?.active &&
    quietEnough("CYCLE_ERROR") &&
    mt5?.reachable === true
  ) {
    recovered.push([
      "CYCLE_ERROR",
      "Kết nối dữ liệu / MT5 đã phục hồi",
    ]);
  }

  if (
    state.systemAlerts.UNMANAGED_POSITION_PRESENT?.active &&
    quietEnough("UNMANAGED_POSITION_PRESENT") &&
    (positions.length === 0 || Boolean(mt5?.managedPosition))
  ) {
    recovered.push([
      "UNMANAGED_POSITION_PRESENT",
      "Không còn position ngoài quyền quản lý",
    ]);
  }

  if (
    state.systemAlerts.UNEXPECTED_ADDITIONAL_POSITION?.active &&
    quietEnough("UNEXPECTED_ADDITIONAL_POSITION") &&
    positions.length <= 1
  ) {
    recovered.push([
      "UNEXPECTED_ADDITIONAL_POSITION",
      "Số lượng position đã trở lại bình thường",
    ]);
  }

  if (recovered.length === 0) {
    if (silentStateChanged) saveState();
    return;
  }

  for (const [key, message] of recovered) {
    await sendHtml(
      [
        "✅ <b>🔔 SYSTEM RECOVERED</b>",
        "<b>" + esc(message) + "</b>",
      ].join("\n"),
      "control",
    );

    delete state.systemAlerts[key];
    state.sent += 1;
    state.lastEventAt = new Date().toISOString();
  }

  saveState();
}

function applyEventState(event, enrichment) {
  const type =
    String(event.type ?? "");

  if (type === "ENTRY_FILLED") {
    const position =
      event.position ?? {};

    const side =
      position.side === "LONG"
        ? "BUY"
        : position.side === "SHORT"
          ? "SELL"
          : normalizeSide(
              event.side,
            );

    const recovery =
      recoveryMetadata(event);

    state.trade = {
      ticket:
        String(
          position.ticket ??
          event.ticket ??
          "",
        ),

      source:
        String(
          event.journalSource ??
          "TREND",
        ),

      side,

      entry:
        firstPositiveNumber(
          position.entry,
          event.fillPrice,
          event.management?.entry,
          event.lastKnownState?.entry,
          enrichment.metrics?.entry,
        ),

      initialVolume:
        firstPositiveNumber(
          position.volume,
          event.volume,
          event.management?.initialVolume,
          event.management?.expectedRemainingVolume,
          event.lastKnownState?.initialVolume,
          enrichment.metrics?.volume,
        ),

      remainingVolume:
        firstPositiveNumber(
          position.volume,
          event.volume,
          event.management?.expectedRemainingVolume,
          event.management?.initialVolume,
          event.lastKnownState?.expectedRemainingVolume,
          enrichment.metrics?.volume,
        ),

      stopLoss:
        firstPositiveNumber(
          position.stopLoss,
          event.stopLoss,
          event.management?.stopLoss,
          event.lastKnownState?.stopLoss,
          enrichment.metrics?.stopLoss,
        ),

      takeProfit:
        recovery.active
          ? recovery.takeProfit
          : event.journalSource === "SIDEWAY"
            ? firstPositiveNumber(
                event.management?.tp2,
                position.takeProfit,
                event.lastKnownState?.tp2,
              )
            : null,

      openedAt:
        Date.parse(
          String(
            event.timestamp ??
            new Date().toISOString(),
          ),
        ),

      dailyMode:
        recovery.dailyMode ||
        null,

      dailyNetPnlAtEntry:
        recovery.dailyNetPnl,

      recoveryTargetNetPnl:
        recovery.targetNetPnl,

      recoveryTpDistance:
        recovery.tpDistance,

      recoveryTakeProfit:
        recovery.takeProfit,
    };

    releaseHold(
      "NEW_POSITION_FILLED",
    );

    return;
  }

  if (
    [
      "PLUS6_SL_TO_ENTRY",
      "PLUS10_PARTIAL_ONE_THIRD",
      "STRUCTURAL_SL_TIGHTEN",
      "TP1_PARTIAL_FILLED",
      "TP1_BREAK_EVEN_APPLIED",
    ].includes(type)
  ) {
    releaseHold(type);
  }

  if (!state.trade) {
    return;
  }

  const contextEntry =
    firstPositiveNumber(
      event.position?.entry,
      event.fillPrice,
      enrichment.metrics?.entry,
      event.management?.entry,
      event.lastKnownState?.entry,
    );
  if (contextEntry !== null) {
    state.trade.entry = contextEntry;
  }

  const contextStopLoss =
    firstPositiveNumber(
      event.stopLoss,
      event.position?.stopLoss,
      enrichment.metrics?.stopLoss,
      event.management?.stopLoss,
      event.lastKnownState?.stopLoss,
    );
  if (contextStopLoss !== null) {
    state.trade.stopLoss = contextStopLoss;
  }

  const contextVolume =
    firstPositiveNumber(
      event.remainingVolume,
      event.position?.volume,
      enrichment.metrics?.volume,
      event.management?.expectedRemainingVolume,
      event.lastKnownState?.expectedRemainingVolume,
      state.trade.remainingVolume,
      state.trade.initialVolume,
    );
  if (contextVolume !== null) {
    state.trade.remainingVolume = contextVolume;
  }

  const contextTakeProfit =
    firstPositiveNumber(
      event.recoveryTakeProfit,
      event.position?.takeProfit,
      event.management?.recoveryTakeProfit,
      event.management?.tp2,
      event.lastKnownState?.recoveryTakeProfit,
      event.lastKnownState?.tp2,
      state.trade.recoveryTakeProfit,
      state.trade.takeProfit,
    );
  if (contextTakeProfit !== null) {
    state.trade.takeProfit = contextTakeProfit;
    if (state.trade.dailyMode === "RECOVERY_TP") {
      state.trade.recoveryTakeProfit = contextTakeProfit;
    }
  }

  if (
    type === "PLUS6_SL_TO_ENTRY" ||
    type === "STRUCTURAL_SL_TIGHTEN" ||
    type === "TP1_BREAK_EVEN_APPLIED"
  ) {
    const stop =
      firstPositiveNumber(
        event.stopLoss,
        enrichment.metrics?.stopLoss,
        event.management?.stopLoss,
        state.trade?.stopLoss,
      );

    if (stop !== null) {
      state.trade.stopLoss =
        stop;
    }
  }

  if (
    type === "PLUS10_PARTIAL_ONE_THIRD"
  ) {
    state.trade.remainingVolume =
      firstPositiveNumber(
        event.remainingVolume,
        enrichment.metrics?.volume,
        state.trade.remainingVolume,
        state.trade.initialVolume,
      ) ??
      state.trade.remainingVolume;

  }

  if (type === "TP1_PARTIAL_FILLED") {
    state.trade.remainingVolume =
      firstPositiveNumber(
        event.remainingVolume,
        enrichment.metrics?.volume,
        state.trade.remainingVolume,
        state.trade.initialVolume,
      ) ??
      state.trade.remainingVolume;
  }

  if (
    [
      "EXIT_EXECUTED",
      "MANAGED_POSITION_CLOSED",
      "POSITION_CLOSED",
    ].includes(type)
  ) {
    releaseHold(type);
    state.trade = null;
  }
}
function currentSide(event, enrichment) {
  return normalizeSide(
    enrichment.live?.state?.managed?.side ??
    state.trade?.side ??
    event.side,
  );
}

function liveMetrics(snapshot, event) {
  const managed = snapshot?.mt5?.managedPosition ?? null;
  const managedState = snapshot?.state?.managed ?? null;
  const side = normalizeSide(managedState?.side ?? state.trade?.side ?? event.side);
  const entry = firstPositiveNumber(
    managed?.openPrice,
    managed?.entry,
    managedState?.entry,
    event.position?.entry,
    event.management?.entry,
    state.trade?.entry,
  );
  const quote = snapshot?.mt5?.quote ?? null;
  const market = side === "BUY" ? numberOrNull(quote?.bid) : numberOrNull(quote?.ask);
  const stopLoss = firstPositiveNumber(
    managed?.stopLoss,
    managedState?.lastStructuralStop,
    event.stopLoss,
    event.position?.stopLoss,
    event.management?.stopLoss,
    state.trade?.stopLoss,
  );
  const volume = firstPositiveNumber(
    managed?.volume,
    managedState?.expectedRemainingVolume,
    event.remainingVolume,
    event.position?.volume,
    event.management?.expectedRemainingVolume,
    state.trade?.remainingVolume,
    state.trade?.initialVolume,
  );
  const priceMove = entry !== null && market !== null ? sidePriceMove(side, entry, market) : numberOrNull(event.favorable);
  const slPriceMove = entry !== null && stopLoss !== null ? sidePriceMove(side, entry, stopLoss) : null;
  const lockedPnlUsd = estimateLockedPnlUsd(slPriceMove, volume, snapshot?.mt5?.spec);
  return {
    side,
    entry,
    market,
    stopLoss,
    volume,
    priceMove,
    slPriceMove,
    profitUsd: numberOrNull(managed?.profit),
    lockedPnlUsd,
  };
}

function fallbackMetrics(event) {
  const side = normalizeSide(state.trade?.side ?? event.side);
  const entry = firstPositiveNumber(
    event.position?.entry,
    event.fillPrice,
    event.management?.entry,
    event.lastKnownState?.entry,
    state.trade?.entry,
  );
  const stopLoss = firstPositiveNumber(
    event.stopLoss,
    event.position?.stopLoss,
    event.management?.stopLoss,
    event.lastKnownState?.stopLoss,
    state.trade?.stopLoss,
  );
  return {
    side,
    entry,
    market: null,
    stopLoss,
    volume: firstPositiveNumber(
      event.remainingVolume,
      event.position?.volume,
      event.management?.expectedRemainingVolume,
      event.lastKnownState?.expectedRemainingVolume,
      state.trade?.remainingVolume,
      state.trade?.initialVolume,
    ),
    priceMove: numberOrNull(event.favorable),
    slPriceMove: entry !== null && stopLoss !== null ? sidePriceMove(side, entry, stopLoss) : null,
    profitUsd: null,
    lockedPnlUsd: null,
  };
}

async function getDemoSnapshot() {
  return fetchJson(
    `${monitorApiBase}/api/v1/phase7b-demo`,
    1800,
  ).catch(() => null);
}

async function getDailyRecoverySnapshot(volume) {
  const safeVolume =
    numberOrNull(volume) ??
    0.03;

  const query =
    new URLSearchParams({
      symbol,
      volume:
        String(safeVolume),
    });

  return fetchJson(
    `${monitorApiBase}/api/v1/phase7c/daily-recovery?${query.toString()}`,
    3000,
  ).catch(() => null);
}

async function getDailyRecoverySnapshotWithRetry(volume) {
  let lastSnapshot = null;

  for (
    let attempt = 0;
    attempt < 4;
    attempt += 1
  ) {
    const snapshot =
      await getDailyRecoverySnapshot(
        volume,
      );

    if (snapshot) {
      lastSnapshot = snapshot;

      // When MT5 history has synchronized enough to move
      // the day back to NORMAL, return immediately.
      if (
        snapshot.dailyMode === "NORMAL" ||
        Number(snapshot.dailyNetPnl) >= 0
      ) {
        return snapshot;
      }
    }

    if (attempt < 3) {
      await sleep(650);
    }
  }

  return lastSnapshot;
}
async function getCanonicalRealizedPosition(event) {
  const positionId = String(
    event?.ticket ??
    event?.position?.ticket ??
    state.trade?.ticket ??
    "",
  ).trim();

  if (!positionId) return null;

  const eventAt = Date.parse(
    String(
      event?.timestamp ??
      new Date().toISOString(),
    ),
  );
  const safeEventAt = Number.isFinite(eventAt)
    ? eventAt
    : Date.now();
  const openedAt = Number(state.trade?.openedAt);
  const fromMs =
    Number.isFinite(openedAt) && openedAt > 0
      ? Math.max(0, openedAt - 5 * 60_000)
      : Math.max(0, safeEventAt - 7 * 24 * 60 * 60_000);
  const toMs = safeEventAt + 2 * 60_000;
  const query = new URLSearchParams({
    positionId,
    symbol,
    fromMs: String(fromMs),
    toMs: String(toMs),
  });

  return fetchJson(
    `${monitorApiBase}/api/v1/phase7c-canonical-ledger/position-realized?${query.toString()}`,
    3000,
  ).catch(() => null);
}

async function getCanonicalRealizedPositionWithRetry(event) {
  let lastSnapshot = null;
  const partialEvent = [
    "PLUS10_PARTIAL_ONE_THIRD",
    "TP1_PARTIAL_FILLED",
  ].includes(String(event?.type ?? ""));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot =
      await getCanonicalRealizedPosition(event);

    if (snapshot) {
      lastSnapshot = snapshot;
      if (
        partialEvent
          ? matchCanonicalRealizedDeal(snapshot, event)
          : Number(snapshot.dealCount) > 0
      ) {
        return snapshot;
      }
    }

    if (attempt < 3) await sleep(650);
  }

  return lastSnapshot;
}

function matchCanonicalRealizedDeal(snapshot, event) {
  const deals = Array.isArray(snapshot?.deals)
    ? snapshot.deals
    : [];
  if (deals.length === 0) return null;

  const targetVolume = numberOrNull(event?.closedVolume);
  const eventAt = Date.parse(String(event?.timestamp ?? ""));
  const safeEventAt = Number.isFinite(eventAt)
    ? eventAt
    : Date.now();

  return [...deals]
    .filter((deal) => {
      const dealAt = Number(deal?.timestamp);
      return Number.isFinite(dealAt) &&
        Math.abs(dealAt - safeEventAt) <= 2 * 60_000;
    })
    .sort((left, right) => {
      const leftVolume = numberOrNull(left?.volume);
      const rightVolume = numberOrNull(right?.volume);
      const leftVolumeDelta =
        targetVolume === null || leftVolume === null
          ? 0
          : Math.abs(leftVolume - targetVolume);
      const rightVolumeDelta =
        targetVolume === null || rightVolume === null
          ? 0
          : Math.abs(rightVolume - targetVolume);
      if (Math.abs(leftVolumeDelta - rightVolumeDelta) > 1e-9) {
        return leftVolumeDelta - rightVolumeDelta;
      }
      return Math.abs(Number(left.timestamp) - safeEventAt) -
        Math.abs(Number(right.timestamp) - safeEventAt);
    })[0] ?? null;
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

  const exact = ticket
    ? trades.find((trade) => String(trade.id ?? "").endsWith(ticket) && trade.ownership === "SYSTEM")
    : null;
  if (exact) return exact;

  return trades.find((trade) =>
    trade.ownership === "SYSTEM" &&
    normalizeSide(trade.side) === side &&
    Math.abs(Number(trade.closedAt ?? 0) - eventAt) <= 10 * 60_000,
  ) ?? null;
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

function lifecycleRegime(event) {
  return String(
    state.trade?.source ??
    event?.journalSource ??
    "TREND",
  ).toUpperCase() === "SIDEWAY"
    ? "SIDEWAY"
    : "TREND";
}

function lifecycleTakeProfit(event) {
  const recovery = recoveryMetadata(event);
  if (recovery.active) {
    return fmtPrice(recovery.takeProfit);
  }

  if (lifecycleRegime(event) === "SIDEWAY") {
    return fmtPrice(
      firstPositiveNumber(
        event?.management?.tp2,
        event?.lastKnownState?.tp2,
        state.trade?.takeProfit,
        event?.position?.takeProfit,
      ),
    );
  }

  return "RUNNER M15";
}

function lifecycleContextLines(event, enrichment) {
  const position = event?.position ?? {};
  const metrics = enrichment?.metrics ?? {};
  const ticket = String(
    event?.ticket ??
    position?.ticket ??
    state.trade?.ticket ??
    "—",
  );
  const entry = firstPositiveNumber(
    position?.entry,
    event?.fillPrice,
    metrics?.entry,
    event?.management?.entry,
    event?.lastKnownState?.entry,
    state.trade?.entry,
  );
  const stopLoss = firstPositiveNumber(
    event?.stopLoss,
    position?.stopLoss,
    metrics?.stopLoss,
    event?.management?.stopLoss,
    event?.lastKnownState?.stopLoss,
    state.trade?.stopLoss,
  );
  const lot = firstPositiveNumber(
    event?.remainingVolume,
    position?.volume,
    metrics?.volume,
    event?.management?.expectedRemainingVolume,
    event?.lastKnownState?.expectedRemainingVolume,
    event?.management?.initialVolume,
    event?.lastKnownState?.initialVolume,
    state.trade?.remainingVolume,
    state.trade?.initialVolume,
  );

  return [
    line("🤖", "Regime", lifecycleRegime(event)),
    line("🎫", "Ticket", ticket),
    line("💵", "Entry", fmtPrice(entry)),
    line("🛡", "SL", fmtPrice(stopLoss)),
    line("🎯", "TP", lifecycleTakeProfit(event)),
    line("📦", "Lot", `${value(lot)} lot`),
  ];
}

function compactStats(metrics) {
  const move = metrics?.priceMove === null || metrics?.priceMove === undefined ? "—" : fmtSignedPrice(metrics.priceMove);
  const pnl = metrics?.profitUsd === null || metrics?.profitUsd === undefined ? "—" : fmtMoney(metrics.profitUsd, true);
  return `📈 <b>Hiện:</b> <code>${move} giá</code> · 💵 <code>${pnl}</code>`;
}

function compactTradeCard(icon, side, action, lines) {
  const sideMarker = side === "BUY" ? "🟢" : "🔴";
  return [
    `${icon} ${sideMarker} <b>${esc(side)} · ${esc(action)}</b>`,
    `<code>${phaseBanner}</code>`,
    ...lines,
  ].join("\n");
}

function fullCard(icon, title, lines) {
  return [
    `${icon} <b>${esc(title)}</b>`,
    `<code>${phaseBanner}</code>`,
    "",
    ...lines,
  ].join("\n");
}

function warningCard(title, message, retcode) {
  return [
    `⚠️ <b>${esc(title)}</b>`,
    `<code>${phaseBanner}</code>`,
    `<code>${esc(String(message ?? "Kiểm tra journal"))}</code>`,
    retcode === null || retcode === undefined ? "" : `Retcode: <code>${esc(value(retcode))}</code>`,
  ].filter(Boolean).join("\n");
}

function line(icon, label, raw) {
  return `${icon} <b>${esc(label)}:</b> <code>${esc(value(raw))}</code>`;
}

async function sendHtml(
  text,
  route = "trade",
  { includePhase = true } = {},
) {
  const isControl = route === "control";

  const targetToken = isControl
    ? controlToken
    : tradeToken;

  const targetChatId = isControl
    ? controlChatId
    : tradeChatId;

  const targetThreadId = isControl
    ? controlMessageThreadId
    : tradeMessageThreadId;

  const phaseTaggedText =
    !includePhase ||
    String(text).includes(phaseBanner)
      ? String(text)
      : `${String(text)}\n<code>${phaseBanner}</code>`;

  const highContrastText = phaseTaggedText
    .replaceAll("<code>", "<b>")
    .replaceAll("</code>", "</b>");

  const payload = {
    chat_id: targetChatId,
    text: highContrastText.slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(targetThreadId === null
      ? {}
      : { message_thread_id: targetThreadId }),
    ...(!isControl && monitorUrl
      ? {
          reply_markup: {
            inline_keyboard: [[
              {
                text: "📊 Mở Phase 7C Monitor",
                url: monitorUrl,
              },
            ]],
          },
        }
      : {}),
  };

  if (dryRun) {
    fs.mkdirSync(path.dirname(dryRunSinkPath), { recursive: true });
    fs.appendFileSync(
      dryRunSinkPath,
      JSON.stringify({
        route,
        text: payload.text,
        accountMode,
        orderPermission: "NONE",
      }) + "\n",
      "utf8",
    );
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    8_000,
  );

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" +
        targetToken +
        "/sendMessage",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        "Telegram sendMessage " +
          response.status +
          ": " +
          body,
      );
    }

    const parsed = JSON.parse(body);

    if (!parsed.ok) {
      throw new Error(
        "Telegram sendMessage failed: " + body,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
function loadState() {
  const blank = {
    version: 3,
    initialized: false,
    offset: 0,
    offsets: {},
    sent: 0,
    lastEventAt: null,
    trade: null,
    hold: null,
    holdM15ByTicketReason: {},
    systemAlerts: {},
  };

  if (!fs.existsSync(statePath)) {
    return blank;
  }

  try {
    const parsed =
      JSON.parse(
        fs.readFileSync(
          statePath,
          "utf8",
        ).replace(/^\uFEFF/, ""),
      );

    const offsets =
      parsed.offsets &&
      typeof parsed.offsets === "object"
        ? { ...parsed.offsets }
        : {};

    const legacyTrendOffset =
      Number.isFinite(
        Number(offsets.trend),
      )
        ? Number(offsets.trend)
        : Number.isFinite(
              Number(parsed.offset),
            )
          ? Number(parsed.offset)
          : 0;

    offsets.trend =
      legacyTrendOffset;

    return {
      version: 3,

      initialized:
        Boolean(
          parsed.initialized,
        ),

      offset:
        legacyTrendOffset,

      offsets,

      sent:
        Number.isFinite(
          parsed.sent,
        )
          ? parsed.sent
          : 0,

      lastEventAt:
        parsed.lastEventAt ??
        null,

      trade:
        parsed.trade &&
        typeof parsed.trade === "object"
          ? parsed.trade
          : null,

      hold:
        parsed.hold &&
        typeof parsed.hold === "object"
          ? parsed.hold
          : null,

      holdM15ByTicketReason:
        parsed.holdM15ByTicketReason &&
        typeof parsed.holdM15ByTicketReason === "object"
          ? { ...parsed.holdM15ByTicketReason }
          : {},

      systemAlerts:
        parsed.systemAlerts &&
        typeof parsed.systemAlerts === "object"
          ? parsed.systemAlerts
          : {},
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

function estimateLockedPnlUsd(priceMove, volume, spec) {
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
  const value = String(raw ?? state.trade?.side ?? "BUY").toUpperCase();
  return value === "SELL" || value === "SHORT" ? "SELL" : "BUY";
}

function normalizeAccountMode(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value !== "DEMO" && value !== "LIVE") {
    throw new Error(`Invalid ZIQ_PHASE7C_ACCOUNT_MODE=${raw ?? ""}; expected DEMO or LIVE`);
  }
  return value;
}

function sideIcon(side) {
  return side === "BUY" ? "🟢" : "🔴";
}

function fmtPrice(raw) {
  const number = numberOrNull(raw);
  return number === null ? "—" : number.toFixed(2);
}

function fmtSignedPrice(raw) {
  const number = numberOrNull(raw);
  if (number === null) return "—";
  const sign = number > 0 ? "+" : number < 0 ? "−" : "";
  return `${sign}${Math.abs(number).toFixed(2)}`;
}

function fmtMoney(raw, signed = false, approximate = false) {
  const number = numberOrNull(raw);
  if (number === null) return "—";
  const sign = signed ? (number > 0 ? "+" : number < 0 ? "−" : "") : "";
  return `${approximate ? "≈ " : ""}${sign}$${Math.abs(number).toFixed(2)}`;
}

function reasonLabel(raw) {
  const value = String(raw ?? "UNKNOWN");
  if (value === "REVERSAL_FVG_REJECTION") return "FVG ngược hướng + rejection sau +10";
  if (value === "TREND_MA20") return "đóng M15 phá MA20";
  return value.replaceAll("_", " ");
}

function numberOrNull(raw) {
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function firstPositiveNumber(...rawValues) {
  for (const raw of rawValues) {
    if (raw === null || raw === undefined || raw === "") continue;
    const number = Number(raw);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function value(raw) {
  if (raw === null || raw === undefined || raw === "") return "—";
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

function telegramTime(raw) {
  if (!raw) return "—";
  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : String(raw);
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
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
