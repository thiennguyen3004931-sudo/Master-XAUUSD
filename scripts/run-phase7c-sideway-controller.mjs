import fs from "node:fs";
import path from "node:path";
import { summarizeBrokerDayRealizedPnl } from "@xauusd/mt5-broker";
import {
  evaluateTimestampFreshness,
  inferBrokerClockOffset,
  normalizeBrokerTimestamp,
  validateAutoLotSnapshot,
} from "./phase7c-sideway-execution-guards.mjs";
import {
  buildSidewayPlan,
  chooseRangeSide,
  detectM5ConfirmationWithinBars,
  estimateVolumePoc,
  matchPendingEntryPosition,
  normalizeVolume,
  oneThirdPartialVolume,
  reconcileManagedBrokerState,
  resolveSidewayPermission,
  targetReached,
} from "./phase7c-sideway-logic.mjs";
import { createPhase7CDecisionAudit } from "./phase7c-decision-audit.mjs";
import { pauseDailyRecoveryForNewEntry } from "./phase7c-daily-recovery-pause.mjs";
import { acquireExecutionLock } from "./phase7c-execution-lock.mjs";
import {
  buildFixedTpSnapshot,
  isFixedTpTriggered,
  fixedTpCommandId,
} from "./phase7c-fixed-tp.mjs";
import { canonicalHoldReason } from "./phase7c-hold-observability.mjs";
import {
  stopIsAtLeastAsTight,
  stopStrictlyTightens,
  tightestKnownStop,
} from "./phase7c-stop-monotonicity.mjs";
import { fastMoveProfitLockCandidate } from "./phase7c-fast-move-profit-lock.mjs";
import {
  compareStrategyEntryConfigVersion,
  createVirtualStrategyEntryConditionState,
  evaluateStrategyEntryConditions,
  validateStrategyEntryConditionState,
} from "./phase7c-strategy-entry-conditions.mjs";

const symbol = (process.env.ZIQ_PHASE7C_SIDEWAY_SYMBOL || process.env.ZIQ_DEMO_SYMBOL || "XAUUSD").trim().toUpperCase();
const controlApiBase = (process.env.ZIQ_PHASE7C_CONTROL_API_URL || "http://127.0.0.1:3711").trim().replace(/\/$/, "");
const intervalSeconds = clampNumber(process.env.ZIQ_PHASE7C_SIDEWAY_INTERVAL_SECONDS, 5, 1, 60);
const riskPercent = clampNumber(process.env.ZIQ_PHASE7C_SIDEWAY_RISK_PERCENT, 0.25, 0.01, 5);
const MAX_SIDEWAY_LOT = 1.2;
const rawMaxLot = Number(process.env.ZIQ_PHASE7C_SIDEWAY_MAX_LOT ?? "0.03");
if (!Number.isFinite(rawMaxLot) || rawMaxLot < 0.03 - 1e-9 || rawMaxLot > MAX_SIDEWAY_LOT + 1e-9) {
  throw new Error(`Phase 7C Sideway max lot must be between 0.03 and ${MAX_SIDEWAY_LOT}.`);
}
const maxLotUnits = rawMaxLot / 0.03;
if (Math.abs(maxLotUnits - Math.round(maxLotUnits)) > 1e-8) {
  throw new Error("Phase 7C Sideway max lot must use 0.03 increments so +10 can close exactly one-third.");
}
const maxLot = rawMaxLot;
const sidewayFixedTpEnabled = truthy(process.env.ZIQ_PHASE7C_SIDEWAY_FIXED_TP_ENABLED);
const sidewayFixedTpDistance = Number(process.env.ZIQ_PHASE7C_SIDEWAY_FIXED_TP_DISTANCE ?? "0");
if (
  !Number.isFinite(sidewayFixedTpDistance) ||
  sidewayFixedTpDistance < 0 ||
  (sidewayFixedTpEnabled && sidewayFixedTpDistance <= 0)
) {
  throw new Error("Phase 7C Sideway Fixed TP distance must be finite and positive when enabled.");
}
const minRegimeConfidence = clampNumber(process.env.ZIQ_PHASE7C_SIDEWAY_MIN_REGIME_CONFIDENCE, 60, 0, 100);
const regimeCandleCount = clampInteger(process.env.ZIQ_PHASE7C_REGIME_CANDLE_COUNT, 320, 220, 1000);
const m5CandleCount = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_M5_COUNT, 120, 30, 500);
const m5ConfirmationCarryBars = 1;
// Post-fill policy is intentionally NOT an environment toggle: SIDEWAY entry
// filters do not remain position-exit signals. A filled position is protected
// by its broker-native TP/SL and monotonic stop tightening only. Never allow
// silent changes from operator settings or the recommended regime to close it.
const brokerTpSlTrailOnly = true;
const armed = truthy(process.env.ZIQ_PHASE7C_SIDEWAY_ARMED);
const once = truthy(process.env.ZIQ_PHASE7C_SIDEWAY_ONCE);
const workDir = process.env.ZIQ_PHASE7C_SIDEWAY_WORK_DIR?.trim() || path.resolve(".runtime", "phase7c-sideway");
const strategyEntryConditionsFile = process.env.PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE?.trim()
  ? path.resolve(process.env.PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE.trim())
  : path.resolve(process.cwd(), ".runtime", "phase7c-strategy-entry-conditions.json");
const maxHoldingMinutes = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_MAX_HOLD_MINUTES, 180, 30, 720);
const pendingRecoveryWaitMs = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_PENDING_RECOVERY_MS, 60_000, 10_000, 300_000);
const maxQuoteAgeMs = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_MAX_QUOTE_AGE_MS, 30_000, 5_000, 300_000);
const maxM5AgeMs = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_MAX_M5_AGE_MS, 10 * 60_000, 60_000, 60 * 60_000);
const maxM15AgeMs = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_MAX_M15_AGE_MS, 30 * 60_000, 5 * 60_000, 2 * 60 * 60_000);
const autoLotMaxAgeMs = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_AUTO_LOT_MAX_AGE_MS, 10_000, 1_000, 60_000);
const magicNumber = clampInteger(process.env.ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER, 270714, 1, 2147483647);
const trendMagicNumber = clampInteger(process.env.MT5_MAGIC_NUMBER, 270713, 1, 2147483647);
const dailyBotMagicNumbers = new Set([
  trendMagicNumber,
  magicNumber,
]);
const DAILY_RECOVERY_MIN_TP_DISTANCE = 6;
const DAILY_RECOVERY_MAX_TP_DISTANCE = 10;
const DAILY_RECOVERY_TARGET_NET_USD = 1;
const FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE = 10;
const FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE = 10;
const deviationPoints = clampInteger(process.env.MT5_DEVIATION_POINTS, 50, 1, 10000);
const allowReal = truthy(process.env.MT5_ALLOW_REAL_ACCOUNT);
const allowedLogins = new Set(
  String(process.env.MT5_ALLOWED_LOGINS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite),
);

const bridgeBase = process.env.MT5_BRIDGE_BASE_URL?.trim().replace(/\/$/, "") ||
  `http://${process.env.MT5_BRIDGE_HOST || "127.0.0.1"}:${process.env.MT5_BRIDGE_PORT || "8765"}`;
const bridgeApiKey = (process.env.MT5_API_KEY || process.env.MT5_BRIDGE_API_KEY || "").trim();
if (!bridgeApiKey) throw new Error("MT5_API_KEY or MT5_BRIDGE_API_KEY is required for Phase 7C Sideway controller.");
if (allowReal) throw new Error("Phase 7C Sideway controller refuses MT5_ALLOW_REAL_ACCOUNT=true.");

fs.mkdirSync(workDir, { recursive: true });
const statePath = path.join(workDir, "phase7c-sideway-state.json");
const journalPath = path.join(workDir, "phase7c-sideway-events.jsonl");
const decisionAudit = createPhase7CDecisionAudit({
  strategy: "SIDEWAY",
  symbol,
  configuration: { riskPercent, maxLot },
});
const exitSideEvidencePath = path.join(decisionAudit.root, "sideway-exit-side-samples.jsonl");
let state = loadState();

console.log("PHASE7C_SIDEWAY_CONTROLLER=STARTING");
console.log(`PHASE7C_SIDEWAY_SYMBOL=${symbol}`);
console.log(`PHASE7C_CONTROL_API=${controlApiBase}`);
console.log(`PHASE7C_SIDEWAY_ARMED=${armed ? "YES" : "NO"}`);
console.log(`PHASE7C_SIDEWAY_RISK_PERCENT=${riskPercent}`);
console.log(`PHASE7C_SIDEWAY_MAX_LOT=${maxLot}`);
console.log(`PHASE7C_SIDEWAY_MIN_REGIME_CONFIDENCE=${minRegimeConfidence}`);
console.log(`PHASE7C_SIDEWAY_MAX_HOLD_MINUTES=${maxHoldingMinutes}`);
console.log(`PHASE7C_SIDEWAY_PENDING_RECOVERY_MS=${pendingRecoveryWaitMs}`);
console.log(`PHASE7C_SIDEWAY_MAX_QUOTE_AGE_MS=${maxQuoteAgeMs}`);
console.log(`PHASE7C_SIDEWAY_MAX_M5_AGE_MS=${maxM5AgeMs}`);
console.log(`PHASE7C_SIDEWAY_MAX_M15_AGE_MS=${maxM15AgeMs}`);
console.log(`PHASE7C_SIDEWAY_AUTO_LOT_MAX_AGE_MS=${autoLotMaxAgeMs}`);
console.log("PHASE7C_SIDEWAY_ENTRY=M15_RANGING_PLUS_SUPPLY_DEMAND_EDGE_PLUS_M5_CONFIRMATION");
console.log("PHASE7C_SIDEWAY_PLUS6=SL_TO_ENTRY");
console.log("PHASE7C_SIDEWAY_PLUS10=PARTIAL_DISABLED_WHILE_BROKER_TP_SL_TRAIL_ONLY");
console.log(`PHASE7C_SIDEWAY_FAST_MOVE_PROFIT_LOCK=ON|ACTIVATION=+${FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE}|GIVEBACK=${FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE}|SOURCE=LIVE_BID_ASK`);
console.log("PHASE7C_SIDEWAY_TP2=OPPOSITE_RANGE_BOUNDARY");
console.log("PHASE7C_SIDEWAY_MANAGEMENT=BROKER_TP_SL_PLUS_MONOTONIC_STOP_TIGHTENING");
console.log("PHASE7C_SIDEWAY_POST_ENTRY_REGIME_TIME_PARTIAL_SOFTWARE_CLOSE=DISABLED");
console.log("PHASE7C_SIDEWAY_DAILY_RECOVERY=REALIZED_NET_PNL_ALL_BOT_MAGICS");
console.log(`PHASE7C_SIDEWAY_DAILY_RECOVERY_MAGICS=${[...dailyBotMagicNumbers].join(",")}`);
console.log("PHASE7C_SIDEWAY_DAILY_RECOVERY_TP=FULL_POSITION_ADAPTIVE_6_TO_10");
console.log("PHASE7C_SIDEWAY_DAILY_RECOVERY_LOT_ESCALATION=OFF");
console.log("PHASE7C_SIDEWAY_DAILY_RECOVERY_NEW_ENTRIES=TEMPORARILY_DISABLED");
console.log("PHASE7C_SIDEWAY_CRASH_RECOVERY=PENDING_ENTRY_PLUS_PARTIAL_PLUS_BREAK_EVEN");
console.log("PHASE7C_SIDEWAY_FINAL_GATE=FRESH_MODE_REGIME_QUOTE_PLUS_FINAL_AUTO_LOT");
console.log("PHASE7C_SIDEWAY_FAIL_CLOSED=TRUE");
console.log(`PHASE7C_SIDEWAY_STATE=${statePath}`);
console.log(`PHASE7C_SIDEWAY_JOURNAL=${journalPath}`);

await preflight();

if (!armed) {
  await cycle();
  console.log("PHASE7C_SIDEWAY_PREFLIGHT_STATUS=PASS");
  console.log("PHASE7C_SIDEWAY_ORDER_SEND=DISABLED_NOT_ARMED");
  process.exit(0);
}

console.log("PHASE7C_SIDEWAY_PREFLIGHT_STATUS=PASS");
console.log("PHASE7C_SIDEWAY_EXECUTION_STATUS=ARMED_DEMO_ONLY");

while (true) {
  try {
    await cycle();
  } catch (error) {
    journal("CYCLE_ERROR", { message: errorMessage(error) });
    console.error(`PHASE7C_SIDEWAY_CYCLE_ERROR=${errorMessage(error)}`);
  }
  if (once) break;
  await sleep(intervalSeconds * 1000);
}

async function preflight() {
  const health = await bridgeGet("/health");
  console.log(`PHASE7C_SIDEWAY_ACCOUNT_LOGIN=${health.accountLogin ?? "UNKNOWN"}`);
  console.log(`PHASE7C_SIDEWAY_ACCOUNT_MODE=${health.accountMode ?? "UNKNOWN"}`);
  console.log(`PHASE7C_SIDEWAY_SERVER=${health.server ?? "UNKNOWN"}`);
  console.log(`PHASE7C_SIDEWAY_BRIDGE_TRADING_ENABLED=${health.tradingEnabled ? "YES" : "NO"}`);

  if (!health.connected || health.status !== "ok") throw new Error("MT5 bridge is not healthy/connected.");
  if (health.accountMode !== "demo") throw new Error(`Phase 7C Sideway requires accountMode=demo, got ${health.accountMode ?? "unknown"}.`);
  if (!Number.isFinite(Number(health.accountLogin))) throw new Error("MT5 DEMO account login is unavailable.");

  if (state.accountLogin !== null && state.accountLogin !== Number(health.accountLogin)) {
    throw new Error(`Sideway state belongs to account ${state.accountLogin}, current account is ${health.accountLogin}.`);
  }

  if (armed) {
    if (!health.tradingEnabled) throw new Error("MT5 bridge trading is disabled.");
    if (!health.terminalTradeAllowed || !health.expertTradeAllowed) throw new Error("MT5 automated trading is not enabled in terminal/account.");
    if (allowedLogins.size === 0) throw new Error(`MT5_ALLOWED_LOGINS is empty. Add DEMO login ${health.accountLogin} before arming.`);
    if (!allowedLogins.has(Number(health.accountLogin))) throw new Error(`Current DEMO login ${health.accountLogin} is not in MT5_ALLOWED_LOGINS.`);
  }

  state.accountLogin = Number(health.accountLogin);
  saveState();
}

async function cycle() {
  const health = await bridgeGet("/health");
  if (
    health.accountMode !== "demo" ||
    !health.connected ||
    (armed && (!health.tradingEnabled || !health.terminalTradeAllowed || !health.expertTradeAllowed || !allowedLogins.has(Number(health.accountLogin))))
  ) {
    journal("DEMO_GUARD_BLOCK", {
      accountLogin: health.accountLogin,
      accountMode: health.accountMode,
      connected: health.connected,
      tradingEnabled: health.tradingEnabled,
      terminalTradeAllowed: health.terminalTradeAllowed,
      expertTradeAllowed: health.expertTradeAllowed,
    });
    return;
  }

  const [positions, quote, spec] = await Promise.all([
    bridgeGet(`/v1/positions?symbol=${encodeURIComponent(symbol)}`),
    bridgeGet(`/v1/quotes/${encodeURIComponent(symbol)}`),
    bridgeGet(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
  ]);

  const brokerClockOffsetMs = inferBrokerClockOffset(quote?.timestamp, {
    systemTimestamp: health.timestamp,
  });
  if (brokerClockOffsetMs === null) {
    journal("BROKER_CLOCK_OFFSET_BLOCK", {
      healthTimestamp: health.timestamp ?? null,
      quoteTimestamp: quote?.timestamp ?? null,
      reason: "BROKER_CLOCK_NOT_PLAUSIBLE_WHOLE_HOUR_OFFSET",
    });
    return;
  }

  if (!Array.isArray(positions)) {
    journal("POSITIONS_DATA_INVALID", {});
    return;
  }

  if (!state.managed && state.pendingEntry) {
    const pending = state.pendingEntry;
    const recovery = matchPendingEntryPosition(pending, positions, spec, Date.now(), brokerClockOffsetMs);
    if (recovery.matched && recovery.position) {
      state.managed = buildManagedState(recovery.position, pending, brokerClockOffsetMs);
      state.pendingEntry = null;
      saveState();
      journal("PENDING_ENTRY_RECOVERED", {
        orderId: pending.orderId,
        ticket: state.managed.ticket,
        side: state.managed.side,
        volume: state.managed.initialVolume,
      });
      if (state.managed.dailyMode !== "RECOVERY_TP") {
        await reconcileFixedTpBrokerTakeProfit({
          ticket: state.managed.ticket,
          enabled: state.managed.fixedTpEnabled,
          targetPrice: state.managed.fixedTpPrice,
          currentTakeProfit: Number(recovery.position.takeProfit),
          strategy: "SIDEWAY",
        });
      }
      await managePosition(recovery.position, quote, spec, brokerClockOffsetMs);
      return;
    }

    const pendingAgeMs = Math.max(0, Date.now() - Number(pending.createdAt ?? Date.now()));
    if (positions.length === 0 && pendingAgeMs >= pendingRecoveryWaitMs) {
      journal("PENDING_ENTRY_EXPIRED_NO_POSITION", {
        orderId: pending.orderId,
        ageMs: pendingAgeMs,
        recoveryReason: recovery.reason,
      });
      state.pendingEntry = null;
      saveState();
      return;
    }

    journal("PENDING_ENTRY_RECOVERY_BLOCK", {
      orderId: pending.orderId,
      ageMs: pendingAgeMs,
      positions: positions.map((position) => ({
        ticket: position.ticket,
        side: position.side,
        volume: position.volume,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        openedAt: position.openedAt,
      })),
      recoveryReason: recovery.reason,
    });
    return;
  }

  if (state.managed) {
    const managedPosition = positions.find((position) => String(position.ticket) === state.managed.ticket);
    if (!managedPosition) {
      journal("MANAGED_POSITION_CLOSED", { ticket: state.managed.ticket, lastKnownState: state.managed });
      state.managed = null;
      saveState();
      return;
    }
    if (positions.length !== 1) {
      journal("UNEXPECTED_ADDITIONAL_POSITION", { managedTicket: state.managed.ticket, positions: positions.map((position) => position.ticket) });
      return;
    }

    const reconciliation = reconcileManagedBrokerState(state.managed, managedPosition, spec);
    if (!reconciliation.accepted) {
      journal("MANAGED_POSITION_RECONCILIATION_BLOCK", {
        ticket: managedPosition.ticket,
        reason: reconciliation.reason,
        expectedVolume: reconciliation.expectedVolume ?? state.managed.expectedRemainingVolume,
        actualVolume: reconciliation.actualVolume ?? managedPosition.volume,
        expectedSide: state.managed.side === "BUY" ? "LONG" : "SHORT",
        actualSide: managedPosition.side,
      });
      return;
    }

    if (reconciliation.events.length > 0) {
      state.managed = reconciliation.managed;
      saveState();
      for (const event of reconciliation.events) {
        journal(event.type, { ticket: managedPosition.ticket, ...event });
      }
    }

    await managePosition(managedPosition, quote, spec, brokerClockOffsetMs);
    return;
  }

  if (positions.length > 0) {
    journal("UNMANAGED_POSITION_PRESENT", { positions: positions.map((position) => ({ ticket: position.ticket, side: position.side, volume: position.volume })) });
    return;
  }

  const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, { maxAgeMs: maxQuoteAgeMs, clockOffsetMs: brokerClockOffsetMs });
  if (!quoteFreshness.fresh) {
    journal("ENTRY_QUOTE_FRESHNESS_BLOCK", { reason: quoteFreshness.reason, ageMs: quoteFreshness.ageMs, quoteTimestamp: quote?.timestamp ?? null });
    return;
  }

  const maxSpread = Number(spec.maxSpread);
  if (Number.isFinite(maxSpread) && maxSpread > 0 && Number(quote.spread) > maxSpread) {
    journal("ENTRY_SPREAD_BLOCK", { spread: quote.spread, maxSpread });
    return;
  }

  const [modePayload, regime, m5] = await Promise.all([
    controlGet("/api/v1/phase7c/bot-mode"),
    controlGet(`/api/v1/phase7c/live-regime?symbol=${encodeURIComponent(symbol)}&count=${regimeCandleCount}`),
    bridgeGet(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=${m5CandleCount}`),
  ]);

  const latest = Array.isArray(m5) ? m5.at(-1) : null;
  if (!latest || !Number.isFinite(Number(latest.closeTime))) {
    journal("M5_DATA_INVALID", {});
    return;
  }
  const closeTime = Number(latest.closeTime);
  if (closeTime <= state.lastEvaluatedM5Close) return;
  state.lastEvaluatedM5Close = closeTime;
  saveState();

  const m5Freshness = evaluateTimestampFreshness(closeTime, { maxAgeMs: maxM5AgeMs, clockOffsetMs: brokerClockOffsetMs });
  if (!m5Freshness.fresh) {
    journal("ENTRY_M5_FRESHNESS_BLOCK", { closeTime, reason: m5Freshness.reason, ageMs: m5Freshness.ageMs });
    return;
  }

  const regimeFreshness = evaluateTimestampFreshness(regime?.lastCandleCloseTime, { maxAgeMs: maxM15AgeMs, clockOffsetMs: brokerClockOffsetMs });
  if (!regimeFreshness.fresh) {
    journal("ENTRY_M15_FRESHNESS_BLOCK", {
      closeTime: regime?.lastCandleCloseTime ?? null,
      reason: regimeFreshness.reason,
      ageMs: regimeFreshness.ageMs,
    });
    return;
  }

  const activeMode = String(modePayload?.state?.mode ?? "PAUSE").toUpperCase();
  // Active-mode permission remains a hard control gate. AUTO is allowed to reach
  // canonical condition evaluation; recommendedModeSideway itself is configurable.
  const permission = resolveSidewayPermission(activeMode, "SIDEWAY");
  if (!permission.allowed) {
    journal("ENTRY_MODE_BLOCK", permission);
    return;
  }

  const side = regime?.supplyDemandRange
    ? chooseRangeSide(regime.supplyDemandRange, Number(quote.bid), Number(quote.ask))
    : null;
  const confirmation = side
    ? detectM5ConfirmationWithinBars(m5, side, m5ConfirmationCarryBars)
    : null;
  const strategyEntryConfig = readStrategyEntryConfigSnapshot();
  const entryConditions = strategyEntryConfig.valid && strategyEntryConfig.state
    ? evaluateStrategyEntryConditions({
        strategy: "SIDEWAY",
        config: strategyEntryConfig.state,
        side: side ?? "BUY",
        observations: {
          rangingRegime: { passed: regime?.regime === "RANGING", observed: regime?.regime ?? null },
          recommendedModeSideway: { passed: regime?.recommendedMode === "SIDEWAY", observed: regime?.recommendedMode ?? null },
          minimumRegimeConfidence: {
            passed: Number(regime?.confidence ?? 0) >= minRegimeConfidence,
            observed: { confidence: regime?.confidence ?? null, minimum: minRegimeConfidence },
          },
          supplyDemandRange: { passed: Boolean(regime?.supplyDemandRange), observed: regime?.supplyDemandRange ?? null },
          rangeEdge: { passed: side !== null, observed: side },
          m5Confirmation: {
            passed: Boolean(confirmation),
            observed: confirmation?.pattern ?? null,
          },
        },
      })
    : null;

  if (!entryConditions || !entryConditions.allEnabledPassed) {
    journal("ENTRY_STRATEGY_CONDITION_BLOCK", {
      closeTime,
      side,
      reason: entryConditions
        ? entryConditions.failedConditions.join(",")
        : "ENTRY_STRATEGY_CONFIG_INVALID",
      configError: strategyEntryConfig.error,
      entryConditions,
    });
    return;
  }

  journal("ENTRY_STRATEGY_CONDITIONS_PASS", {
    closeTime,
    side,
    confirmation,
    entryConditions,
  });

  if (!side || !regime?.supplyDemandRange) {
    journal("ENTRY_PLAN_BLOCK", { closeTime, side, reason: "RANGE_DATA_REQUIRED_FOR_SIDEWAY_PLAN" });
    return;
  }

  const lower = Number(regime.supplyDemandRange.demand.high);
  const upper = Number(regime.supplyDemandRange.supply.low);
  const poc = estimateVolumePoc(m5.slice(-96), lower, upper, 24);
  const initialPlan = buildSidewayPlan({
    side,
    bid: Number(quote.bid),
    ask: Number(quote.ask),
    range: regime.supplyDemandRange,
    atr: Number(regime.metrics?.atr),
    poc,
    point: Number(spec.point),
    stopsLevelTicks: Number(spec.stopsLevelTicks ?? 0),
    digits: Number(spec.digits ?? 2),
  });

  if (!initialPlan.accepted) {
    journal("ENTRY_PLAN_BLOCK", { closeTime, side, plan: initialPlan });
    return;
  }

  // Re-check all mutable market/control inputs immediately before calculating
  // the final risk and submitting the order. Auto Lot deliberately runs after
  // this gate so its stop distance belongs to the final broker-facing plan.
  const [freshMode, freshRegime, freshQuote] = await Promise.all([
    controlGet("/api/v1/phase7c/bot-mode"),
    controlGet(`/api/v1/phase7c/live-regime?symbol=${encodeURIComponent(symbol)}&count=${regimeCandleCount}`),
    bridgeGet(`/v1/quotes/${encodeURIComponent(symbol)}`),
  ]);
  const finalPermission = resolveSidewayPermission(freshMode?.state?.mode, "SIDEWAY");
  const finalQuoteFreshness = evaluateTimestampFreshness(freshQuote?.timestamp, { maxAgeMs: maxQuoteAgeMs, clockOffsetMs: brokerClockOffsetMs });
  const finalRegimeFreshness = evaluateTimestampFreshness(freshRegime?.lastCandleCloseTime, { maxAgeMs: maxM15AgeMs, clockOffsetMs: brokerClockOffsetMs });
  const finalSide = freshRegime?.supplyDemandRange
    ? chooseRangeSide(freshRegime.supplyDemandRange, Number(freshQuote?.bid), Number(freshQuote?.ask))
    : null;
  const finalSpreadBlocked = Number.isFinite(maxSpread) && maxSpread > 0 && Number(freshQuote?.spread) > maxSpread;
  const finalEntryConditions = strategyEntryConfig.valid && strategyEntryConfig.state
    ? evaluateStrategyEntryConditions({
        strategy: "SIDEWAY",
        config: strategyEntryConfig.state,
        side: finalSide ?? side,
        observations: {
          rangingRegime: { passed: freshRegime?.regime === "RANGING", observed: freshRegime?.regime ?? null },
          recommendedModeSideway: { passed: freshRegime?.recommendedMode === "SIDEWAY", observed: freshRegime?.recommendedMode ?? null },
          minimumRegimeConfidence: {
            passed: Number(freshRegime?.confidence ?? 0) >= minRegimeConfidence,
            observed: { confidence: freshRegime?.confidence ?? null, minimum: minRegimeConfidence },
          },
          supplyDemandRange: { passed: Boolean(freshRegime?.supplyDemandRange), observed: freshRegime?.supplyDemandRange ?? null },
          rangeEdge: { passed: finalSide !== null, observed: finalSide },
          m5Confirmation: {
            passed: Boolean(confirmation),
            observed: confirmation?.pattern ?? null,
          },
        },
      })
    : null;

  if (!finalEntryConditions || !finalEntryConditions.allEnabledPassed) {
    journal("ENTRY_STRATEGY_CONDITION_BLOCK", {
      closeTime,
      side: finalSide,
      phase: "FINAL_GATE",
      reason: finalEntryConditions
        ? finalEntryConditions.failedConditions.join(",")
        : "ENTRY_STRATEGY_CONFIG_INVALID",
      configError: strategyEntryConfig.error,
      entryConditions: finalEntryConditions,
    });
    return;
  }

  if (
    !finalPermission.allowed ||
    !finalQuoteFreshness.fresh ||
    !finalRegimeFreshness.fresh ||
    finalSpreadBlocked ||
    finalSide !== side
  ) {
    journal("ENTRY_FINAL_GATE_BLOCK", {
      finalPermission,
      regime: freshRegime?.regime ?? null,
      confidence: freshRegime?.confidence ?? null,
      minRegimeConfidence,
      hasRange: Boolean(freshRegime?.supplyDemandRange),
      finalSide,
      expectedSide: side,
      quoteFreshness: finalQuoteFreshness,
      regimeFreshness: finalRegimeFreshness,
      spread: freshQuote?.spread ?? null,
      maxSpread,
      entryConditions: finalEntryConditions,
    });
    return;
  }

  const finalPlan = buildSidewayPlan({
    side,
    bid: Number(freshQuote.bid),
    ask: Number(freshQuote.ask),
    range: freshRegime.supplyDemandRange,
    atr: Number(freshRegime.metrics?.atr),
    poc,
    point: Number(spec.point),
    stopsLevelTicks: Number(spec.stopsLevelTicks ?? 0),
    digits: Number(spec.digits ?? 2),
  });
  if (!finalPlan.accepted) {
    journal("ENTRY_FINAL_PLAN_BLOCK", { closeTime, side, plan: finalPlan });
    return;
  }

  const autoLot = await controlGet(
    `/api/v1/phase7c/auto-lot-preview?stopDistance=${encodeURIComponent(finalPlan.stopDistance)}&riskPercent=${encodeURIComponent(riskPercent)}&maxLot=${encodeURIComponent(maxLot)}`,
  );
  const autoLotValidation = validateAutoLotSnapshot(autoLot, {
    accountLogin: Number(health.accountLogin),
    accountMode: String(health.accountMode ?? "").toLowerCase(),
    brokerSymbol: String(spec.brokerSymbol ?? ""),
    riskPercent,
    maxLot,
    stopDistance: Number(finalPlan.stopDistance),
    maxAgeMs: autoLotMaxAgeMs,
  });
  if (!autoLotValidation.accepted) {
    journal("ENTRY_AUTO_LOT_BLOCK", {
      closeTime,
      side,
      stopDistance: finalPlan.stopDistance,
      validation: autoLotValidation,
      preview: autoLot?.preview ?? null,
    });
    return;
  }

  const volume = Number(autoLotValidation.recommendedLot);
  validateVolume(volume, spec);

  const dailyRecovery = await resolveDailyRecoveryPlan(
    freshQuote,
    spec,
    volume,
  );

  const recoveryTakeProfit =
    dailyRecovery.mode === "RECOVERY_TP"
      ? roundRecoveryPrice(
          side === "BUY"
            ? Number(finalPlan.entry) + dailyRecovery.tpDistance
            : Number(finalPlan.entry) - dailyRecovery.tpDistance,
          Number(spec.digits ?? 2),
        )
      : Number(finalPlan.takeProfit);

  const executionPlan =
    dailyRecovery.mode === "RECOVERY_TP"
      ? {
          ...finalPlan,
          takeProfit: recoveryTakeProfit,
        }
      : finalPlan;

  const orderId = `p7c-sideway-${closeTime}-${side}`;
  journal("ENTRY_SUBMIT", {
    orderId,
    closeTime,
    side,
    confirmation: confirmation.pattern,
    confirmationCloseTime: confirmation.closeTime,
    confirmationAgeBars: confirmation.ageBars ?? 0,
    volume,
    riskPercent,
    rawLot: autoLot?.preview?.rawLot ?? null,
    maxLot,
    estimatedRiskUsd: autoLotValidation.estimatedRiskUsd,
    estimatedRiskPercent: autoLot?.preview?.estimatedRiskPercent ?? null,
    lotLimitReason: `Raw ${autoLot?.preview?.rawLot ?? "n/a"} -> final ${volume}; cap ${maxLot}; broker step + exact one-third partial guard applied.`,
    plan: executionPlan,
    activeMode: freshMode?.state?.mode ?? null,
    recommendedMode: freshRegime?.recommendedMode ?? null,
    regime: freshRegime?.regime ?? null,
    regimeConfidence: freshRegime?.confidence,
    engineReasons: Array.isArray(freshRegime?.reasons) ? freshRegime.reasons : [],
    finalQuoteTimestamp: freshQuote.timestamp,
    dailyMode: dailyRecovery.mode,
    dailyNetPnl: dailyRecovery.dailyNetPnl,
    recoveryTargetNetPnl: dailyRecovery.targetNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
    recoveryTakeProfit,
    recoveryCanRecoverInOneTrade: dailyRecovery.canRecoverInOneTrade,
    entryConditions: finalEntryConditions,
  });

  if (!armed) {
    journal("ENTRY_SHADOW_READY", {
      orderId,
      side,
      volume,
      plan: executionPlan,
      dailyMode: dailyRecovery.mode,
      dailyNetPnl: dailyRecovery.dailyNetPnl,
      recoveryTpDistance: dailyRecovery.tpDistance,
    });
    return;
  }

  const currentStrategyConfig = readStrategyEntryConfigSnapshot();
  const versionGuard = compareStrategyEntryConfigVersion(
    { version: strategyEntryConfig.version, valid: strategyEntryConfig.valid },
    { version: currentStrategyConfig.version, valid: currentStrategyConfig.valid },
  );
  if (!versionGuard.ok) {
    const reasonCode = versionGuard.reasonCode === "ENTRY_CONFIG_VERSION_CHANGED"
      ? "ENTRY_CONFIG_VERSION_CHANGED"
      : "ENTRY_STRATEGY_CONFIG_INVALID";
    journal(reasonCode, {
      closeTime,
      side,
      reasonCode,
      cycleConfigVersion: strategyEntryConfig.version,
      currentConfigVersion: currentStrategyConfig.version,
      configError: currentStrategyConfig.error,
      entryConditions: finalEntryConditions,
    });
    return;
  }

  const fixedTpSnapshot = buildFixedTpSnapshot({
    enabled: sidewayFixedTpEnabled,
    distance: sidewayFixedTpDistance,
    side,
    entry: Number(finalPlan.entry),
  });
  const brokerTakeProfit = dailyRecovery.mode === "RECOVERY_TP"
    ? executionPlan.takeProfit
    : fixedTpSnapshot.enabled && fixedTpSnapshot.targetPrice !== null
      ? fixedTpSnapshot.targetPrice
      : executionPlan.takeProfit;
  journal("FIXED_TP_CONFIG_SNAPSHOT", {
    strategy: "SIDEWAY",
    orderId,
    side,
    entry: Number(finalPlan.entry),
    fixedTpEnabled: fixedTpSnapshot.enabled,
    fixedTpDistance: fixedTpSnapshot.distance,
    fixedTpPrice: fixedTpSnapshot.targetPrice,
  });

  state.pendingEntry = {
    orderId,
    side,
    signalM5CloseTime: closeTime,
    volume,
    stopLoss: executionPlan.stopLoss,
    stopDistance: executionPlan.stopDistance,
    tp1: executionPlan.tp1,
    tp1Kind: executionPlan.tp1Kind,
    tp2: executionPlan.takeProfit,
    fixedTpEnabled: fixedTpSnapshot.enabled,
    fixedTpDistance: fixedTpSnapshot.distance,
    fixedTpPrice: fixedTpSnapshot.targetPrice,
    dailyMode: dailyRecovery.mode,
    dailyNetPnlAtEntry: dailyRecovery.dailyNetPnl,
    recoveryTargetNetPnl: dailyRecovery.targetNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
    recoveryTakeProfit,
    recoveryDayStartTime: dailyRecovery.dayStartTime,
    lastRegimeCloseChecked: Number(freshRegime?.lastCandleCloseTime ?? 0),
    createdAt: Date.now(),
  };
  saveState();
  journal("ENTRY_PENDING_DURABLE", {
    orderId,
    side,
    volume,
    stopLoss: executionPlan.stopLoss,
    tp2: executionPlan.takeProfit,
    dailyMode: dailyRecovery.mode,
    dailyNetPnl: dailyRecovery.dailyNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
  });

  // Re-read canonical mode at the actual submit boundary. SEMI is manual-entry-only;
  // clearing our own durable pending marker here does not touch any broker position.
  const submitMode = await controlGet("/api/v1/phase7c/bot-mode");
  const submitActiveMode = String(submitMode?.state?.mode ?? "PAUSE").toUpperCase();
  if (submitActiveMode === "SEMI") {
    journal("ENTRY_SEMI_MODE_BLOCK", {
      orderId,
      side,
      cycleMode: freshMode?.state?.mode ?? null,
      submitMode: submitActiveMode,
      reason: "SEMI_MANUAL_ENTRY_ONLY",
    });
    state.pendingEntry = null;
    saveState();
    return;
  }

  const order = await bridgeRequest("POST", "/v1/orders", {
    symbol,
    side,
    orderType: "MARKET",
    timeInForce: "GTC",
    volume,
    requestedPrice: executionPlan.entry,
    stopLoss: executionPlan.stopLoss,
    takeProfit: brokerTakeProfit,
    deviationPoints,
    magicNumber,
    comment: "phase7c-sideway",
    clientOrderId: orderId,
    idempotencyKey: orderId,
  });

  if (!order.accepted) {
    journal("ENTRY_REJECTED", { orderId, message: order.message, retcode: order.retcode });
    state.pendingEntry = null;
    saveState();
    return;
  }

  let opened = order.position ?? null;
  if (!opened) {
    const after = await bridgeGet(`/v1/positions?symbol=${encodeURIComponent(symbol)}`);
    if (Array.isArray(after) && after.length === 1) opened = after[0];
  }
  if (!opened) {
    journal("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED", { orderId, ticket: order.ticket, fillPrice: order.fillPrice });
    return;
  }

  state.managed = buildManagedState(opened, state.pendingEntry, brokerClockOffsetMs);
  state.pendingEntry = null;
  saveState();
  journal("ENTRY_FILLED", { orderId, position: opened, management: state.managed });
  if (state.managed.dailyMode !== "RECOVERY_TP") {
    await reconcileFixedTpBrokerTakeProfit({
      ticket: state.managed.ticket,
      enabled: state.managed.fixedTpEnabled,
      targetPrice: state.managed.fixedTpPrice,
      currentTakeProfit: Number(opened.takeProfit),
      strategy: "SIDEWAY",
    });
  }
}

function readStrategyEntryConfigSnapshot() {
  if (!fs.existsSync(strategyEntryConditionsFile)) {
    const state = createVirtualStrategyEntryConditionState();
    return { version: state.version, valid: true, state, error: null };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(strategyEntryConditionsFile, "utf8"));
    const validation = validateStrategyEntryConditionState(raw, {
      allowVirtualVersionZero: false,
    });
    if (!validation.valid) {
      return {
        version: Number.isInteger(raw?.version) ? Number(raw.version) : 0,
        valid: false,
        state: null,
        error: validation.error,
      };
    }
    return {
      version: validation.state.version,
      valid: true,
      state: validation.state,
      error: null,
    };
  } catch (error) {
    return {
      version: 0,
      valid: false,
      state: null,
      error: errorMessage(error),
    };
  }
}

async function resolveDailyRecoveryPlan(
  quote,
  spec,
  volume,
) {
  const boundary = await bridgeGet(
    `/v1/session/day-boundary/${encodeURIComponent(symbol)}`,
  );

  const dayStartTime = Number(boundary?.currentStartTime);
  const historyEndTime = Number(quote?.timestamp);

  if (
    !Number.isFinite(dayStartTime) ||
    dayStartTime <= 0 ||
    !Number.isFinite(historyEndTime) ||
    historyEndTime <= dayStartTime
  ) {
    throw new Error(
      "Sideway daily recovery broker day boundary is invalid.",
    );
  }

  const deals = await bridgeGet(
    `/v1/history/deals?fromMs=${dayStartTime}&toMs=${historyEndTime}&symbol=${encodeURIComponent(symbol)}`,
  );

  if (!Array.isArray(deals)) {
    throw new Error(
      "Sideway daily recovery deal history is invalid.",
    );
  }

  const { dealCount, dailyNetPnl } =
    summarizeBrokerDayRealizedPnl(
      deals,
      dailyBotMagicNumbers,
    );

  if (dailyNetPnl >= 0) {
    return {
      mode: "SIDEWAY_NATIVE",
      dayStartTime,
      dailyNetPnl,
      targetNetPnl: DAILY_RECOVERY_TARGET_NET_USD,
      requiredUsd: 0,
      rawTpDistance: 0,
      tpDistance: 0,
      canRecoverInOneTrade: true,
      dealCount: dealCount,
    };
  }

  const cashPerPriceUnitPerLot =
    Number(spec?.cashPerPriceUnitPerLot) > 0
      ? Number(spec.cashPerPriceUnitPerLot)
      : Number(spec?.tickSize) > 0 &&
          Number(spec?.effectiveTickValuePerLot) > 0
        ? Number(spec.effectiveTickValuePerLot) /
          Number(spec.tickSize)
        : 0;

  if (!(cashPerPriceUnitPerLot > 0)) {
    throw new Error(
      "Sideway daily recovery cannot determine cash per price unit.",
    );
  }

  const cashPerPriceUnit =
    cashPerPriceUnitPerLot * Number(volume);

  if (!(cashPerPriceUnit > 0)) {
    throw new Error(
      "Sideway daily recovery volume cash value is invalid.",
    );
  }

  const requiredUsd =
    Math.abs(dailyNetPnl) +
    DAILY_RECOVERY_TARGET_NET_USD;

  const rawTpDistance =
    requiredUsd /
    cashPerPriceUnit;

  const tpDistance = Math.min(
    DAILY_RECOVERY_MAX_TP_DISTANCE,
    Math.max(
      DAILY_RECOVERY_MIN_TP_DISTANCE,
      rawTpDistance,
    ),
  );

  return pauseDailyRecoveryForNewEntry("SIDEWAY", {
    mode: "RECOVERY_TP",
    dayStartTime,
    dailyNetPnl,
    targetNetPnl: DAILY_RECOVERY_TARGET_NET_USD,
    requiredUsd,
    rawTpDistance,
    tpDistance,
    canRecoverInOneTrade:
      rawTpDistance <= DAILY_RECOVERY_MAX_TP_DISTANCE + 1e-9,
    dealCount: dealCount,
  });
}

function roundRecoveryPrice(value, digits) {
  const safeDigits = Math.max(
    0,
    Math.min(10, Math.trunc(Number(digits) || 0)),
  );

  return Number(
    Number(value).toFixed(safeDigits),
  );
}

function buildManagedState(opened, pending, brokerClockOffsetMs = 0) {
  if (!pending) throw new Error("Cannot build Sideway management state without durable pending entry metadata.");
  const brokerOpenedAt = Number(opened.openedAt);
  const normalizedOpenedAt = normalizeBrokerTimestamp(brokerOpenedAt, brokerClockOffsetMs);
  const openedAt = Number.isFinite(normalizedOpenedAt) ? normalizedOpenedAt : Date.now();
  const fixedTpSnapshot = buildFixedTpSnapshot({
    enabled: pending.fixedTpEnabled,
    distance: pending.fixedTpDistance,
    side: pending.side,
    entry: Number(opened.entry),
  });
  return {
    ticket: String(opened.ticket),
    side: pending.side,
    signalM5CloseTime: Number(pending.signalM5CloseTime),
    entry: Number(opened.entry),
    initialVolume: Number(opened.volume),
    expectedRemainingVolume: Number(opened.volume),
    stopLoss: Number(pending.stopLoss),
    stopDistance: Math.abs(Number(opened.entry) - Number(pending.stopLoss)),
    tp1: Number(pending.tp1),
    tp1Kind: pending.tp1Kind,
    tp2: Number(pending.tp2),
    fixedTpEnabled: fixedTpSnapshot.enabled,
    fixedTpDistance: fixedTpSnapshot.distance,
    fixedTpPrice: fixedTpSnapshot.targetPrice,
    dailyMode: pending.dailyMode ?? "SIDEWAY_NATIVE",
    dailyNetPnlAtEntry: Number(pending.dailyNetPnlAtEntry ?? 0),
    recoveryTargetNetPnl: Number(pending.recoveryTargetNetPnl ?? 0),
    recoveryTpDistance: Number(pending.recoveryTpDistance ?? 0),
    recoveryTakeProfit: Number(pending.recoveryTakeProfit ?? 0),
    recoveryDayStartTime: Number(pending.recoveryDayStartTime ?? 0),
    partialApplied: false,
    breakEvenApplied: false,
    lastRegimeCloseChecked: Number(pending.lastRegimeCloseChecked ?? 0),
    lastHoldM15Key: "",
    openedAt,
    timeStopAt: openedAt + maxHoldingMinutes * 60_000,
    partialAttempt: 0,
    breakEvenAttempt: 0,
    fastMovePeakPrice: Number(opened.entry),
    fastMoveStop: Number(pending.stopLoss),
    fastMoveAttempt: 0,
    exitAttempt: 0,
  };
}

async function reconcileFixedTpBrokerTakeProfit(input) {
  if (!input?.enabled || !Number.isFinite(Number(input.targetPrice)) || Number(input.targetPrice) <= 0) return;
  const ticket = String(input.ticket);
  const targetPrice = Number(input.targetPrice);
  const currentTakeProfit = Number(input.currentTakeProfit);
  if (Number.isFinite(currentTakeProfit) && Math.abs(currentTakeProfit - targetPrice) <= 1e-9) {
    journal("FIXED_TP_BROKER_ALREADY_ALIGNED", { ticket, strategy: input.strategy, takeProfit: targetPrice });
    return;
  }
  const commandId = `phase7c-fixed-tp-broker-sideway-${ticket}`;
  const payload = {
    takeProfit: targetPrice,
    commandId,
  };
  journal("FIXED_TP_BROKER_RECONCILE_ATTEMPT", {
    ticket,
    strategy: input.strategy,
    currentTakeProfit: Number.isFinite(currentTakeProfit) ? currentTakeProfit : null,
    targetPrice,
    commandId,
  });
  try {
    const response = await bridgeRequest(
      "PATCH",
      `/v1/positions/${encodeURIComponent(ticket)}`,
      payload,
    );
    if (!response.success) {
      journal("FIXED_TP_BROKER_RECONCILE_REJECTED", { ticket, strategy: input.strategy, targetPrice, commandId, response });
      return;
    }
    journal("FIXED_TP_BROKER_RECONCILED", { ticket, strategy: input.strategy, targetPrice, commandId, response });
  } catch (error) {
    journal("FIXED_TP_BROKER_RECONCILE_ERROR", {
      ticket,
      strategy: input.strategy,
      targetPrice,
      commandId,
      message: errorMessage(error),
    });
  }
}

async function closeFixedTpIfTriggered(position, quote) {
  const managed = state.managed;

  // Preserve the additive OFF path: no extra broker I/O when the immutable
  // managed snapshot has Fixed TP disabled.
  if (!managed?.fixedTpEnabled || !Number.isFinite(Number(managed.fixedTpPrice))) {
    return false;
  }

  if (!isFixedTpTriggered({
    enabled: managed.fixedTpEnabled,
    side: managed.side,
    targetPrice: managed.fixedTpPrice,
    bid: quote.bid,
    ask: quote.ask,
  })) {
    return false;
  }

  journal("FIXED_TP_TRIGGERED", {
    ticket: managed.ticket,
    side: managed.side,
    targetPrice: managed.fixedTpPrice,
    bid: quote.bid,
    ask: quote.ask,
  });

  let positions;
  try {
    positions = await bridgeGet(
      `/v1/positions?symbol=${encodeURIComponent(symbol)}`,
    );
  } catch (error) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      reason: "FIXED_TP_RECONCILE_ERROR",
      message: errorMessage(error),
    });
    return true;
  }

  if (!Array.isArray(positions) || positions.length !== 1) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      reason: "FIXED_TP_RECONCILE_REQUIRES_EXACTLY_ONE_POSITION",
      positions: Array.isArray(positions)
        ? positions.map((row) => ({ ticket: row.ticket, side: row.side, volume: row.volume }))
        : null,
    });
    return true;
  }

  // Reconcile at the actual Fixed TP decision point. If the native +10 partial
  // already succeeded in this cycle, this snapshot contains only the broker's
  // current remaining volume.
  position = positions[0];

  if (position.ticket !== managed.ticket) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      actualTicket: position.ticket,
      reason: "MANAGED_TICKET_MISMATCH",
    });
    return true;
  }

  const expectedSide = managed.side === "BUY" ? "LONG" : "SHORT";
  if (position.side !== expectedSide) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      expectedSide,
      actualSide: position.side,
      reason: "MANAGED_SIDE_MISMATCH",
    });
    return true;
  }

  if (!(Number.isFinite(Number(position.volume)) && Number(position.volume) > 0)) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      volume: position.volume,
      reason: "POSITION_VOLUME_INVALID",
    });
    return true;
  }

  const commandId = fixedTpCommandId("sideway", managed.ticket);
  const lock = acquireExecutionLock({
    owner: `SIDEWAY_FIXED_TP:${managed.ticket}`,
  });

  if (!lock.acquired) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      commandId,
      reason: lock.reason ?? "LOCK_BUSY",
      lockFile: lock.file,
      lockAgeMs: lock.ageMs ?? null,
    });
    return true;
  }

  try {
    journal("FIXED_TP_CLOSE_ATTEMPT", {
      ticket: managed.ticket,
      side: managed.side,
      volume: Number(position.volume),
      targetPrice: managed.fixedTpPrice,
      commandId,
    });

    const response = await bridgeRequest(
      "POST",
      `/v1/positions/${encodeURIComponent(managed.ticket)}/close`,
      {
        volume: Number(position.volume),
        commandId,
      },
    );

    if (!response.success) {
      journal("FIXED_TP_CLOSE_BLOCKED", {
        ticket: managed.ticket,
        commandId,
        volume: Number(position.volume),
        reason: "BROKER_CLOSE_REJECTED",
        response,
      });
      return true;
    }

    if (response.idempotentReplay) {
      journal("FIXED_TP_CLOSE_REPLAY", {
        ticket: managed.ticket,
        commandId,
        volume: Number(position.volume),
        response,
      });
    } else {
      journal("FIXED_TP_CLOSE_CONFIRMED", {
        ticket: managed.ticket,
        commandId,
        volume: Number(position.volume),
        response,
      });
    }

    state.managed = null;
    saveState();
    return true;
  } catch (error) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      commandId,
      volume: Number(position.volume),
      reason: "BROKER_CLOSE_ERROR",
      message: errorMessage(error),
    });
    return true;
  } finally {
    lock.release();
  }
}

function recordManagementExitSideSample({ managed, quote, exitSidePrice }) {
  const timestamp = Number(quote.timestamp);
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    ask < bid ||
    !Number.isFinite(exitSidePrice) ||
    exitSidePrice <= 0
  ) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(exitSideEvidencePath), { recursive: true });
    const record = {
      event: "MANAGEMENT_EXIT_SIDE_SAMPLE",
      source: "CANONICAL_MANAGEMENT_OBSERVED_QUOTE",
      strategy: "SIDEWAY",
      symbol,
      timestamp: Number(quote.timestamp),
      ticket: managed.ticket,
      side: managed.side,
      bid: Number(quote.bid),
      ask: Number(quote.ask),
      exitSidePrice,
      evidenceVersion: 1,
    };
    fs.appendFileSync(exitSideEvidencePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn(`PHASE7C_SIDEWAY_EVIDENCE_WRITE_SKIPPED=${errorMessage(error)}`);
  }
}

async function managePosition(position, quote, spec, brokerClockOffsetMs = 0) {
  const managed = state.managed;

  // Legacy time-stop and regime-based liquidation are intentionally unreachable
  // under the locked broker-target-only policy. Entry gating is unchanged.
  if (!brokerTpSlTrailOnly) {
  if (Date.now() >= managed.timeStopAt) {
    await closeAll(position, `TIME_STOP_${maxHoldingMinutes}M`);
    return;
  }

  try {
    const regime = await controlGet(`/api/v1/phase7c/live-regime?symbol=${encodeURIComponent(symbol)}&count=${regimeCandleCount}`);
    const regimeClose = Number(regime?.lastCandleCloseTime ?? 0);
    const regimeFreshness = evaluateTimestampFreshness(regimeClose, { maxAgeMs: maxM15AgeMs, clockOffsetMs: brokerClockOffsetMs });
    if (!regimeFreshness.fresh) {
      journal("MANAGEMENT_REGIME_FRESHNESS_SKIP", {
        ticket: managed.ticket,
        closeTime: regimeClose,
        reason: regimeFreshness.reason,
        ageMs: regimeFreshness.ageMs,
      });
    } else if (regimeClose > managed.lastRegimeCloseChecked) {
      managed.lastRegimeCloseChecked = regimeClose;
      saveState();
      if (regime?.regime !== "RANGING" || regime?.recommendedMode !== "SIDEWAY") {
        journal("MANAGEMENT_REGIME_INVALIDATION", {
          ticket: managed.ticket,
          regime: regime?.regime ?? null,
          recommendedMode: regime?.recommendedMode ?? null,
          closeTime: regimeClose,
        });
        await closeAll(position, "REGIME_LEFT_RANGE");
        return;
      }
    }
  } catch (error) {
    // Existing broker SL/TP remains active. A control API outage must never
    // trigger a blind close or abandon management state.
    journal("MANAGEMENT_REGIME_CHECK_ERROR", { ticket: managed.ticket, message: errorMessage(error) });
  }
  }

  const holdM15CloseTime = Number(managed.lastRegimeCloseChecked ?? 0);

  const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, { maxAgeMs: maxQuoteAgeMs, clockOffsetMs: brokerClockOffsetMs });
  if (!quoteFreshness.fresh) {
    journal("MANAGEMENT_QUOTE_FRESHNESS_SKIP", {
      ticket: managed.ticket,
      reason: quoteFreshness.reason,
      ageMs: quoteFreshness.ageMs,
      quoteTimestamp: quote?.timestamp ?? null,
      note: "Broker SL/TP remains active; dynamic TP1/BE/Fast-Move actions are skipped on stale quote data.",
    });
    return;
  }

  const marketPrice = managed.side === "BUY" ? Number(quote.bid) : Number(quote.ask);
  const favorable = managed.side === "BUY"
    ? marketPrice - managed.entry
    : managed.entry - marketPrice;
  recordManagementExitSideSample({ managed, quote, exitSidePrice: marketPrice });

  if (!managed.breakEvenApplied && favorable >= 6) {
    const beStop = roundPrice(managed.entry, Number(spec.digits ?? 2));
    if (stopIsAtLeastAsTight(managed.side, Number(position.stopLoss), beStop)) {
      managed.breakEvenApplied = true;
      saveState();
      journal("PLUS6_SL_ALREADY_AT_OR_TIGHTER", {
        ticket: managed.ticket,
        favorable,
        entry: beStop,
        stopLoss: Number(position.stopLoss),
      });
    } else {
      const minimumGap = Math.max(Number(spec.stopsLevelTicks ?? 0), Number(spec.freezeLevelTicks ?? 0)) * Number(spec.point);
      const valid = managed.side === "BUY"
        ? beStop < Number(quote.bid) - minimumGap
        : beStop > Number(quote.ask) + minimumGap;
      if (valid) {
        managed.breakEvenAttempt += 1;
        saveState();
        const response = await bridgeRequest("PATCH", `/v1/positions/${encodeURIComponent(managed.ticket)}`, {
          stopLoss: beStop,
          commandId: `p7c-sideway-plus6-be-${managed.ticket}-${managed.breakEvenAttempt}`,
        });
        if (response.success) {
          managed.breakEvenApplied = true;
          saveState();
          journal("PLUS6_SL_TO_ENTRY", { ticket: managed.ticket, favorable, stopLoss: beStop });
        } else {
          journal("PLUS6_SL_REJECTED", { ticket: managed.ticket, favorable, response });
        }
      }
    }
  }

  if (!brokerTpSlTrailOnly) {
  if (managed.dailyMode === "RECOVERY_TP") {
    if (await closeFixedTpIfTriggered(position, quote)) return;

    const hold =
      canonicalHoldReason(
        "SIDEWAY",
        managed,
      );

    const holdKey =
      hold
        ? `${managed.ticket}|${hold.reasonCode}|${holdM15CloseTime}`
        : "";

    if (
      hold &&
      holdM15CloseTime > 0 &&
      holdKey !== managed.lastHoldM15Key
    ) {
      managed.lastHoldM15Key = holdKey;
      saveState();

      journal("HOLD_POSITION", {
        ticket: managed.ticket,
        side: managed.side,
        m15CloseTime: holdM15CloseTime,
        dailyMode:
          managed.dailyMode,
        ...hold,
      });
    }

    return;
  }
  }

  const fastMove = fastMoveProfitLockCandidate({
    side: managed.side,
    entry: managed.entry,
    marketPrice,
    previousPeakPrice: managed.fastMovePeakPrice,
    activationDistance: FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE,
    givebackDistance: FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE,
  });
  const previousFastMovePeak = Number(managed.fastMovePeakPrice);
  if (
    fastMove.peakPrice > 0 &&
    (!Number.isFinite(previousFastMovePeak) || Math.abs(previousFastMovePeak - fastMove.peakPrice) > 1e-9)
  ) {
    managed.fastMovePeakPrice = fastMove.peakPrice;
    saveState();
  }

  if (fastMove.active) {
    const candidate = roundPrice(fastMove.candidateStop, Number(spec.digits ?? 2));
    const fastMoveBaseline = tightestKnownStop(
      managed.side,
      Number(position.stopLoss),
      Number(managed.fastMoveStop),
      managed.breakEvenApplied ? Number(managed.entry) : 0,
    );
    if (stopStrictlyTightens(managed.side, fastMoveBaseline, candidate)) {
      const minimumGap = Math.max(Number(spec.stopsLevelTicks ?? 0), Number(spec.freezeLevelTicks ?? 0)) * Number(spec.point);
      const validAgainstMarket = managed.side === "BUY"
        ? candidate < Number(quote.bid) - minimumGap
        : candidate > Number(quote.ask) + minimumGap;
      if (validAgainstMarket) {
        managed.fastMoveAttempt = Number(managed.fastMoveAttempt ?? 0) + 1;
        saveState();
        const response = await bridgeRequest("PATCH", `/v1/positions/${encodeURIComponent(managed.ticket)}`, {
          stopLoss: candidate,
          commandId: `p7c-sideway-fast-lock-${managed.ticket}-${managed.fastMoveAttempt}`,
        });
        if (response.success) {
          managed.fastMoveStop = candidate;
          saveState();
          journal("FAST_MOVE_PROFIT_LOCK_TIGHTEN", {
            ticket: managed.ticket,
            side: managed.side,
            favorable,
            peakPrice: fastMove.peakPrice,
            peakFavorable: fastMove.peakFavorable,
            giveback: FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE,
            stopLoss: candidate,
          });
        } else {
          journal("FAST_MOVE_PROFIT_LOCK_REJECTED", {
            ticket: managed.ticket,
            side: managed.side,
            favorable,
            peakPrice: fastMove.peakPrice,
            stopLoss: candidate,
            response,
          });
        }
      }
    }
  }

  // A native broker TP/SL is authoritative after entry; never even evaluate a
  // discretionary partial-close condition in this locked policy.
  if (!brokerTpSlTrailOnly && managed.breakEvenApplied && !managed.partialApplied && targetReached(managed.side, marketPrice, managed.tp1)) {
    const closeVolume = oneThirdPartialVolume(
      managed.initialVolume,
      Number(position.volume),
      Number(spec.minVolume),
      Number(spec.volumeStep),
    );
    if (!(closeVolume > 0)) {
      journal("PLUS10_PARTIAL_NOT_FEASIBLE", {
        ticket: managed.ticket,
        initialVolume: managed.initialVolume,
        currentVolume: position.volume,
      });
    } else {
      managed.partialAttempt += 1;
      saveState();
      const response = await bridgeRequest("POST", `/v1/positions/${encodeURIComponent(managed.ticket)}/close`, {
        volume: closeVolume,
        commandId: `p7c-sideway-plus10-${managed.ticket}-${managed.partialAttempt}`,
      });
      if (response.success) {
        managed.partialApplied = true;
        managed.expectedRemainingVolume = normalizeVolume(Number(position.volume) - closeVolume, Number(spec.volumeStep));
        saveState();
        journal("PLUS10_PARTIAL_ONE_THIRD", {
          ticket: managed.ticket,
          tp1: managed.tp1,
          tp1Kind: managed.tp1Kind,
          marketPrice,
          closedVolume: closeVolume,
          remainingVolume: managed.expectedRemainingVolume,
          favorable,
          stopLoss: managed.entry,
        });
      } else {
        journal("PLUS10_PARTIAL_REJECTED", { ticket: managed.ticket, favorable, response });
      }
    }
  }

  // TP/SL are broker-native; never close at a secondary target, regime change,
  // time limit or partial profit target. This applies to Recovery TP as well.
  // Fast-move and +6 management above can only tighten the existing SL.
  if (brokerTpSlTrailOnly) {
    const holdKey = `${managed.ticket}|BROKER_TP_SL_TRAIL_ONLY`;
    if (managed.lastHoldM15Key !== holdKey) {
      managed.lastHoldM15Key = holdKey;
      saveState();
      journal("SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY", {
        ticket: managed.ticket,
        side: managed.side,
        brokerStopLoss: Number(position.stopLoss),
        brokerTakeProfit: Number(position.takeProfit),
        disabledEarlyExits: ["REGIME_LEFT_RANGE", "TIME_STOP", "PLUS10_PARTIAL", "TP2_SOFTWARE_CLOSE", "FIXED_TP_SOFTWARE_CLOSE"],
      });
    }
    return;
  }

  if (await closeFixedTpIfTriggered(position, quote)) return;

  // TP2 is already broker-protected on the position. This fallback closes
  // the remainder if a bridge/broker reports the position before TP handling.
  if (targetReached(managed.side, marketPrice, managed.tp2)) {
    await closeAll(position, "TP2_OPPOSITE_RANGE");
  } else {
    const hold =
      canonicalHoldReason(
        "SIDEWAY",
        managed,
      );

    const holdKey =
      hold
        ? `${managed.ticket}|${hold.reasonCode}|${holdM15CloseTime}`
        : "";

    if (
      hold &&
      holdM15CloseTime > 0 &&
      holdKey !== managed.lastHoldM15Key
    ) {
      managed.lastHoldM15Key = holdKey;
      saveState();

      journal("HOLD_POSITION", {
        ticket: managed.ticket,
        side: managed.side,
        m15CloseTime: holdM15CloseTime,
        dailyMode:
          managed.dailyMode ?? null,
        ...hold,
      });
    }
  }
}

async function closeAll(position, reason) {
  const managed = state.managed;
  managed.exitAttempt += 1;
  saveState();
  const response = await bridgeRequest("POST", `/v1/positions/${encodeURIComponent(managed.ticket)}/close`, {
    volume: Number(position.volume),
    commandId: `p7c-sideway-exit-${managed.ticket}-${managed.exitAttempt}`,
  });
  if (response.success) {
    journal("POSITION_CLOSED", { ticket: managed.ticket, reason, response });
    state.managed = null;
    saveState();
  } else {
    journal("POSITION_CLOSE_REJECTED", { ticket: managed.ticket, reason, response });
  }
}

async function controlGet(pathname) {
  return jsonRequest(`${controlApiBase}${pathname}`, { method: "GET", headers: { accept: "application/json" } }, 5_000, "Phase7C control API");
}

async function bridgeGet(pathname) {
  return bridgeRequest("GET", pathname);
}

async function bridgeRequest(method, pathname, body = undefined) {
  const headers = {
    accept: "application/json",
    "x-mt5-api-key": bridgeApiKey,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return jsonRequest(`${bridgeBase}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 10_000, "MT5 bridge");
}

async function jsonRequest(url, init, timeoutMs, label) {
  const controller = new AbortController();
  const method = String(init?.method ?? "GET").toUpperCase();
  let pathname = "<invalid-url>";
  try {
    pathname = new URL(url).pathname || "/";
  } catch {
    // Never echo an invalid raw URL because it can contain credentials/query secrets.
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const requestTransportError = (error) => {
    const errorObject = error instanceof Error ? error : null;
    if (timedOut || errorObject?.name === "AbortError") {
      return new Error(
        `${label} ${method} ${pathname} | timeout=${timeoutMs}ms`,
        errorObject ? { cause: errorObject } : undefined,
      );
    }

    const rawCauseCode =
      errorObject?.cause &&
      typeof errorObject.cause === "object" &&
      "code" in errorObject.cause &&
      typeof errorObject.cause.code === "string"
        ? errorObject.cause.code.trim()
        : "";
    const causeCode = /^[A-Z0-9_:-]{1,64}$/.test(rawCauseCode)
      ? rawCauseCode
      : "";
    const transport = errorObject?.message === "fetch failed"
      ? "fetch failed"
      : errorObject?.name || "request failed";
    const message = `${label} ${method} ${pathname} | transport=${transport}${causeCode ? ` | cause=${causeCode}` : ""}`;
    return new Error(
      message,
      errorObject ? { cause: errorObject } : undefined,
    );
  };

  try {
    let response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    } catch (error) {
      throw requestTransportError(error);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw requestTransportError(error);
    }

    if (!response.ok) throw new Error(`${label} ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function validateVolume(volume, spec) {
  const min = Number(spec.minVolume);
  const max = Number(spec.maxVolume);
  const step = Number(spec.volumeStep);
  if (!(volume >= min - 1e-9 && volume <= max + 1e-9 && step > 0)) {
    throw new Error(`Auto Lot ${volume} is outside broker volume range ${min}..${max}.`);
  }
  const units = volume / step;
  if (Math.abs(units - Math.round(units)) > 1e-7) {
    throw new Error(`Auto Lot ${volume} does not align to broker volume step ${step}.`);
  }
}

function normalizePendingEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const distance = Number(raw.fixedTpDistance);
  const price = Number(raw.fixedTpPrice);
  const fixedTpEnabled =
    raw.fixedTpEnabled === true &&
    Number.isFinite(distance) &&
    distance > 0 &&
    Number.isFinite(price);
  return {
    ...raw,
    fixedTpEnabled: fixedTpEnabled ? true : false,
    fixedTpDistance: fixedTpEnabled ? distance : 0,
    fixedTpPrice: fixedTpEnabled ? price : null,
  };
}

function normalizeManagedState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const distance = Number(raw.fixedTpDistance);
  const price = Number(raw.fixedTpPrice);
  const fixedTpEnabled =
    raw.fixedTpEnabled === true &&
    Number.isFinite(distance) &&
    distance > 0 &&
    Number.isFinite(price);
  return {
    ...raw,
    fixedTpEnabled: fixedTpEnabled ? true : false,
    fixedTpDistance: fixedTpEnabled ? distance : 0,
    fixedTpPrice: fixedTpEnabled ? price : null,
  };
}

function loadState() {
  if (!fs.existsSync(statePath)) {
    return { version: 1, accountLogin: null, lastEvaluatedM5Close: 0, pendingEntry: null, managed: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed?.version !== 1) throw new Error("unsupported state version");
    return {
      version: 1,
      accountLogin: Number.isFinite(Number(parsed.accountLogin)) ? Number(parsed.accountLogin) : null,
      lastEvaluatedM5Close: Number(parsed.lastEvaluatedM5Close ?? 0),
      pendingEntry: normalizePendingEntry(parsed.pendingEntry),
      managed: normalizeManagedState(parsed.managed),
    };
  } catch (error) {
    throw new Error(`Cannot load Phase 7C Sideway state: ${errorMessage(error)}`);
  }
}

function saveState() {
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, statePath);
}

function journal(event, payload) {
  const record = { timestamp: Date.now(), event, ...payload };
  fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");
  decisionAudit.record(event, record);
  console.log(`PHASE7C_SIDEWAY_EVENT=${event}|${JSON.stringify(payload)}`);
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function clampNumber(raw, fallback, min, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampInteger(raw, fallback, min, max) {
  return Math.trunc(clampNumber(raw, fallback, min, max));
}

function roundPrice(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
