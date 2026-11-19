import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import {
  phase7BSupertrend,
  type Phase7Bar,
  type Phase7BPendingPullback,
} from "@xauusd/risk-engine";
import { getMt5Telemetry } from "../services/mt5.service";
import { isPhase7BProcessAlive } from "../services/phase7b-process-liveness";
import { shouldComputePhase7BEntryDiagnostics } from "../services/phase7b-entry-diagnostics-account-mode";
import { phase7BForwardRuntimeDirName } from "../services/phase7b-status-runtime-account-mode";

type ManagedState = {
  ticket: string;
  side: "BUY" | "SELL";
  pattern: string;
  signalTimestamp: number;
  signalEntry: number;
  entry: number;
  initialVolume: number;
  expectedRemainingVolume: number;
  stopDistance: number;
  breakEvenApplied: boolean;
  partialApplied: boolean;
  partialActivatedAt: number | null;
  lastStructuralStop: number | null;
};

type BotState = {
  version: number;
  accountLogin: number | null;
  lastEvaluatedM15Close: number;
  lastEvaluatedM5Close?: number;
  pendingPullback?: Phase7BPendingPullback | null;
  managed: ManagedState | null;
};

type RuntimeState = {
  version: number;
  status: "STARTING" | "RUNNING" | "STOPPED" | string;
  armed: boolean;
  pid: number | null;
  heartbeatAt: number;
  startedAt: number | null;
  intervalSeconds: number;
};

type DemoEvent = Record<string, unknown> & {
  timestamp?: string;
  type?: string;
};

type Phase7BSide = "BUY" | "SELL";
type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE";

type M15Bar = {
  openTime?: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type EntryDiagnostics = {
  source: "READ_ONLY_BRIDGE_M15";
  closeTime: number;
  nextCloseTime: number;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  pattern: {
    matched: boolean;
    name: Phase7BPattern | null;
    side: Phase7BSide | null;
    extreme: number | null;
  };
  trend: {
    ma20: number;
    ma50: number;
    ma200: number;
    buyAligned: boolean;
    sellAligned: boolean;
    matchedPatternSide: boolean;
    m15Supertrend: Phase7BSide | null;
    m5Supertrend: Phase7BSide | null;
    m5FlipAgeBars: number | null;
    m15SupertrendLine: number | null;
    m5SupertrendLine: number | null;
    m15TrendlineDistance: number | null;
    m5TrendlineDistance: number | null;
    m15TrendlineReaction: boolean;
    m5TrendlineReaction: boolean;
    confidenceSide: Phase7BSide | null;
    confidenceM5Supertrend: Phase7BSide | null;
    confidenceScore: number | null;
    confidenceLevel: "CHƯA_ĐÁNH_GIÁ" | "TIÊU_CHUẨN" | "CAO" | "RẤT_CAO";
  };
  fvg: {
    buyConfirmed: boolean;
    sellConfirmed: boolean;
    sameDirectionConfirmed: boolean;
    requiredForEntry: false;
  };
  entry: {
    eligible: boolean;
    reversalEligible: boolean;
    side: Phase7BSide | null;
    rule: "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE";
    reversalRule: "PATTERN_PLUS_VALID_STRUCTURE_NO_SUPERTREND";
    referenceEntry: number;
    structuralStopDistance: number | null;
    stopDistance: number | null;
    reversalStopDistance: number | null;
    action: "WAIT_SIGNAL" | "ENTRY_IMMEDIATE" | "WAIT_PULLBACK";
    reversalAction: "WAIT_SIGNAL" | "ENTRY_IMMEDIATE" | "WAIT_PULLBACK";
    reason: string;
    reversalReason: string;
  };
};

const ENGULF_BODY_TOLERANCE_PRICE = 0.1;

function normalizeBrokerTimestamp(timestamp: number, brokerClockOffsetMs: number): number {
  return timestamp - brokerClockOffsetMs;
}

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    const telemetry = await getMt5Telemetry("XAUUSD");
    const demoDir = findLatestDemoDir(telemetry.health?.accountMode ?? null);
    const statePath = demoDir ? path.join(demoDir, "phase7b-demo-state.json") : null;
    const journalPath = demoDir ? path.join(demoDir, "phase7b-demo-events.jsonl") : null;
    const runtimePath = demoDir ? path.join(demoDir, "phase7b-demo-runtime.json") : null;
    const state = statePath && fs.existsSync(statePath) ? readJson<BotState>(statePath) : null;
    const runtime = runtimePath && fs.existsSync(runtimePath) ? readJson<RuntimeState>(runtimePath) : null;
    const events = journalPath && fs.existsSync(journalPath) ? readRecentEvents(journalPath, 80) : [];
    const latestEvent = events.at(-1) ?? null;
    const latestEventAt = latestEvent?.timestamp ? Date.parse(String(latestEvent.timestamp)) : null;
    const activityAgeMs = latestEventAt && Number.isFinite(latestEventAt) ? Math.max(0, Date.now() - latestEventAt) : null;
    const heartbeatAgeMs = runtime?.heartbeatAt && Number.isFinite(runtime.heartbeatAt)
      ? Math.max(0, Date.now() - runtime.heartbeatAt)
      : null;
    const heartbeatLimitMs = Math.max(15_000, Math.max(1, runtime?.intervalSeconds ?? 5) * 3_000);
    const heartbeatAlive = Boolean(
      runtime?.armed &&
      runtime.status === "RUNNING" &&
      heartbeatAgeMs !== null &&
      heartbeatAgeMs <= heartbeatLimitMs,
    );
    const processAlive = Boolean(runtime?.armed && isPhase7BProcessAlive(runtime.pid));
    const runtimeAlive = heartbeatAlive || processAlive;
    const managedPosition = state?.managed
      ? telemetry.positions.find((position) => String(position.ticket) === String(state.managed?.ticket)) ?? null
      : null;

    let botStatus = "READY_NOT_ARMED";
    if (!demoDir) botStatus = "NOT_CONFIGURED";
    else if (!telemetry.reachable) botStatus = "MT5_OFFLINE";
    else if (state?.managed && !runtimeAlive) botStatus = "POSITION_NOT_MANAGED";
    else if (runtimeAlive && state?.managed) botStatus = "MANAGING";
    else if (runtimeAlive && state?.pendingPullback) botStatus = "WAITING_PULLBACK";
    else if (runtimeAlive) botStatus = "WAITING_SIGNAL";
    else if (runtime?.armed) botStatus = "BOT_STALE";

    const recentEventCounts: Record<string, number> = {};
    for (const event of events) {
      const key = String(event.type ?? "UNKNOWN");
      recentEventCounts[key] = (recentEventCounts[key] ?? 0) + 1;
    }

    let entryDiagnostics: EntryDiagnostics | null = null;
    let entryDiagnosticsError: string | null = null;
    if (shouldComputePhase7BEntryDiagnostics({
      reachable: telemetry.reachable,
      accountMode: telemetry.health?.accountMode ?? null,
    })) {
      try {
        entryDiagnostics = await getEntryDiagnostics(0, telemetry.quote);
      } catch (error) {
        entryDiagnosticsError = error instanceof Error ? error.message : "M15 entry diagnostics unavailable.";
      }
    }

    res.json({
      readOnly: true,
      botStatus,
      generatedAt: Date.now(),
      source: { demoDir, statePath, journalPath, runtimePath },
      runtime: {
        ...runtime,
        alive: runtimeAlive,
        processAlive,
        heartbeatAlive,
        heartbeatAgeMs,
        heartbeatLimitMs,
      },
      strategy: {
        name: "M15_TRIPLE_PATTERN_MA_STRUCTURE_RIDER_FVG_CONFIRMATION",
        trigger: "ENGULFING_OR_TWO_OR_THREE_SAME_COLOR_BODY_DOMINANCE",
        engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
        trend: "SUPERTREND_M15_10_3_AND_M5_10_3_MANDATORY",
        reversalEntry: "CHOCH_DIRECTION_PATTERN_VALID_STRUCTURE_NO_SUPERTREND",
        fvg: "OPTIONAL_AT_ENTRY_HOLD_CONFIRMATION_ADDON_SHADOW",
        initialStop: "STRUCTURE_MIN_6_MAX_10_WAIT_PULLBACK_IF_WIDER",
        plus6: "SL_TO_ENTRY",
        plus10: "PARTIAL_ONE_THIRD",
        runner: "M15_STRUCTURE_TRAIL",
        reversalExit: "OPPOSING_FVG_PLUS_REJECTION_AFTER_PLUS10",
      },
      entryDiagnostics,
      entryDiagnosticsError,
      state,
      latestEvent,
      latestEventAt,
      activityAgeMs,
      recentEventCounts,
      recentEvents: events.slice(-40).reverse(),
      mt5: {
        enabled: telemetry.enabled,
        configured: telemetry.configured,
        reachable: telemetry.reachable,
        status: telemetry.status,
        message: telemetry.message,
        checkedAt: telemetry.checkedAt,
        health: telemetry.health,
        quote: telemetry.quote,
        spec: telemetry.spec,
        positions: telemetry.positions,
        managedPosition,
      },
    });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Phase 7B DEMO status failed." });
  }
});

async function getEntryDiagnostics(
  brokerClockOffsetMs: number,
  quote: { bid: number; ask: number } | null | undefined,
): Promise<EntryDiagnostics> {
  const baseUrl = process.env.MT5_BRIDGE_BASE_URL?.trim().replace(/\/$/, "") ?? "";
  const apiKey = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!baseUrl || !apiKey) throw new Error("Bridge read-only credentials are unavailable to the Phase 7B API.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const [m15Response, m5Response] = await Promise.all([
      fetch(`${baseUrl}/v1/candles/XAUUSD?timeframe=M15&count=320`, {
        headers: { "x-mt5-api-key": apiKey },
        signal: controller.signal,
      }),
      fetch(`${baseUrl}/v1/candles/XAUUSD?timeframe=M5&count=420`, {
        headers: { "x-mt5-api-key": apiKey },
        signal: controller.signal,
      }),
    ]);
    const [m15Text, m5Text] = await Promise.all([m15Response.text(), m5Response.text()]);
    if (!m15Response.ok) throw new Error(`Bridge M15 request failed ${m15Response.status}: ${m15Text}`);
    if (!m5Response.ok) throw new Error(`Bridge M5 request failed ${m5Response.status}: ${m5Text}`);
    const m15Bars = JSON.parse(m15Text) as M15Bar[];
    const m5Bars = JSON.parse(m5Text) as M15Bar[];
    return buildEntryDiagnostics(m15Bars, m5Bars, brokerClockOffsetMs, quote);
  } finally {
    clearTimeout(timeout);
  }
}

function buildEntryDiagnostics(
  bars: M15Bar[],
  m5Bars: M15Bar[],
  brokerClockOffsetMs: number,
  quote: { bid: number; ask: number } | null | undefined,
): EntryDiagnostics {
  const index = bars.length - 1;
  if (index < 200) throw new Error(`Need at least 201 closed M15 bars, received ${bars.length}.`);
  const current = bars[index]!;
  if (![current.closeTime, current.open, current.high, current.low, current.close].every(Number.isFinite)) {
    throw new Error("Latest M15 candle is invalid.");
  }

  const closes = bars.slice(0, index + 1).map((bar) => bar.close);
  const ma20 = smaPeriod(closes, 20);
  const ma50 = smaPeriod(closes, 50);
  const ma200 = smaPeriod(closes, 200);
  const buyAligned = ma20 > ma50 && current.close > ma20;
  const sellAligned = ma20 < ma50 && current.close < ma20;
  const pattern = detectEntryPattern(bars, index);
  const matchedPatternSide = pattern?.side === "BUY" ? buyAligned : pattern?.side === "SELL" ? sellAligned : false;
  const buyFvg = hasRelevantFvg(bars, index, "BUY", 12);
  const sellFvg = hasRelevantFvg(bars, index, "SELL", 12);
  const sameDirectionConfirmed = pattern?.side === "BUY" ? buyFvg : pattern?.side === "SELL" ? sellFvg : false;

  const m15SupertrendResult = phase7BSupertrend(bars as Phase7Bar[], 10, 3);
  const m15Supertrend = m15SupertrendResult.direction[index] ?? null;
  const m15SupertrendLine = m15SupertrendResult.line[index] ?? null;
  let m5SignalIndex = m5Bars.length - 1;
  while (m5SignalIndex >= 0 && m5Bars[m5SignalIndex]!.closeTime > current.closeTime) m5SignalIndex -= 1;
  const m5AtSignal = m5SignalIndex >= 0 ? m5Bars.slice(0, m5SignalIndex + 1) : [];
  const m5AtSignalSupertrend = m5AtSignal.length >= 10
    ? phase7BSupertrend(m5AtSignal as Phase7Bar[], 10, 3)
    : { direction: [] as Array<Phase7BSide | null>, line: [] as Array<number | null> };
  const m5Supertrend = m5SignalIndex >= 0 ? m5AtSignalSupertrend.direction[m5SignalIndex] ?? null : null;
  const latestM5Index = m5Bars.length - 1;
  const latestM5SupertrendResult = m5Bars.length >= 10
    ? phase7BSupertrend(m5Bars as Phase7Bar[], 10, 3)
    : { direction: [] as Array<Phase7BSide | null>, line: [] as Array<number | null> };
  const confidenceM5Supertrend = latestM5Index >= 0
    ? latestM5SupertrendResult.direction[latestM5Index] ?? null
    : null;
  const m5SupertrendLine = latestM5Index >= 0 ? latestM5SupertrendResult.line[latestM5Index] ?? null : null;
  const latestM5Bar = latestM5Index >= 0 ? m5Bars[latestM5Index]! : null;
  const supertrendAligned = Boolean(pattern && m15Supertrend === pattern.side && m5Supertrend === pattern.side);
  const m15TrendlineDistance = m15SupertrendLine === null ? null : Math.abs(current.close - m15SupertrendLine);
  const m5TrendlineDistance = latestM5Bar === null || m5SupertrendLine === null
    ? null
    : Math.abs(latestM5Bar.close - m5SupertrendLine);
  const m15TrendlineReaction = nearTrendline(current, m15SupertrendLine, 0.5);
  const m5TrendlineReaction = latestM5Bar !== null
    && nearTrendline(latestM5Bar, m5SupertrendLine, 0.2);
  const m5FlipAgeBars = m5SignalIndex >= 0 && m5Supertrend !== null
    ? directionAgeBars(m5AtSignalSupertrend.direction, m5SignalIndex, m5Supertrend)
    : null;
  const confidenceSide = pattern?.side ?? m15Supertrend ?? confidenceM5Supertrend;
  const confidenceMaAligned = confidenceSide === "BUY"
    ? buyAligned
    : confidenceSide === "SELL"
      ? sellAligned
      : false;
  const confidenceMacroAligned = confidenceSide === "BUY"
    ? current.close >= ma200
    : confidenceSide === "SELL"
      ? current.close <= ma200
      : false;
  const confidenceFvgAligned = confidenceSide === "BUY"
    ? buyFvg
    : confidenceSide === "SELL"
      ? sellFvg
      : false;
  const confidenceScore = confidenceSide === null
    ? null
    : (m15Supertrend === confidenceSide ? 20 : 0)
      + (confidenceM5Supertrend === confidenceSide ? 20 : 0)
      + (confidenceMaAligned ? 20 : 0)
      + (confidenceMacroAligned ? 10 : 0)
      + (m15Supertrend === confidenceSide && m15TrendlineReaction ? 10 : 0)
      + (confidenceM5Supertrend === confidenceSide && m5TrendlineReaction ? 10 : 0)
      + (confidenceFvgAligned ? 10 : 0);
  const confidenceLevel: EntryDiagnostics["trend"]["confidenceLevel"] = confidenceScore === null
    ? "CHƯA_ĐÁNH_GIÁ"
    : confidenceScore >= 80
      ? "RẤT_CAO"
      : confidenceScore >= 60
        ? "CAO"
        : "TIÊU_CHUẨN";

  const referenceEntry = pattern?.side === "BUY" && Number.isFinite(quote?.ask)
    ? Number(quote!.ask)
    : pattern?.side === "SELL" && Number.isFinite(quote?.bid)
      ? Number(quote!.bid)
      : current.close;
  const structuralStopDistance = pattern
    ? pattern.side === "BUY" ? referenceEntry - pattern.extreme : pattern.extreme - referenceEntry
    : null;
  const validStructure = structuralStopDistance !== null && structuralStopDistance > 0;
  const waitPullback = Boolean(
    pattern
      && supertrendAligned
      && validStructure
      && structuralStopDistance !== null
      && structuralStopDistance > 10,
  );
  const eligible = Boolean(
    pattern
      && supertrendAligned
      && validStructure
      && structuralStopDistance !== null
      && structuralStopDistance <= 10,
  );
  const reversalEligible = Boolean(
    pattern
      && validStructure
      && structuralStopDistance !== null
      && structuralStopDistance <= 10,
  );
  const stopDistance = eligible && structuralStopDistance !== null
    ? Math.max(6, structuralStopDistance)
    : null;
  const reversalStopDistance = reversalEligible && structuralStopDistance !== null
    ? Math.max(6, structuralStopDistance)
    : null;

  let reason = `Chưa có một trong 3 mô hình: Engulfing (sai số thân tối đa ${ENGULF_BODY_TOLERANCE_PRICE.toFixed(2)} giá), Two-candle hợp lệ, hoặc Three-candle A-B-C-D hợp lệ khi B+C < A và B+C+D > A.`;
  if (pattern && !supertrendAligned) {
    reason = `${pattern.side} pattern đã xuất hiện nhưng Supertrend M15/M5 10/3 chưa cùng hướng (M15=${m15Supertrend ?? "—"}, M5=${m5Supertrend ?? "—"}).`;
  } else if (pattern && supertrendAligned && !validStructure) {
    reason = "Pattern + Supertrend M15/M5 đạt nhưng cấu trúc không tạo được khoảng SL hợp lệ.";
  } else if (waitPullback) {
    reason = `${pattern!.side} đủ Pattern + Supertrend M15/M5 nhưng SL cấu trúc ${structuralStopDistance!.toFixed(2)} giá vượt 10; chờ giá hồi trong cửa sổ M15 kế tiếp rồi mới vào.`;
  } else if (eligible) {
    reason = sameDirectionConfirmed
      ? `${pattern!.side} đủ Pattern + Supertrend M15/M5 + SL cấu trúc; MA20/50 cùng hướng chỉ tăng độ tin cậy; FVG cùng hướng cũng xác nhận.`
      : `${pattern!.side} đủ Pattern + Supertrend M15/M5 + SL cấu trúc; MA20/50 chỉ là độ tin cậy và FVG không chặn entry.`;
  }

  const reversalWaitPullback = Boolean(
    pattern
      && validStructure
      && structuralStopDistance !== null
      && structuralStopDistance > 10,
  );
  let reversalReason = `Chưa có một trong 3 mô hình M15 hợp lệ để xét REVERSAL; SuperTrend không tham gia gate.`;
  if (pattern && !validStructure) {
    reversalReason = `${pattern.side} pattern đã xuất hiện nhưng cấu trúc không tạo được khoảng SL hợp lệ.`;
  } else if (reversalWaitPullback) {
    reversalReason = `${pattern!.side} đủ Pattern + Structure nhưng SL cấu trúc ${structuralStopDistance!.toFixed(2)} giá vượt 10; chờ pullback về vùng SL 6–10. SuperTrend không tham gia gate.`;
  } else if (reversalEligible) {
    reversalReason = `${pattern!.side} đủ Pattern + Structure + SL 6–10 cho REVERSAL; SuperTrend M15/M5 chỉ quan sát và không chặn entry.`;
  }

  const normalizedCloseTime = normalizeBrokerTimestamp(current.closeTime, brokerClockOffsetMs);

  return {
    source: "READ_ONLY_BRIDGE_M15",
    closeTime: normalizedCloseTime,
    nextCloseTime: normalizedCloseTime + 15 * 60_000,
    bar: {
      open: round(current.open, 5),
      high: round(current.high, 5),
      low: round(current.low, 5),
      close: round(current.close, 5),
    },
    pattern: {
      matched: Boolean(pattern),
      name: pattern?.name ?? null,
      side: pattern?.side ?? null,
      extreme: pattern ? round(pattern.extreme, 5) : null,
    },
    trend: {
      ma20: round(ma20, 5),
      ma50: round(ma50, 5),
      ma200: round(ma200, 5),
      buyAligned,
      sellAligned,
      matchedPatternSide,
      m15Supertrend,
      m5Supertrend,
      m5FlipAgeBars,
      m15SupertrendLine: m15SupertrendLine === null ? null : round(m15SupertrendLine, 5),
      m5SupertrendLine: m5SupertrendLine === null ? null : round(m5SupertrendLine, 5),
      m15TrendlineDistance: m15TrendlineDistance === null ? null : round(m15TrendlineDistance, 5),
      m5TrendlineDistance: m5TrendlineDistance === null ? null : round(m5TrendlineDistance, 5),
      m15TrendlineReaction,
      m5TrendlineReaction,
      confidenceSide,
      confidenceM5Supertrend,
      confidenceScore,
      confidenceLevel,
    },
    fvg: {
      buyConfirmed: buyFvg,
      sellConfirmed: sellFvg,
      sameDirectionConfirmed,
      requiredForEntry: false,
    },
    entry: {
      eligible,
      reversalEligible,
      side: pattern?.side ?? null,
      rule: "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE",
      reversalRule: "PATTERN_PLUS_VALID_STRUCTURE_NO_SUPERTREND",
      referenceEntry: round(referenceEntry, 5),
      structuralStopDistance: structuralStopDistance === null ? null : round(structuralStopDistance, 5),
      stopDistance: stopDistance === null ? null : round(stopDistance, 5),
      reversalStopDistance: reversalStopDistance === null ? null : round(reversalStopDistance, 5),
      action: waitPullback ? "WAIT_PULLBACK" : eligible ? "ENTRY_IMMEDIATE" : "WAIT_SIGNAL",
      reversalAction: reversalWaitPullback
        ? "WAIT_PULLBACK"
        : reversalEligible
          ? "ENTRY_IMMEDIATE"
          : "WAIT_SIGNAL",
      reason,
      reversalReason,
    },
  };
}

function detectEntryPattern(
  bars: M15Bar[],
  index: number,
): { side: Phase7BSide; name: Phase7BPattern; extreme: number } | null {
  const current = bars[index]!;

  // Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.
  if (index >= 3) {
    const anchor = bars[index - 3]!;
    const b = bars[index - 2]!;
    const c = bars[index - 1]!;
    const d = current;
    const anchorBody = bodySize(anchor);
    const bcBodyTotal = bodySize(b) + bodySize(c);
    const bcdBodyTotal = bcBodyTotal + bodySize(d);

    if (
      isBearish(anchor) && isBullish(b) && isBullish(c) && isBullish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "BUY", name: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.min(anchor.low, b.low, c.low, d.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) && isBearish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "SELL", name: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.max(anchor.high, b.high, c.high, d.high) };
    }
  }

  if (index >= 2) {
    const anchor = bars[index - 2]!;
    const b = bars[index - 1]!;
    const c = current;
    const anchorBody = bodySize(anchor);
    const bBody = bodySize(b);
    const bcBodyTotal = bBody + bodySize(c);

    if (
      isBearish(anchor) && isBullish(b) && isBullish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "BUY", name: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.min(anchor.low, b.low, c.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "SELL", name: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.max(anchor.high, b.high, c.high) };
    }
  }

  if (index >= 1) {
    const previous = bars[index - 1]!;
    if (
      isBearish(previous) && isBullish(current) &&
      current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
      current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
    ) {
      return { side: "BUY", name: "ENGULFING", extreme: current.low };
    }
    if (
      isBullish(previous) && isBearish(current) &&
      current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
      current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
    ) {
      return { side: "SELL", name: "ENGULFING", extreme: current.high };
    }
  }
  return null;
}

function hasRelevantFvg(bars: M15Bar[], index: number, side: Phase7BSide, lookback: number): boolean {
  if (index < 2) return false;
  const start = Math.max(2, index - lookback);
  const current = bars[index]!;
  for (let i = index - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.low > first.high && current.low <= third.low && current.high >= first.high) return true;
    if (side === "SELL" && third.high < first.low && current.high >= third.high && current.low <= first.low) return true;
  }
  return false;
}

function directionAgeBars(
  direction: Array<Phase7BSide | null>,
  index: number,
  current: Phase7BSide,
): number {
  let age = 0;
  for (let i = index - 1; i >= 0 && direction[i] === current; i -= 1) age += 1;
  return age;
}

function isBullish(bar: M15Bar): boolean { return bar.close > bar.open; }
function isBearish(bar: M15Bar): boolean { return bar.close < bar.open; }
function bodySize(bar: M15Bar): number { return Math.abs(bar.close - bar.open); }

function nearTrendline(bar: M15Bar, line: number | null, minimumThreshold: number): boolean {
  if (line === null || !Number.isFinite(line)) return false;
  const distance = line < bar.low ? bar.low - line : line > bar.high ? line - bar.high : 0;
  const candleThreshold = Math.abs(bar.high - bar.low) * 0.25;
  return distance <= Math.max(minimumThreshold, candleThreshold);
}

function smaPeriod(values: number[], period: number): number {
  if (values.length < period) throw new Error(`Not enough M15 bars for MA${period}.`);
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }

function findLatestDemoDir(brokerAccountMode: string | null | undefined): string | null {
  const forwardDirName = phase7BForwardRuntimeDirName(brokerAccountMode);
  const runtimeRoot = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (runtimeRoot) {
    const candidate = path.resolve(runtimeRoot, forwardDirName);
    if (fs.existsSync(candidate)) return candidate;
  }

  const configured = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    const configuredBase = path.basename(resolved).toLowerCase();
    const siblingCandidate = configuredBase === forwardDirName
      ? resolved
      : path.join(path.dirname(resolved), forwardDirName);
    if (fs.existsSync(siblingCandidate)) return siblingCandidate;

    const nestedCandidate = path.join(resolved, forwardDirName);
    if (fs.existsSync(nestedCandidate)) return nestedCandidate;
  }

  const bases = [
    path.resolve(process.cwd(), "data", "historical-replay"),
    path.resolve(process.cwd(), "apps", "api", "data", "historical-replay"),
    path.resolve(process.cwd(), "..", "..", "apps", "api", "data", "historical-replay"),
  ];

  const found: Array<{ dir: string; mtimeMs: number }> = [];
  for (const base of [...new Set(bases)]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runtimeDir = path.join(base, entry.name, forwardDirName);
      if (!fs.existsSync(runtimeDir)) continue;
      const runtime = path.join(runtimeDir, "phase7b-demo-runtime.json");
      const state = path.join(runtimeDir, "phase7b-demo-state.json");
      const journal = path.join(runtimeDir, "phase7b-demo-events.jsonl");
      const probe = fs.existsSync(runtime) ? runtime : fs.existsSync(journal) ? journal : fs.existsSync(state) ? state : runtimeDir;
      found.push({ dir: runtimeDir, mtimeMs: fs.statSync(probe).mtimeMs });
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0]?.dir ?? null;
}

function readJson<T>(file: string): T {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as T;
}

function readRecentEvents(file: string, limit: number): DemoEvent[] {
  const buffer = fs.readFileSync(file);
  const maxBytes = 512 * 1024;
  const start = Math.max(0, buffer.length - maxBytes);
  const text = buffer.subarray(start).toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const events: DemoEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as DemoEvent);
    } catch {
      // First line can be partial when reading a journal tail.
    }
  }
  return events.slice(-limit);
}

export default router;
