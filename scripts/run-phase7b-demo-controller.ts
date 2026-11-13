import fs from "node:fs";
import path from "node:path";
import { summarizeBrokerDayRealizedPnl } from "@xauusd/mt5-broker";
import {
  Phase7BPullbackEntryService,
  phase7BSupertrend,
  type Phase7Bar,
  type Phase7BPendingPullback,
  type Phase7BSignal,
} from "@xauusd/risk-engine";
import { createPhase7CDecisionAudit } from "./phase7c-decision-audit.mjs";
import { pauseDailyRecoveryForNewEntry } from "./phase7c-daily-recovery-pause.mjs";
import { canonicalHoldReason } from "./phase7c-hold-observability.mjs";
import { acquireExecutionLock } from "./phase7c-execution-lock.mjs";
import { writeStateFileAtomicSync } from "./phase7c-atomic-state-write.mjs";
import {
  buildFixedTpSnapshot,
  isFixedTpTriggered,
  fixedTpCommandId,
} from "./phase7c-fixed-tp.mjs";
import {
  stopIsAtLeastAsTight,
  stopStrictlyTightens,
  structuralStopWithBuffer,
  tightestKnownStop,
} from "./phase7c-stop-monotonicity.mjs";
import { fastMoveProfitLockCandidate } from "./phase7c-fast-move-profit-lock.mjs";
import {
  compareStrategyEntryConfigVersion,
  createVirtualStrategyEntryConditionState,
  evaluateStrategyEntryConditions,
  validateStrategyEntryConditionState,
} from "./phase7c-strategy-entry-conditions.mjs";

type Health = {
  status: "ok" | "degraded";
  connected: boolean;
  tradingEnabled: boolean;
  terminalTradeAllowed: boolean;
  expertTradeAllowed: boolean;
  accountLogin?: number;
  accountMode?: "demo" | "contest" | "real";
  server?: string;
  accountBalance?: number;
  timestamp: number;
};

type Quote = {
  symbol: string;
  brokerSymbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
};

type SymbolSpec = {
  symbol: string;
  brokerSymbol: string;
  tickSize: number;
  point: number;
  effectiveTickValuePerLot: number;
  cashPerPriceUnitPerLot?: number;
  digits: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  stopsLevelTicks: number;
  freezeLevelTicks: number;
};

type Position = {
  ticket: string;
  symbol: string;
  brokerSymbol: string;
  side: "LONG" | "SHORT";
  volume: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
  openedAt: number;
  magic?: number;
  comment?: string;
};

type TradingDayBoundary = {
  symbol: string;
  brokerSymbol: string;
  currentStartTime: number;
  previousStartTime: number | null;
  source: string;
};

type DealHistoryRow = {
  ticket: string;
  orderId: string;
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  entry: string;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  netPnl: number;
  magic: number;
  comment: string;
  timestamp: number;
  isTradingDeal: boolean;
};

type DailyMode = "TREND" | "RECOVERY_TP";

type DailyRecoveryPlan = {
  mode: DailyMode;
  dayStartTime: number;
  dailyNetPnl: number;
  targetNetPnl: number;
  requiredUsd: number;
  rawTpDistance: number;
  tpDistance: number;
  canRecoverInOneTrade: boolean;
  dealCount: number;
};

type OrderResponse = {
  accepted: boolean;
  status: string;
  ticket?: string | null;
  position?: Position | null;
  fillPrice?: number | null;
  filledVolume?: number | null;
  message?: string;
  retcode?: number;
};

type CommandResponse = {
  success: boolean;
  message?: string;
  retcode?: number;
  idempotentReplay?: boolean;
};

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
  fixedTpEnabled: boolean;
  fixedTpDistance: number;
  fixedTpPrice: number | null;
  breakEvenApplied: boolean;
  partialApplied: boolean;
  partialActivatedAt: number | null;
  lastStructuralStop: number | null;
  lastReversalM15CloseChecked: number;
  lastTrendM15CloseChecked: number;
  lastHoldM15Key?: string;
  beAttempt: number;
  partialAttempt: number;
  exitAttempt: number;
  structureAttempt: number;
  fastMovePeakPrice?: number;
  fastMoveAttempt?: number;
  dailyMode?: DailyMode;
  dailyNetPnlAtEntry?: number;
  recoveryTargetNetPnl?: number;
  recoveryTpDistance?: number;
  recoveryTakeProfit?: number;
  recoveryDayStartTime?: number;
};

type StrategyEntryConfigSnapshot = {
  version: number;
  valid: boolean;
  state: ReturnType<typeof createVirtualStrategyEntryConditionState> | null;
  error: string | null;
};

type ReversalEntryContext = {
  side: "BUY" | "SELL";
  direction: "BULLISH" | "BEARISH";
  chochTimestamp: number;
  level: number | null;
};

type PendingTrendPullback = Phase7BPendingPullback & {
  reversalContext?: ReversalEntryContext | null;
};

type RuntimeEntrySignal = Pick<
  Phase7BSignal,
  "id" | "side" | "pattern" | "signalTimestamp" | "entry" | "patternExtreme"
> & {
  strategyConfigSnapshot: { version: number; valid: boolean };
  entryConditions: ReturnType<typeof evaluateStrategyEntryConditions>;
  reversalContext: ReversalEntryContext | null;
};

type PendingTrendEntry = {
  orderId: string;
  brokerTicket: string | null;
  side: "BUY" | "SELL";
  pattern: string;
  signalTimestamp: number;
  signalEntry: number;
  entryState: "ENTRY_IMMEDIATE" | "PULLBACK_ENTRY";
  referenceEntry: number;
  volume: number;
  stopDistance: number;
  stopLoss: number;
  takeProfit: number;
  fixedTpEnabled: boolean;
  fixedTpDistance: number;
  fixedTpPrice: number | null;
  createdAt: number;
  brokerReferenceTimestamp: number;
  dailyMode: DailyMode;
  dailyNetPnlAtEntry: number;
  recoveryTargetNetPnl: number;
  recoveryTpDistance: number;
  recoveryTakeProfit: number;
  recoveryDayStartTime: number;
};

type BotState = {
  version: 2;
  accountLogin: number | null;
  lastEvaluatedM15Close: number;
  lastEvaluatedM5Close: number;
  pendingPullback: PendingTrendPullback | null;
  pendingEntry: PendingTrendEntry | null;
  managed: ManagedState | null;
};

type PersistedBotState = {
  version?: number;
  accountLogin?: number | null;
  lastEvaluatedM15Close?: number;
  lastEvaluatedM5Close?: number;
  pendingPullback?: PendingTrendPullback | null;
  pendingEntry?: PendingTrendEntry | null;
  managed?: ManagedState | null;
};

const symbol = process.env.ZIQ_DEMO_SYMBOL ?? "XAUUSD";
const MAX_TREND_FIXED_VOLUME = 1.2;
const fixedVolume = Number(process.env.ZIQ_FIXED_VOLUME ?? "0.03");
const trendFixedTpEnabled = /^(1|true|yes|on)$/i.test(process.env.ZIQ_PHASE7C_TREND_FIXED_TP_ENABLED ?? "false");
const trendFixedTpDistance = Number(process.env.ZIQ_PHASE7C_TREND_FIXED_TP_DISTANCE ?? "0");
const intervalSeconds = Math.max(1, Number(process.env.ZIQ_DEMO_INTERVAL_SECONDS ?? "5"));
const armed = /^(1|true|yes|on)$/i.test(process.env.ZIQ_DEMO_ARMED ?? "false");
const once = /^(1|true|yes|on)$/i.test(process.env.ZIQ_DEMO_ONCE ?? "false");
const phase7cReversalEntryEnabled = /^(1|true|yes|on)$/i.test(
  process.env.ZIQ_PHASE7C_REVERSAL_ENTRY_ENABLED ?? "false",
);
const phase7cControlApiBase = (
  process.env.ZIQ_PHASE7C_CONTROL_API_URL?.trim() || "http://127.0.0.1:3711"
).replace(/\/$/, "");
const workDir = requiredEnv("ZIQ_DEMO_WORK_DIR");
const strategyEntryConditionsFile = process.env.PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE?.trim()
  ? path.resolve(process.env.PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE.trim())
  : path.resolve(process.cwd(), ".runtime", "phase7c-strategy-entry-conditions.json");
const bridgeEnvPath = process.env.ZIQ_BRIDGE_ENV ?? path.resolve("packages/mt5-broker/bridge/.env.phase7b-demo");
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const MIN_INITIAL_SL_PRICE = 6;
const MAX_INITIAL_SL_PRICE = 10;
const FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE = 10;
const FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE = 10;
const pullbackWaitMinutes = 15;
const pullbackEntryService = new Phase7BPullbackEntryService();
const DAILY_RECOVERY_MIN_TP_DISTANCE = 6;
const DAILY_RECOVERY_MAX_TP_DISTANCE = 10;
const DAILY_RECOVERY_TARGET_NET_USD = 1;

loadEnvFile(bridgeEnvPath);

const bridgeHost = process.env.MT5_BRIDGE_HOST ?? "127.0.0.1";
const bridgePort = process.env.MT5_BRIDGE_PORT ?? "8765";
const apiKey = requiredEnv("MT5_API_KEY");
const bridgeBase = `http://${bridgeHost}:${bridgePort}`;
const magicNumber = Number(process.env.MT5_MAGIC_NUMBER ?? "270713");
const sidewayMagicNumber = Number(
  process.env.ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER ?? "270714",
);
const dailyBotMagicNumbers = new Set([
  magicNumber,
  sidewayMagicNumber,
]);
const deviationPoints = Number(process.env.MT5_DEVIATION_POINTS ?? "50");
const allowedLogins = new Set(
  (process.env.MT5_ALLOWED_LOGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value)),
);
const allowReal = /^(1|true|yes|on)$/i.test(process.env.MT5_ALLOW_REAL_ACCOUNT ?? "false");

if (![fixedVolume, intervalSeconds, magicNumber, sidewayMagicNumber, deviationPoints, pullbackWaitMinutes].every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Phase 7B DEMO numeric configuration is invalid.");
}
if (fixedVolume < 0.03 - 1e-9 || fixedVolume > MAX_TREND_FIXED_VOLUME + 1e-9) {
  throw new Error(`Phase 7B DEMO fixed volume must be between 0.03 and ${MAX_TREND_FIXED_VOLUME}.`);
}
if (!Number.isFinite(trendFixedTpDistance) || trendFixedTpDistance < 0 || (trendFixedTpEnabled && trendFixedTpDistance <= 0)) {
  throw new Error("Phase 7B Trend Fixed TP distance must be finite and positive when enabled.");
}

fs.mkdirSync(workDir, { recursive: true });
const statePath = path.join(workDir, "phase7b-demo-state.json");
const journalPath = path.join(workDir, "phase7b-demo-events.jsonl");
const decisionAudit = createPhase7CDecisionAudit({
  strategy: "TREND",
  symbol,
  configuration: { fixedLot: fixedVolume },
});
const exitSideEvidencePath = path.join(decisionAudit.root, "trend-exit-side-samples.jsonl");
let state = loadState(statePath);

console.log("PHASE7B_DEMO_STRATEGY=M15_TRIPLE_PATTERN_SUPERTREND_STRUCTURE_RIDER_MA_CONFIDENCE_FVG_CONTEXT");
console.log(`PHASE7B_DEMO_SYMBOL=${symbol}`);
console.log(`PHASE7B_DEMO_FIXED_VOLUME=${fixedVolume}`);
console.log(`PHASE7B_DEMO_INTERVAL_SECONDS=${intervalSeconds}`);
console.log(`PHASE7B_DEMO_ARMED=${armed ? "YES" : "NO"}`);
console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE");
console.log("PHASE7B_DEMO_SUPERTREND=M15_10_3_AND_M5_10_3_MANDATORY");
console.log(`PHASE7B_DEMO_PHASE7C_REVERSAL_ENTRY=${phase7cReversalEntryEnabled ? "CHOCH_DIRECTION_PATTERN_STRUCTURE_NO_SUPERTREND" : "DISABLED"}`);
console.log("PHASE7B_DEMO_MA20_MA50=CONFIDENCE_ONLY_NOT_ENTRY_GATE");
console.log("PHASE7B_DEMO_MA50=RUNNER_HOLD_EXIT_AFTER_PLUS10_PARTIAL_ONLY");
console.log("PHASE7B_DEMO_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING");
console.log("PHASE7B_DEMO_MA200=MACRO_CONTEXT_ONLY_NOT_ENTRY_OR_EXIT_GATE");
console.log("PHASE7B_DEMO_M5_FLIP_AGE=REFERENCE_ONLY_NOT_ENTRY_GATE");
console.log(`PHASE7B_DEMO_ENGULF_BODY_TOLERANCE_PRICE=${ENGULF_BODY_TOLERANCE_PRICE}`);
console.log("PHASE7B_DEMO_FVG_ENTRY_GATE=OFF");
console.log("PHASE7B_DEMO_FVG_ROLE=HOLD_CONFIRMATION_PLUS_ADDON_SHADOW");
console.log("PHASE7B_DEMO_FVG_ADDON_EXECUTION=SHADOW_ONLY_NO_ORDER");
console.log("PHASE7B_DEMO_INITIAL_SL=STRUCTURE_DERIVED_PLUS_1_BUFFER_MIN_6_MAX_10");
console.log("PHASE7B_DEMO_STRUCTURAL_SL_GT_10=WAIT_PULLBACK_NEXT_M15_WINDOW");
console.log(`PHASE7B_DEMO_PULLBACK_WAIT_MINUTES=${pullbackWaitMinutes}`);
console.log("PHASE7B_DEMO_PULLBACK_INVALIDATE=STRUCTURE_BREAK_OR_M15_ST_FLIP_OR_M5_ST_FLIP_OR_EXPIRY");
console.log("PHASE7B_DEMO_PLUS6=SL_TO_ENTRY");
console.log("PHASE7B_DEMO_PLUS10=PARTIAL_ONE_THIRD");
console.log(`PHASE7B_DEMO_FAST_MOVE_PROFIT_LOCK=ON|ACTIVATION=+${FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE}|GIVEBACK=${FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE}|SOURCE=LIVE_BID_ASK`);
console.log("PHASE7B_DEMO_POST_PLUS10_SL=M15_CONFIRMED_SWING_STRUCTURE_PLUS_1_BUFFER_ONLY_TIGHTEN");
console.log("PHASE7B_DEMO_REVERSAL_EXIT=OPPOSING_M15_FVG_PLUS_REJECTION_CLOSE_AFTER_PLUS10");
console.log(`PHASE7B_DEMO_FIXED_TP=${trendFixedTpEnabled ? `ON|DISTANCE=${trendFixedTpDistance}` : "OFF"}`);
console.log("PHASE7B_DEMO_DAILY_RECOVERY=REALIZED_NET_PNL_ALL_BOT_MAGICS");
console.log(`PHASE7B_DEMO_DAILY_RECOVERY_MAGICS=${[...dailyBotMagicNumbers].join(",")}`);
console.log("PHASE7B_DEMO_DAILY_RECOVERY_DAY=MT5_D1_CURRENT_BAR");
console.log("PHASE7B_DEMO_DAILY_RECOVERY_TP=ADAPTIVE_6_TO_10");
console.log("PHASE7B_DEMO_DAILY_RECOVERY_TARGET_NET_USD=1");
console.log("PHASE7B_DEMO_DAILY_RECOVERY_LOT_ESCALATION=OFF");
console.log("PHASE7B_DEMO_DAILY_RECOVERY_NEW_ENTRIES=TEMPORARILY_DISABLED");
console.log("PHASE7B_DEMO_MAX_MANAGED_POSITIONS=1");
console.log(`PHASE7B_DEMO_STATE=${statePath}`);
console.log(`PHASE7B_DEMO_JOURNAL=${journalPath}`);

await preflight();

if (!armed) {
  await previewLatestSignal();
  console.log("PHASE7B_DEMO_PREFLIGHT_STATUS=PASS");
  console.log("PHASE7B_DEMO_ORDER_SEND=DISABLED_NOT_ARMED");
  process.exit(0);
}

console.log("PHASE7B_DEMO_PREFLIGHT_STATUS=PASS");
console.log("PHASE7B_DEMO_REAL_ACCOUNT_GUARD=PASS");
console.log("PHASE7B_DEMO_EXECUTION_STATUS=ARMED_DEMO_ONLY");

while (true) {
  try {
    await cycle();
  } catch (error) {
    journal("CYCLE_ERROR", { message: errorMessage(error) });
    console.error(`PHASE7B_DEMO_CYCLE_ERROR=${errorMessage(error)}`);
  }
  if (once) break;
  await sleep(intervalSeconds * 1000);
}

async function preflight(): Promise<void> {
  if (allowReal) throw new Error("Phase 7B DEMO refuses MT5_ALLOW_REAL_ACCOUNT=true.");
  const health = await get<Health>("/health");
  console.log(`PHASE7B_DEMO_ACCOUNT_LOGIN=${health.accountLogin ?? "UNKNOWN"}`);
  console.log(`PHASE7B_DEMO_ACCOUNT_MODE=${health.accountMode ?? "UNKNOWN"}`);
  console.log(`PHASE7B_DEMO_SERVER=${health.server ?? "UNKNOWN"}`);
  console.log(`PHASE7B_DEMO_BRIDGE_TRADING_ENABLED=${health.tradingEnabled ? "YES" : "NO"}`);
  console.log(`PHASE7B_DEMO_TERMINAL_TRADE_ALLOWED=${health.terminalTradeAllowed ? "YES" : "NO"}`);
  console.log(`PHASE7B_DEMO_EXPERT_TRADE_ALLOWED=${health.expertTradeAllowed ? "YES" : "NO"}`);

  if (!health.connected || health.status !== "ok") throw new Error("MT5 bridge is not healthy/connected.");
  if (health.accountMode !== "demo") throw new Error(`Phase 7B DEMO requires accountMode=demo, got ${health.accountMode ?? "unknown"}.`);
  if (!Number.isFinite(health.accountLogin)) throw new Error("MT5 DEMO account login is unavailable.");

  if (state.accountLogin !== null && state.accountLogin !== health.accountLogin) {
    throw new Error(`Demo state belongs to account ${state.accountLogin}, current account is ${health.accountLogin}.`);
  }

  if (armed) {
    if (!health.tradingEnabled) throw new Error("MT5 bridge trading is disabled. Use the dedicated Phase 7B demo env with MT5_TRADING_ENABLED=true.");
    if (!health.terminalTradeAllowed || !health.expertTradeAllowed) throw new Error("MT5 automated trading is not enabled in terminal/account.");
    if (allowedLogins.size === 0) throw new Error(`MT5_ALLOWED_LOGINS is empty. Add DEMO login ${health.accountLogin} before arming.`);
    if (!allowedLogins.has(Number(health.accountLogin))) throw new Error(`Current DEMO login ${health.accountLogin} is not in MT5_ALLOWED_LOGINS.`);
  }

  state.accountLogin = Number(health.accountLogin);
  saveState();
}

async function previewLatestSignal(): Promise<void> {
  const [m15, m5, spec, quote] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=420`),
    get<SymbolSpec>(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
    get<Quote>(`/v1/quotes/${encodeURIComponent(symbol)}`),
  ]);
  const strategyEntryConfig = readStrategyEntryConfigSnapshot();
  const reversalContext = await readPhase7CReversalEntryContext();
  const signal = latestSignal(m15, m5, spec, strategyEntryConfig, reversalContext);
  const latest = m15.at(-1);
  console.log(`PHASE7B_DEMO_LATEST_M15_CLOSE=${latest?.closeTime ?? "NONE"}`);
  if (!signal || !latest || signal.signalTimestamp !== latest.closeTime) {
    console.log("PHASE7B_DEMO_LATEST_SIGNAL=NONE");
    return;
  }
  const marketEntry = signal.side === "BUY" ? quote.ask : quote.bid;
  const structuralStopPrice = structuralStopWithBuffer(signal.side, signal.patternExtreme);
  const decision = pullbackEntryService.decideInitial({
    signalId: signal.id,
    side: signal.side,
    pattern: signal.pattern,
    signalTimestamp: signal.signalTimestamp,
    referenceEntryPrice: marketEntry,
    structuralStopPrice,
    maxStopDistancePrice: MAX_INITIAL_SL_PRICE,
    waitMinutes: pullbackWaitMinutes,
  });
  const fvgConfirmed = hasRelevantFvg(m15, m15.length - 1, signal.side, 12);
  console.log(`PHASE7B_DEMO_LATEST_SIGNAL=${signal.side}|PATTERN=${signal.pattern}|ENTRY=${marketEntry}|RAW_STRUCTURAL_STOP=${signal.patternExtreme}|STRUCTURAL_STOP=${structuralStopPrice}|SL_DISTANCE=${decision.structuralStopDistance}|ENTRY_STATE=${decision.state}|FVG_CONFIRM=${fvgConfirmed ? "YES" : "NO"}`);
}

async function cycle(): Promise<void> {
  const health = await get<Health>("/health");
  if (
    health.accountMode !== "demo" ||
    !health.connected ||
    !health.tradingEnabled ||
    !health.terminalTradeAllowed ||
    !health.expertTradeAllowed ||
    !allowedLogins.has(Number(health.accountLogin))
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

  const [m15, m5, spec, positions, quote] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=420`),
    get<SymbolSpec>(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
    get<Position[]>(`/v1/positions?symbol=${encodeURIComponent(symbol)}`),
    get<Quote>(`/v1/quotes/${encodeURIComponent(symbol)}`),
  ]);

  validateVolume(spec);

  if (state.managed) {
    const managedPosition = positions.find((position) => position.ticket === state.managed!.ticket);
    if (!managedPosition) {
      journal("MANAGED_POSITION_CLOSED", { ticket: state.managed.ticket, lastKnownState: state.managed });
      state.managed = null;
      saveState();
      return;
    }
    if (positions.length !== 1) {
      journal("UNEXPECTED_ADDITIONAL_POSITION", { managedTicket: state.managed.ticket, positions: positions.map((p) => p.ticket) });
      return;
    }
    const expectedSide = state.managed.side === "BUY" ? "LONG" : "SHORT";
    if (managedPosition.side !== expectedSide) {
      journal("MANAGED_POSITION_SIDE_MISMATCH", { expectedSide, actualSide: managedPosition.side, ticket: managedPosition.ticket });
      return;
    }
    if (Math.abs(managedPosition.volume - state.managed.expectedRemainingVolume) > spec.volumeStep / 2 + 1e-9) {
      journal("MANAGED_POSITION_VOLUME_MISMATCH", {
        ticket: managedPosition.ticket,
        expected: state.managed.expectedRemainingVolume,
        actual: managedPosition.volume,
      });
      return;
    }
    await managePosition(managedPosition, quote, spec, m15);
    return;
  }

  if (state.pendingEntry) {
    const pending = state.pendingEntry;
    const pendingAgeMs = Math.max(0, Date.now() - pending.createdAt);

    if (positions.length === 0) {
      if (pendingAgeMs >= 60_000) {
        journal("PENDING_ENTRY_EXPIRED_NO_POSITION", {
          orderId: pending.orderId,
          brokerTicket: pending.brokerTicket,
          ageMs: pendingAgeMs,
        });
        state.pendingEntry = null;
        saveState();
        return;
      }

      journal("PENDING_ENTRY_RECOVERY_WAIT", {
        orderId: pending.orderId,
        brokerTicket: pending.brokerTicket,
        ageMs: pendingAgeMs,
      });
      return;
    }

    if (positions.length !== 1) {
      journal("PENDING_ENTRY_RECOVERY_BLOCK", {
        orderId: pending.orderId,
        brokerTicket: pending.brokerTicket,
        reason: "PENDING_REQUIRES_EXACTLY_ONE_POSITION",
        positions: positions.map((p) => ({
          ticket: p.ticket,
          side: p.side,
          volume: p.volume,
        })),
      });
      return;
    }

    const candidate = positions[0]!;
    const recovery = matchPendingTrendPosition(
      pending,
      candidate,
      spec,
    );

    if (!recovery.matched) {
      journal("PENDING_ENTRY_RECOVERY_BLOCK", {
        orderId: pending.orderId,
        brokerTicket: pending.brokerTicket,
        reason: recovery.reason,
        candidate: {
          ticket: candidate.ticket,
          side: candidate.side,
          volume: candidate.volume,
          entry: candidate.entry,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
        },
      });
      return;
    }

    state.managed = managedFromPending(
      pending,
      candidate,
    );
    state.pendingEntry = null;
    saveState();

    journal("PENDING_ENTRY_RECOVERED", {
      orderId: pending.orderId,
      brokerTicket: pending.brokerTicket,
      ticket: candidate.ticket,
      side: pending.side,
      volume: candidate.volume,
    });

    if (pending.dailyMode !== "RECOVERY_TP") {
      await reconcileFixedTpBrokerTakeProfit({
        ticket: candidate.ticket,
        enabled: state.managed.fixedTpEnabled,
        targetPrice: state.managed.fixedTpPrice,
        currentTakeProfit: candidate.takeProfit,
        strategy: "TREND",
      });
    }

    await managePosition(
      candidate,
      quote,
      spec,
      m15,
    );
    return;
  }

  if (positions.length > 0) {
    journal("UNMANAGED_POSITION_PRESENT", { positions: positions.map((p) => ({ ticket: p.ticket, side: p.side, volume: p.volume })) });
    return;
  }

  const latestM15 = m15.at(-1);
  const latestM5 = m5.at(-1);
  if (!latestM15 || !latestM5) return;

  if (state.pendingPullback) {
    const pending = state.pendingPullback;
    const persistedReversalContext = pending.reversalContext ?? null;
    let activeReversalContext: ReversalEntryContext | null = null;

    if (persistedReversalContext) {
      activeReversalContext = await readPhase7CReversalEntryContext();
      const sameReversal = Boolean(
        activeReversalContext &&
        activeReversalContext.side === persistedReversalContext.side &&
        activeReversalContext.direction === persistedReversalContext.direction &&
        activeReversalContext.chochTimestamp === persistedReversalContext.chochTimestamp
      );
      if (!sameReversal) {
        journal("REVERSAL_PULLBACK_CONTEXT_INVALIDATED", {
          signalId: pending.signalId,
          persistedReversalContext,
          activeReversalContext,
        });
        state.pendingPullback = null;
        saveState();
        return;
      }
    }

    const pullbackCycleTimestamp = Number(quote.timestamp);
    if (!Number.isFinite(pullbackCycleTimestamp)) {
      journal("QUOTE_TIMESTAMP_INVALID", {
        signalId: pending.signalId,
        quoteTimestamp: quote.timestamp,
      });
      return;
    }

    const m15Index = latestClosedIndex(m15, latestM5.closeTime);
    const m15Direction = m15Index >= 0
      ? phase7BSupertrend(m15.slice(0, m15Index + 1), 10, 3).direction[m15Index] ?? null
      : null;
    const m5Direction = phase7BSupertrend(m5, 10, 3).direction[m5.length - 1] ?? null;
    const marketEntry = pending.side === "BUY" ? quote.ask : quote.bid;
    const strategyEntryConfig = readStrategyEntryConfigSnapshot();
    const structuralStopDistance = structuralDistance(
      pending.side,
      marketEntry,
      pending.structuralStopPrice,
    );
    const closes = m15.slice(0, Math.max(0, m15Index) + 1).map((bar) => bar.close);
    const ma20 = smaPeriod(closes, 20);
    const ma50 = smaPeriod(closes, 50);
    const fvgConfirmed = m15Index >= 0
      ? hasRelevantFvg(m15, m15Index, pending.side, 12)
      : false;
    const effectiveConfig = effectiveTrendEntryConfig(
      strategyEntryConfig,
      activeReversalContext,
    );
    const entryConditions = effectiveConfig
      ? evaluateStrategyEntryConditions({
          strategy: "TREND",
          config: effectiveConfig,
          side: pending.side,
          observations: {
            patternM15: { passed: true, observed: `${pending.side}:${pending.pattern}` },
            supertrendM15: { passed: m15Direction === pending.side, observed: m15Direction },
            supertrendM5: { passed: m5Direction === pending.side, observed: m5Direction },
            validTrendStructure: { passed: structuralStopDistance > 0, observed: structuralStopDistance },
            ma20Ma50: {
              passed: pending.side === "BUY" ? ma20 > ma50 : ma20 < ma50,
              observed: { ma20, ma50 },
            },
            fvg: { passed: fvgConfirmed, observed: fvgConfirmed ? "CONFIRMED" : "NONE" },
          },
        })
      : null;

    const evaluation = pullbackEntryService.evaluatePullback({
      pending,
      timestamp: pullbackCycleTimestamp,
      candidateEntryPrice: marketEntry,
      barLow: latestM5.low,
      barHigh: latestM5.high,
      setupStillValid: structuralStopDistance > 0,
      m15SupertrendAligned: activeReversalContext ? true : m15Direction === pending.side,
      m5SupertrendAligned: activeReversalContext ? true : m5Direction === pending.side,
    });

    journal(evaluation.state, {
      signalId: pending.signalId,
      side: pending.side,
      pattern: pending.pattern,
      structuralStopPrice: pending.structuralStopPrice,
      structuralStopDistanceAtSignal: pending.structuralStopDistanceAtSignal,
      structuralStopDistanceNow: evaluation.structuralStopDistance,
      marketEntry,
      m15Direction,
      m5Direction,
      supertrendGate: activeReversalContext ? "IGNORED_REVERSAL" : "REQUIRED",
      reversalContext: activeReversalContext,
      m5CloseTime: latestM5.closeTime,
      pullbackCycleTimestamp,
      expiresAt: pending.expiresAt,
    });

    if (evaluation.state === "PULLBACK_STILL_TOO_WIDE") return;
    if (evaluation.state !== "PULLBACK_ENTRY") {
      state.pendingPullback = null;
      saveState();
      return;
    }

    if (!entryConditions || !entryConditions.allEnabledPassed) {
      journal("ENTRY_STRATEGY_CONDITION_BLOCK", {
        signalId: pending.signalId,
        side: pending.side,
        pattern: pending.pattern,
        reason: entryConditions
          ? entryConditions.failedConditions.join(",")
          : "ENTRY_STRATEGY_CONFIG_INVALID",
        configError: strategyEntryConfig.error,
        entryPolicy: activeReversalContext
          ? "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"
          : "TREND_CONTINUATION",
        reversalContext: activeReversalContext,
        entryConditions,
      });
      return;
    }

    journal("ENTRY_STRATEGY_CONDITIONS_PASS", {
      signalId: pending.signalId,
      side: pending.side,
      pattern: pending.pattern,
      entryPolicy: activeReversalContext
        ? "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"
        : "TREND_CONTINUATION",
      reversalContext: activeReversalContext,
      entryConditions,
    });

    const signal: RuntimeEntrySignal = {
      id: pending.signalId,
      side: pending.side,
      pattern: pending.pattern as Phase7BSignal["pattern"],
      signalTimestamp: pending.signalTimestamp,
      entry: pending.side === "BUY"
        ? pending.structuralStopPrice + pending.structuralStopDistanceAtSignal
        : pending.structuralStopPrice - pending.structuralStopDistanceAtSignal,
      patternExtreme: pending.structuralStopPrice,
      strategyConfigSnapshot: {
        version: entryConditions.configVersion,
        valid: true,
      },
      entryConditions,
      reversalContext: activeReversalContext,
    };
    const submitted = await submitTrendEntry(signal, marketEntry, quote, spec, m15, "PULLBACK_ENTRY", health.accountBalance);
    if (submitted !== "BROKER_GAP_WAIT" && submitted !== "TOO_WIDE_WAIT") {
      state.pendingPullback = null;
      saveState();
    }
    return;
  }

  if (latestM15.closeTime <= state.lastEvaluatedM15Close) return;
  state.lastEvaluatedM15Close = latestM15.closeTime;
  saveState();

  const strategyEntryConfig = readStrategyEntryConfigSnapshot();
  const reversalContext = await readPhase7CReversalEntryContext();
  const signal = latestSignal(m15, m5, spec, strategyEntryConfig, reversalContext);
  if (!signal || signal.signalTimestamp !== latestM15.closeTime) {
    journal("M15_NO_ENTRY_SIGNAL", {
      closeTime: latestM15.closeTime,
      close: latestM15.close,
      entryRule: reversalContext
        ? "REVERSAL_CHOCH_DIRECTION_PLUS_PATTERN_PLUS_VALID_STRUCTURE"
        : "THREE_PATTERNS_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE",
      supertrend: reversalContext
        ? "IGNORED_REVERSAL_ENTRY"
        : "M15_10_3_AND_M5_10_3",
      reversalContext,
      engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
    });
    return;
  }

  const now = Number(quote.timestamp);
  if (!Number.isFinite(now)) {
    journal("QUOTE_TIMESTAMP_INVALID", { quoteTimestamp: quote.timestamp });
    return;
  }
  if (now > signal.signalTimestamp + pullbackWaitMinutes * 60_000) {
    journal("SIGNAL_EXPIRED", { id: signal.id, signalTimestamp: signal.signalTimestamp, now });
    return;
  }

  const marketEntry = signal.side === "BUY" ? quote.ask : quote.bid;
  const structuralStopPrice = structuralStopWithBuffer(signal.side, signal.patternExtreme);
  const structuralStopDistance = structuralDistance(signal.side, marketEntry, structuralStopPrice);
  if (!(structuralStopDistance > 0)) {
    journal("ENTRY_SETUP_INVALIDATED_BEFORE_DECISION", {
      signalId: signal.id,
      marketEntry,
      rawStructuralStopPrice: signal.patternExtreme,
      structuralStopPrice,
    });
    return;
  }

  const decision = pullbackEntryService.decideInitial({
    signalId: signal.id,
    side: signal.side,
    pattern: signal.pattern,
    signalTimestamp: signal.signalTimestamp,
    referenceEntryPrice: marketEntry,
    structuralStopPrice,
    maxStopDistancePrice: MAX_INITIAL_SL_PRICE,
    waitMinutes: pullbackWaitMinutes,
  });

  if (decision.state === "WAIT_PULLBACK") {
    state.pendingPullback = decision.pending
      ? {
          ...decision.pending,
          reversalContext: signal.reversalContext,
        }
      : null;
    state.lastEvaluatedM5Close = signal.signalTimestamp;
    saveState();
    journal("WAIT_PULLBACK", {
      signalId: signal.id,
      side: signal.side,
      pattern: signal.pattern,
      signalEntry: signal.entry,
      marketEntry,
      rawStructuralStopPrice: signal.patternExtreme,
      structuralStopPrice,
      structuralStopDistance,
      expiresAt: decision.pending!.expiresAt,
    });
    return;
  }

  journal("ENTRY_IMMEDIATE", {
    signalId: signal.id,
    side: signal.side,
    pattern: signal.pattern,
    signalEntry: signal.entry,
    marketEntry,
    rawStructuralStopPrice: signal.patternExtreme,
    structuralStopPrice,
    structuralStopDistance,
  });
  const bufferedSignal: RuntimeEntrySignal = {
    ...signal,
    patternExtreme: structuralStopPrice,
  };
  await submitTrendEntry(bufferedSignal, marketEntry, quote, spec, m15, "ENTRY_IMMEDIATE", health.accountBalance);
}

async function submitTrendEntry(
  signal: RuntimeEntrySignal,
  marketEntry: number,
  quote: Quote,
  spec: SymbolSpec,
  m15: Phase7Bar[],
  entryState: "ENTRY_IMMEDIATE" | "PULLBACK_ENTRY",
  accountBalance?: number,
): Promise<"FILLED" | "BROKER_GAP_WAIT" | "TOO_WIDE_WAIT" | "REJECTED" | "UNRESOLVED"> {
  const structuralStopDistance = structuralDistance(signal.side, marketEntry, signal.patternExtreme);
  if (!(structuralStopDistance > 0)) {
    journal("ENTRY_SETUP_INVALIDATED_BEFORE_SUBMIT", { signalId: signal.id, marketEntry, structuralStopPrice: signal.patternExtreme });
    return "REJECTED";
  }
  if (structuralStopDistance > MAX_INITIAL_SL_PRICE + 1e-9) {
    journal("ENTRY_DISTANCE_REGRESSION_WAIT", { signalId: signal.id, marketEntry, structuralStopPrice: signal.patternExtreme, structuralStopDistance });
    return "TOO_WIDE_WAIT";
  }

  const stopDistance = Math.max(MIN_INITIAL_SL_PRICE, structuralStopDistance);
  const stopLoss = roundPrice(
    signal.side === "BUY" ? marketEntry - stopDistance : marketEntry + stopDistance,
    spec.digits,
  );
  const minimumStopGap = Math.max(0, spec.stopsLevelTicks * spec.point);
  if (stopDistance + 1e-9 < minimumStopGap) {
    journal("INITIAL_SL_BROKER_DISTANCE_BLOCK", { signalId: signal.id, stopDistance, minimumStopGap, entryState });
    return entryState === "PULLBACK_ENTRY" ? "BROKER_GAP_WAIT" : "REJECTED";
  }

  const dailyRecovery = await resolveDailyRecoveryPlan(quote, spec);
  const takeProfit = dailyRecovery.mode === "RECOVERY_TP"
    ? roundPrice(
        signal.side === "BUY"
          ? marketEntry + dailyRecovery.tpDistance
          : marketEntry - dailyRecovery.tpDistance,
        spec.digits,
      )
    : 0;

  const fvgConfirmedAtEntry = hasRelevantFvg(m15, m15.length - 1, signal.side, 12);
  const cashPerPriceUnitPerLot = Number(spec.cashPerPriceUnitPerLot) > 0
    ? Number(spec.cashPerPriceUnitPerLot)
    : spec.tickSize > 0
      ? Number(spec.effectiveTickValuePerLot) / Number(spec.tickSize)
      : 0;
  const estimatedRiskUsd = stopDistance * cashPerPriceUnitPerLot * fixedVolume;
  const estimatedRiskPercent = Number(accountBalance) > 0
    ? estimatedRiskUsd / Number(accountBalance) * 100
    : null;
  const partialTarget = roundPrice(
    signal.side === "BUY" ? marketEntry + 10 : marketEntry - 10,
    spec.digits,
  );
  const orderId = signal.reversalContext
    ? `p7b-rv-${entryState === "PULLBACK_ENTRY" ? "pb" : "im"}-${signal.signalTimestamp}-${signal.side}`
    : `p7b-${entryState === "PULLBACK_ENTRY" ? "pb" : "im"}-${signal.signalTimestamp}-${signal.side}`;
  journal("ENTRY_SUBMIT", {
    signalId: signal.id,
    side: signal.side,
    pattern: signal.pattern,
    signalEntry: signal.entry,
    marketEntry,
    entryState,
    structuralStopPrice: signal.patternExtreme,
    structuralStopDistance,
    stopDistance,
    stopLoss,
    volume: fixedVolume,
    configuredLot: fixedVolume,
    estimatedRiskUsd,
    estimatedRiskPercent,
    plan: {
      entry: marketEntry,
      stopLoss,
      stopDistance,
      tp1: partialTarget,
      takeProfit: takeProfit > 0 ? takeProfit : null,
    },
    entryRule: signal.reversalContext
      ? "REVERSAL_CHOCH_DIRECTION_PLUS_PATTERN_PLUS_VALID_STRUCTURE"
      : "THREE_PATTERNS_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE",
    supertrend: signal.reversalContext
      ? "IGNORED_REVERSAL_ENTRY"
      : "M15_10_3_AND_M5_10_3",
    reversalContext: signal.reversalContext,
    engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
    fvgConfirmedAtEntry,
    fvgRequiredForEntry: false,
    dailyMode: dailyRecovery.mode,
    dailyNetPnl: dailyRecovery.dailyNetPnl,
    recoveryTargetNetPnl: dailyRecovery.targetNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
    recoveryTakeProfit: takeProfit,
    recoveryCanRecoverInOneTrade: dailyRecovery.canRecoverInOneTrade,
    recoveryDealCount: dailyRecovery.dealCount,
  });

  const brokerReferenceTimestamp = Number(quote.timestamp);

  if (
    !Number.isFinite(brokerReferenceTimestamp) ||
    brokerReferenceTimestamp <= 0
  ) {
    journal("ENTRY_BROKER_REFERENCE_TIMESTAMP_INVALID", {
      signalId: signal.id,
      entryState,
      quoteTimestamp: quote.timestamp,
    });
    return "REJECTED";
  }

  const currentStrategyConfig = readStrategyEntryConfigSnapshot();
  const versionGuard = compareStrategyEntryConfigVersion(
    signal.strategyConfigSnapshot,
    { version: currentStrategyConfig.version, valid: currentStrategyConfig.valid },
  );
  if (!versionGuard.ok) {
    const reasonCode = versionGuard.reasonCode === "ENTRY_CONFIG_VERSION_CHANGED"
      ? "ENTRY_CONFIG_VERSION_CHANGED"
      : "ENTRY_STRATEGY_CONFIG_INVALID";
    journal(reasonCode, {
      signalId: signal.id,
      entryState,
      reasonCode,
      cycleConfigVersion: signal.strategyConfigSnapshot.version,
      currentConfigVersion: currentStrategyConfig.version,
      configError: currentStrategyConfig.error,
      entryConditions: signal.entryConditions,
    });
    return "REJECTED";
  }

  const fixedTpSnapshot = buildFixedTpSnapshot({
    enabled: trendFixedTpEnabled,
    distance: trendFixedTpDistance,
    side: signal.side,
    entry: marketEntry,
  });
  const brokerTakeProfit = dailyRecovery.mode === "RECOVERY_TP"
    ? takeProfit
    : fixedTpSnapshot.enabled && fixedTpSnapshot.targetPrice !== null
      ? fixedTpSnapshot.targetPrice
      : takeProfit;

  const pendingEntry: PendingTrendEntry = {
    orderId,
    brokerTicket: null,
    side: signal.side,
    pattern: signal.pattern,
    signalTimestamp: signal.signalTimestamp,
    signalEntry: signal.entry,
    entryState,
    referenceEntry: marketEntry,
    volume: fixedVolume,
    stopDistance,
    stopLoss,
    takeProfit,
    fixedTpEnabled: fixedTpSnapshot.enabled,
    fixedTpDistance: fixedTpSnapshot.distance,
    fixedTpPrice: fixedTpSnapshot.targetPrice,
    createdAt: Date.now(),
    brokerReferenceTimestamp,
    dailyMode: dailyRecovery.mode,
    dailyNetPnlAtEntry: dailyRecovery.dailyNetPnl,
    recoveryTargetNetPnl: dailyRecovery.targetNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
    recoveryTakeProfit: takeProfit,
    recoveryDayStartTime: dailyRecovery.dayStartTime,
  };

  state.pendingEntry = pendingEntry;
  saveState();

  journal("ENTRY_PENDING_DURABLE", {
    orderId,
    side: pendingEntry.side,
    volume: pendingEntry.volume,
    stopLoss: pendingEntry.stopLoss,
    takeProfit: pendingEntry.takeProfit,
    brokerReferenceTimestamp: pendingEntry.brokerReferenceTimestamp,
  });

  const order = await post<OrderResponse>("/v1/orders", {
    symbol,
    side: signal.side,
    orderType: "MARKET",
    timeInForce: "GTC",
    volume: fixedVolume,
    requestedPrice: marketEntry,
    stopLoss,
    takeProfit: brokerTakeProfit,
    deviationPoints,
    magicNumber,
    comment: entryState === "PULLBACK_ENTRY" ? "phase7b-demo-pb" : "phase7b-demo-im",
    clientOrderId: orderId,
    idempotencyKey: orderId,
  });

  if (!order.accepted) {
    journal("ENTRY_REJECTED", { signalId: signal.id, entryState, message: order.message, retcode: order.retcode });
    state.pendingEntry = null;
    saveState();
    return "REJECTED";
  }

  let opened = order.position ?? null;

  if (opened) {
    const recovery = matchPendingTrendPosition(
      pendingEntry,
      opened,
      spec,
    );

    if (recovery.matched) {
      pendingEntry.brokerTicket = String(opened.ticket);
      state.pendingEntry = pendingEntry;
      saveState();
    } else {
      opened = null;
    }
  }

  if (!opened) {
    const after = await get<Position[]>(
      `/v1/positions?symbol=${encodeURIComponent(symbol)}`,
    );

    if (after.length === 1) {
      const candidate = after[0]!;
      const recovery = matchPendingTrendPosition(
        pendingEntry,
        candidate,
        spec,
      );

      if (recovery.matched) {
        opened = candidate;
      }
    }
  }

  if (!opened) {
    journal("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED", {
      signalId: signal.id,
      entryState,
      ticket: order.ticket,
      fillPrice: order.fillPrice,
    });

    state.pendingEntry = pendingEntry;
    saveState();

    return "UNRESOLVED";
  }

  const filledFixedTpSnapshot = buildFixedTpSnapshot({
    enabled: pendingEntry.fixedTpEnabled,
    distance: pendingEntry.fixedTpDistance,
    side: pendingEntry.side,
    entry: opened.entry,
  });

  state.managed = {
    ticket: opened.ticket,
    side: signal.side,
    pattern: signal.pattern,
    signalTimestamp: signal.signalTimestamp,
    signalEntry: signal.entry,
    entry: opened.entry,
    initialVolume: opened.volume,
    expectedRemainingVolume: opened.volume,
    stopDistance,
    fixedTpEnabled: filledFixedTpSnapshot.enabled,
    fixedTpDistance: filledFixedTpSnapshot.distance,
    fixedTpPrice: filledFixedTpSnapshot.targetPrice,
    breakEvenApplied: false,
    partialApplied: false,
    partialActivatedAt: null,
    lastStructuralStop: opened.stopLoss || stopLoss,
    lastReversalM15CloseChecked: signal.signalTimestamp,
    lastTrendM15CloseChecked: signal.signalTimestamp,
    beAttempt: 0,
    partialAttempt: 0,
    exitAttempt: 0,
    structureAttempt: 0,
    dailyMode: dailyRecovery.mode,
    dailyNetPnlAtEntry: dailyRecovery.dailyNetPnl,
    recoveryTargetNetPnl: dailyRecovery.targetNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
    recoveryTakeProfit: takeProfit,
    recoveryDayStartTime: dailyRecovery.dayStartTime,
  };
  state.pendingEntry = null;
  saveState();
  journal("ENTRY_FILLED", {
    signalId: signal.id,
    entryState,
    entryPolicy: signal.reversalContext
      ? "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"
      : "TREND_CONTINUATION",
    reversalContext: signal.reversalContext,
    structuralStopPrice: signal.patternExtreme,
    stopLoss,
    position: opened,
    fillPrice: order.fillPrice,
    fvgConfirmedAtEntry,
    dailyMode: dailyRecovery.mode,
    dailyNetPnlAtEntry: dailyRecovery.dailyNetPnl,
    recoveryTargetNetPnl: dailyRecovery.targetNetPnl,
    recoveryTpDistance: dailyRecovery.tpDistance,
    recoveryTakeProfit: takeProfit,
    recoveryCanRecoverInOneTrade: dailyRecovery.canRecoverInOneTrade,
  });

  if (dailyRecovery.mode !== "RECOVERY_TP") {
    await reconcileFixedTpBrokerTakeProfit({
      ticket: opened.ticket,
      enabled: filledFixedTpSnapshot.enabled,
      targetPrice: filledFixedTpSnapshot.targetPrice,
      currentTakeProfit: opened.takeProfit,
      strategy: "TREND",
    });
  }

  return "FILLED";
}

async function resolveDailyRecoveryPlan(
  quote: Quote,
  spec: SymbolSpec,
): Promise<DailyRecoveryPlan> {
  const boundary = await get<TradingDayBoundary>(
    `/v1/session/day-boundary/${encodeURIComponent(symbol)}`,
  );

  const dayStartTime = Number(boundary.currentStartTime);
  const historyEndTime = Number(quote.timestamp);

  if (
    !Number.isFinite(dayStartTime) ||
    dayStartTime <= 0 ||
    !Number.isFinite(historyEndTime) ||
    historyEndTime <= dayStartTime
  ) {
    throw new Error("Daily recovery broker day boundary is invalid.");
  }

  const deals = await get<DealHistoryRow[]>(
    `/v1/history/deals?fromMs=${dayStartTime}&toMs=${historyEndTime}&symbol=${encodeURIComponent(symbol)}`,
  );

  const { dealCount, dailyNetPnl } =
    summarizeBrokerDayRealizedPnl(
      deals,
      dailyBotMagicNumbers,
    );

  if (dailyNetPnl >= 0) {
    return {
      mode: "TREND",
      dayStartTime,
      dailyNetPnl: roundValue(dailyNetPnl, 4),
      targetNetPnl: DAILY_RECOVERY_TARGET_NET_USD,
      requiredUsd: 0,
      rawTpDistance: 0,
      tpDistance: 0,
      canRecoverInOneTrade: true,
      dealCount: dealCount,
    };
  }

  const cashPerPriceUnitPerLot =
    Number(spec.cashPerPriceUnitPerLot) > 0
      ? Number(spec.cashPerPriceUnitPerLot)
      : spec.tickSize > 0 && spec.effectiveTickValuePerLot > 0
        ? spec.effectiveTickValuePerLot / spec.tickSize
        : 0;

  if (!(cashPerPriceUnitPerLot > 0)) {
    throw new Error(
      "Daily recovery cannot determine cash per price unit per lot.",
    );
  }

  const cashPerPriceUnit = cashPerPriceUnitPerLot * fixedVolume;

  if (!(cashPerPriceUnit > 0)) {
    throw new Error("Daily recovery cash value is invalid.");
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

  return pauseDailyRecoveryForNewEntry("TREND", {
    mode: "RECOVERY_TP",
    dayStartTime,
    dailyNetPnl: roundValue(dailyNetPnl, 4),
    targetNetPnl: DAILY_RECOVERY_TARGET_NET_USD,
    requiredUsd: roundValue(requiredUsd, 4),
    rawTpDistance: roundValue(rawTpDistance, 5),
    tpDistance: roundValue(tpDistance, 5),
    canRecoverInOneTrade:
      rawTpDistance <= DAILY_RECOVERY_MAX_TP_DISTANCE + 1e-9,
    dealCount: dealCount,
  });
}

async function readPhase7CReversalEntryContext(): Promise<ReversalEntryContext | null> {
  if (!phase7cReversalEntryEnabled) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const query = new URLSearchParams({
      symbol,
      count: "320",
    });
    const response = await fetch(
      `${phase7cControlApiBase}/api/v1/phase7c/live-regime?${query.toString()}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Phase7C reversal context GET failed ${response.status}: ${text}`);
    }

    const payload = text ? JSON.parse(text) : null;
    const activeMode = String(payload?.activeMode ?? "").trim().toUpperCase();
    const regime = String(payload?.regime ?? "").trim().toUpperCase();

    if (activeMode !== "AUTO" || regime !== "REVERSAL") {
      return null;
    }

    const direction = String(payload?.reversal?.direction ?? "").trim().toUpperCase();
    const side = String(payload?.reversal?.side ?? "").trim().toUpperCase();
    const chochTimestamp = Number(payload?.reversal?.timestamp);
    const levelRaw = Number(payload?.reversal?.level);
    const expectedSide = direction === "BULLISH"
      ? "BUY"
      : direction === "BEARISH"
        ? "SELL"
        : "";

    if (
      (side !== "BUY" && side !== "SELL") ||
      !Number.isFinite(chochTimestamp) ||
      chochTimestamp <= 0 ||
      expectedSide !== side
    ) {
      throw new Error(
        `REVERSAL_CONTEXT_MISSING_OR_INVALID|direction=${direction || "NONE"}|side=${side || "NONE"}|timestamp=${Number.isFinite(chochTimestamp) ? chochTimestamp : "INVALID"}`,
      );
    }

    return {
      side: side as "BUY" | "SELL",
      direction: direction as "BULLISH" | "BEARISH",
      chochTimestamp,
      level: Number.isFinite(levelRaw) ? levelRaw : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function effectiveTrendEntryConfig(
  strategy: StrategyEntryConfigSnapshot,
  reversalContext: ReversalEntryContext | null,
) {
  if (!strategy.valid || !strategy.state) return null;
  if (!reversalContext) return strategy.state;

  return {
    ...strategy.state,
    trend: {
      ...strategy.state.trend,
      supertrendM15: false,
      supertrendM5: false,
      validTrendStructure: true,
    },
  };
}

function latestSignal(
  m15: Phase7Bar[],
  m5: Phase7Bar[],
  spec: SymbolSpec,
  strategy: StrategyEntryConfigSnapshot,
  reversalContext: ReversalEntryContext | null,
): RuntimeEntrySignal | null {
  const index = m15.length - 1;
  if (index < 200) return null;
  const current = m15[index]!;
  const trigger = detectEntryPattern(m15, index);
  if (!trigger) return null;

  if (reversalContext) {
    if (trigger.side !== reversalContext.side) {
      journal("REVERSAL_DIRECTION_MISMATCH", {
        signalTimestamp: current.closeTime,
        signalSide: trigger.side,
        reversalSide: reversalContext.side,
        reversalDirection: reversalContext.direction,
        chochTimestamp: reversalContext.chochTimestamp,
      });
      return null;
    }

    if (current.closeTime <= reversalContext.chochTimestamp) {
      journal("REVERSAL_SIGNAL_NOT_AFTER_CHOCH", {
        signalTimestamp: current.closeTime,
        signalSide: trigger.side,
        reversalSide: reversalContext.side,
        chochTimestamp: reversalContext.chochTimestamp,
      });
      return null;
    }
  }

  const closes = m15.slice(0, index + 1).map((bar) => bar.close);
  const ma20 = smaPeriod(closes, 20);
  const ma50 = smaPeriod(closes, 50);
  const ma200 = smaPeriod(closes, 200);
  const m15Supertrend = phase7BSupertrend(m15.slice(0, index + 1), 10, 3);
  const m15Direction = m15Supertrend.direction[index] ?? null;
  let m5SignalIndex = m5.length - 1;
  while (m5SignalIndex >= 0 && m5[m5SignalIndex]!.closeTime > current.closeTime) m5SignalIndex -= 1;
  let m5Direction: "BUY" | "SELL" | null = null;
  if (m5SignalIndex >= 9) {
    const m5AtSignal = m5.slice(0, m5SignalIndex + 1);
    const m5Supertrend = phase7BSupertrend(m5AtSignal, 10, 3);
    m5Direction = m5Supertrend.direction[m5SignalIndex] ?? null;
  } else if (!reversalContext) {
    return null;
  }

  const entry = current.close;
  const structuralStopPrice = structuralStopWithBuffer(trigger.side, trigger.patternExtreme);
  const structuralStopDistance = trigger.side === "BUY"
    ? entry - structuralStopPrice
    : structuralStopPrice - entry;
  const fvgConfirmed = hasRelevantFvg(m15, index, trigger.side, 12);

  const effectiveConfig = effectiveTrendEntryConfig(strategy, reversalContext);
  const entryConditions = effectiveConfig
    ? evaluateStrategyEntryConditions({
        strategy: "TREND",
        config: effectiveConfig,
        side: trigger.side,
        observations: {
          patternM15: { passed: true, observed: `${trigger.side}:${trigger.pattern}` },
          supertrendM15: { passed: m15Direction === trigger.side, observed: m15Direction },
          supertrendM5: { passed: m5Direction === trigger.side, observed: m5Direction },
          validTrendStructure: { passed: structuralStopDistance > 0, observed: structuralStopDistance },
          ma20Ma50: {
            passed: trigger.side === "BUY" ? ma20 > ma50 : ma20 < ma50,
            observed: { ma20, ma50 },
          },
          fvg: { passed: fvgConfirmed, observed: fvgConfirmed ? "CONFIRMED" : "NONE" },
        },
      })
    : null;

  if (!entryConditions || !entryConditions.allEnabledPassed) {
    journal("ENTRY_STRATEGY_CONDITION_BLOCK", {
      signalId: `phase7b-demo-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
      side: trigger.side,
      pattern: trigger.pattern,
      reason: entryConditions
        ? entryConditions.failedConditions.join(",")
        : "ENTRY_STRATEGY_CONFIG_INVALID",
      configError: strategy.error,
      entryPolicy: reversalContext
        ? "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"
        : "TREND_CONTINUATION",
      reversalContext,
      entryConditions,
    });
    return null;
  }

  journal("ENTRY_STRATEGY_CONDITIONS_PASS", {
    signalId: `phase7b-demo-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
    side: trigger.side,
    pattern: trigger.pattern,
    entryPolicy: reversalContext
      ? "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"
      : "TREND_CONTINUATION",
    reversalContext,
    entryConditions,
  });

  if (!(structuralStopDistance > 0)) return null;

  const stopDistance = structuralStopDistance > MAX_INITIAL_SL_PRICE
    ? structuralStopDistance
    : Math.max(MIN_INITIAL_SL_PRICE, structuralStopDistance);
  const stopLoss = trigger.side === "BUY" ? entry - stopDistance : entry + stopDistance;
  const initialRiskUsd = spec.tickSize > 0
    ? Math.abs(entry - stopLoss) / spec.tickSize * spec.effectiveTickValuePerLot * fixedVolume
    : 0;

  return {
    id: `phase7b-demo-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
    side: trigger.side,
    pattern: trigger.pattern,
    signalTimestamp: current.closeTime,
    entry: roundValue(entry, 5),
    patternExtreme: roundValue(trigger.patternExtreme, 5),
    strategyConfigSnapshot: {
      version: entryConditions.configVersion,
      valid: true,
    },
    entryConditions,
    reversalContext,
  };
}

function readStrategyEntryConfigSnapshot(): StrategyEntryConfigSnapshot {
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

function detectEntryPattern(
  bars: Phase7Bar[],
  index: number,
): { side: "BUY" | "SELL"; pattern: Phase7BSignal["pattern"]; patternExtreme: number } | null {
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
      return { side: "BUY", pattern: "THREE_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(anchor.low, b.low, c.low, d.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) && isBearish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "SELL", pattern: "THREE_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(anchor.high, b.high, c.high, d.high) };
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
      return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(anchor.low, b.low, c.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(anchor.high, b.high, c.high) };
    }
  }

  if (index >= 1) {
    const previous = bars[index - 1]!;
    if (
      isBearish(previous) && isBullish(current) &&
      current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
      current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
    ) {
      return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
    }
    if (
      isBullish(previous) && isBearish(current) &&
      current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
      current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
    ) {
      return { side: "SELL", pattern: "ENGULFING", patternExtreme: current.high };
    }
  }
  return null;
}

async function closeFixedTpIfTriggered(
  position: Position,
  quote: Quote,
): Promise<boolean> {
  const managed = state.managed!;

  // Keep the migration/default path production-equivalent: no extra broker I/O
  // when this additive feature is disabled for the immutable managed snapshot.
  if (!managed.fixedTpEnabled || !Number.isFinite(Number(managed.fixedTpPrice))) {
    return false;
  }

  const positions = await get<Position[]>(
    `/v1/positions?symbol=${encodeURIComponent(symbol)}`,
  );
  if (positions.length !== 1) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      reason: "FIXED_TP_RECONCILE_REQUIRES_EXACTLY_ONE_POSITION",
      positions: positions.map((row) => ({ ticket: row.ticket, side: row.side, volume: row.volume })),
    });
    return true;
  }

  // Reconcile again at the Fixed TP decision point. This matters after a +10
  // partial in the same management cycle: position.volume must be the actual
  // remaining broker volume, not the pre-partial snapshot passed by cycle().
  position = positions[0]!;

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
    volume: position.volume,
  });

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

  if (!(Number.isFinite(position.volume) && position.volume > 0)) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      volume: position.volume,
      reason: "POSITION_VOLUME_INVALID",
    });
    return true;
  }

  const health = await get<Health>("/health");
  const accountLogin = Number(health.accountLogin);
  if (
    health.status !== "ok" ||
    health.accountMode !== "demo" ||
    !health.connected ||
    !health.tradingEnabled ||
    !health.terminalTradeAllowed ||
    !health.expertTradeAllowed ||
    !Number.isFinite(accountLogin) ||
    state.accountLogin !== accountLogin ||
    !allowedLogins.has(accountLogin)
  ) {
    journal("FIXED_TP_CLOSE_BLOCKED", {
      ticket: managed.ticket,
      reason: "EXECUTION_GUARD_BLOCK",
      accountLogin: health.accountLogin ?? null,
      expectedAccountLogin: state.accountLogin,
      accountMode: health.accountMode ?? null,
      connected: health.connected,
      tradingEnabled: health.tradingEnabled,
      terminalTradeAllowed: health.terminalTradeAllowed,
      expertTradeAllowed: health.expertTradeAllowed,
    });
    return true;
  }

  const commandId = fixedTpCommandId("trend", managed.ticket);
  const lock = acquireExecutionLock({
    owner: `TREND_FIXED_TP:${managed.ticket}`,
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
      volume: position.volume,
      targetPrice: managed.fixedTpPrice,
      commandId,
    });

    const response = await post<CommandResponse>(
      `/v1/positions/${encodeURIComponent(managed.ticket)}/close`,
      {
        volume: position.volume,
        commandId,
      },
    );

    if (!response.success) {
      journal("FIXED_TP_CLOSE_BLOCKED", {
        ticket: managed.ticket,
        commandId,
        volume: position.volume,
        reason: "BROKER_CLOSE_REJECTED",
        response,
      });
      return true;
    }

    if (response.idempotentReplay) {
      journal("FIXED_TP_CLOSE_REPLAY", {
        ticket: managed.ticket,
        commandId,
        volume: position.volume,
        response,
      });
    } else {
      journal("FIXED_TP_CLOSE_CONFIRMED", {
        ticket: managed.ticket,
        commandId,
        volume: position.volume,
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
      volume: position.volume,
      reason: "BROKER_CLOSE_ERROR",
      message: errorMessage(error),
    });
    return true;
  } finally {
    lock.release();
  }
}

async function reconcileFixedTpBrokerTakeProfit(input: {
  ticket: string;
  enabled: boolean;
  targetPrice: number | null;
  currentTakeProfit: number;
  strategy: "TREND";
}): Promise<void> {
  if (!input.enabled || !Number.isFinite(Number(input.targetPrice)) || Number(input.targetPrice) <= 0) return;
  const ticket = String(input.ticket);
  const targetPrice = Number(input.targetPrice);
  const currentTakeProfit = Number(input.currentTakeProfit);
  if (Number.isFinite(currentTakeProfit) && Math.abs(currentTakeProfit - targetPrice) <= 1e-9) {
    journal("FIXED_TP_BROKER_ALREADY_ALIGNED", { ticket, strategy: input.strategy, takeProfit: targetPrice });
    return;
  }
  const commandId = `phase7c-fixed-tp-broker-trend-${ticket}`;
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
    const response = await patch<CommandResponse>(
      `/v1/positions/${encodeURIComponent(ticket)}`,
      payload,
    );
    if (!response.success) {
      journal("FIXED_TP_BROKER_RECONCILE_REJECTED", { ticket, strategy: input.strategy, targetPrice, commandId, response });
      return;
    }
    journal("FIXED_TP_BROKER_RECONCILED", { ticket, strategy: input.strategy, targetPrice, commandId, response });
  } catch (error) {
    // Fixed TP broker alignment is additive protection. Ownership and durable
    // management must survive a transport/schema/broker failure here.
    journal("FIXED_TP_BROKER_RECONCILE_ERROR", {
      ticket,
      strategy: input.strategy,
      targetPrice,
      commandId,
      message: errorMessage(error),
    });
  }
}

function recordManagementExitSideSample({
  managed,
  quote,
  exitSidePrice,
}: {
  managed: ManagedState;
  quote: Quote;
  exitSidePrice: number;
}): void {
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
      strategy: "TREND",
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
    console.warn(`PHASE7B_DEMO_EVIDENCE_WRITE_SKIPPED=${errorMessage(error)}`);
  }
}

async function managePosition(position: Position, quote: Quote, spec: SymbolSpec, m15: Phase7Bar[]): Promise<void> {
  const managed = state.managed!;
  const exitPrice = managed.side === "BUY" ? quote.bid : quote.ask;
  const favorable = managed.side === "BUY" ? exitPrice - position.entry : position.entry - exitPrice;
  recordManagementExitSideSample({ managed, quote, exitSidePrice: exitPrice });
  const latestM15 = m15.at(-1);
  const holdM15CloseTime = Number(latestM15?.closeTime ?? 0);

  if (!managed.breakEvenApplied && favorable >= 6) {
    const beStop = roundPrice(position.entry, spec.digits);
    if (stopIsAtLeastAsTight(managed.side, Number(position.stopLoss), beStop)) {
      managed.breakEvenApplied = true;
      managed.lastStructuralStop = Number(position.stopLoss);
      saveState();
      journal("PLUS6_SL_ALREADY_AT_OR_TIGHTER", {
        ticket: managed.ticket,
        favorable,
        entry: beStop,
        stopLoss: Number(position.stopLoss),
      });
    } else {
      managed.beAttempt += 1;
      saveState();
      const commandId = `p7b-be-${managed.ticket}-${managed.beAttempt}`;
      const response = await patch<CommandResponse>(`/v1/positions/${encodeURIComponent(managed.ticket)}`, {
        stopLoss: beStop,
        commandId,
      });
      if (response.success) {
        managed.breakEvenApplied = true;
        managed.lastStructuralStop = beStop;
        saveState();
        journal("PLUS6_SL_TO_ENTRY", { ticket: managed.ticket, favorable, stopLoss: beStop, response });
      } else {
        journal("PLUS6_SL_REJECTED", { ticket: managed.ticket, favorable, response });
      }
    }
  }

  if (managed.dailyMode === "RECOVERY_TP") {
    if (await closeFixedTpIfTriggered(position, quote)) return;

    const hold =
      canonicalHoldReason(
        "TREND",
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

  const fastMoveStructure = managed.partialApplied && latestM15
    ? latestConfirmedStructureStop(managed.side, m15, managed.signalTimestamp, latestM15.closeTime)
    : null;
  if (fastMoveStructure === null) {
  const fastMove = fastMoveProfitLockCandidate({
    side: managed.side,
    entry: position.entry,
    marketPrice: exitPrice,
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
    const candidate = roundPrice(fastMove.candidateStop, spec.digits);
    const fastMoveBaseline = tightestKnownStop(
      managed.side,
      Number(position.stopLoss),
      Number(managed.lastStructuralStop),
    );
    if (stopStrictlyTightens(managed.side, fastMoveBaseline, candidate)) {
      const minimumGap = Math.max(spec.stopsLevelTicks, spec.freezeLevelTicks) * spec.point;
      const validAgainstMarket = managed.side === "BUY"
        ? candidate < quote.bid - minimumGap
        : candidate > quote.ask + minimumGap;
      if (validAgainstMarket) {
        managed.fastMoveAttempt = Number(managed.fastMoveAttempt ?? 0) + 1;
        saveState();
        const commandId = `p7b-fast-lock-${managed.ticket}-${managed.fastMoveAttempt}`;
        const response = await patch<CommandResponse>(`/v1/positions/${encodeURIComponent(managed.ticket)}`, {
          stopLoss: candidate,
          commandId,
        });
        if (response.success) {
          managed.lastStructuralStop = candidate;
          saveState();
          journal("FAST_MOVE_PROFIT_LOCK_TIGHTEN", {
            ticket: managed.ticket,
            side: managed.side,
            favorable,
            peakPrice: fastMove.peakPrice,
            peakFavorable: fastMove.peakFavorable,
            giveback: FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE,
            stopLoss: candidate,
            response,
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
  }

  const hold =
    canonicalHoldReason(
      "TREND",
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

  if (!managed.partialApplied && favorable >= 10) {
    const closeVolume = partialVolume(managed.initialVolume, position.volume, spec);
    if (closeVolume > 0) {
      managed.partialAttempt += 1;
      saveState();
      const commandId = `p7b-p10-${managed.ticket}-${managed.partialAttempt}`;
      const response = await post<CommandResponse>(`/v1/positions/${encodeURIComponent(managed.ticket)}/close`, {
        volume: closeVolume,
        commandId,
      });
      if (response.success) {
        managed.partialApplied = true;
        managed.partialActivatedAt = Number(quote.timestamp);
        managed.expectedRemainingVolume = normalizeVolume(position.volume - closeVolume, spec.volumeStep);
        saveState();
        journal("PLUS10_PARTIAL_ONE_THIRD", {
          ticket: managed.ticket,
          favorable,
          closedVolume: closeVolume,
          remainingVolume: managed.expectedRemainingVolume,
          response,
        });
      } else {
        journal("PLUS10_PARTIAL_REJECTED", { ticket: managed.ticket, favorable, closeVolume, response });
      }
    } else {
      journal("PLUS10_PARTIAL_NOT_FEASIBLE", { ticket: managed.ticket, initialVolume: managed.initialVolume, currentVolume: position.volume });
    }
  }

  if (await closeFixedTpIfTriggered(position, quote)) return;

  const latest = latestM15;
  if (!latest) return;

  if (managed.partialApplied) {
    const structure = latestConfirmedStructureStop(managed.side, m15, managed.signalTimestamp, latest.closeTime);
    if (structure !== null) {
      const candidate = roundPrice(
        structuralStopWithBuffer(managed.side, structure),
        spec.digits,
      );
      const structuralBaseline = tightestKnownStop(
        managed.side,
        Number(position.stopLoss),
        Number(managed.lastStructuralStop),
      );
      if (stopStrictlyTightens(managed.side, structuralBaseline, candidate)) {
        const minimumGap = Math.max(spec.stopsLevelTicks, spec.freezeLevelTicks) * spec.point;
        const validAgainstMarket = managed.side === "BUY"
          ? candidate < quote.bid - minimumGap
          : candidate > quote.ask + minimumGap;
        if (validAgainstMarket) {
          managed.structureAttempt += 1;
          saveState();
          const commandId = `p7b-struct-${managed.ticket}-${latest.closeTime}-${managed.structureAttempt}`;
          const response = await patch<CommandResponse>(`/v1/positions/${encodeURIComponent(managed.ticket)}`, {
            stopLoss: candidate,
            commandId,
          });
          if (response.success) {
            managed.lastStructuralStop = candidate;
            saveState();
            journal("STRUCTURAL_SL_TIGHTEN", { ticket: managed.ticket, stopLoss: candidate, m15CloseTime: latest.closeTime, response });
          } else {
            journal("STRUCTURAL_SL_REJECTED", { ticket: managed.ticket, stopLoss: candidate, response });
          }
        }
      }
    }

    if (
      managed.partialActivatedAt !== null &&
      latest.closeTime > managed.lastReversalM15CloseChecked &&
      latest.closeTime >= managed.partialActivatedAt
    ) {
      managed.lastReversalM15CloseChecked = latest.closeTime;
      saveState();
      if (opposingFvgRejectionAt(managed.side, m15, latest.closeTime, 48, managed.signalTimestamp)) {
        await closeAll(position, "REVERSAL_FVG_REJECTION", latest.closeTime);
        return;
      }
    }
  }

  if (latest.closeTime > managed.lastTrendM15CloseChecked && latest.closeTime > managed.signalTimestamp) {
    const closes = m15.map((bar) => bar.close);
    const ma20 = smaPeriod(closes, 20);
    const ma50 = smaPeriod(closes, 50);
    const ma200 = smaPeriod(closes, 200);
    const ma50TrendIntact = managed.side === "BUY" ? latest.close >= ma50 : latest.close <= ma50;
    const ma200MacroAligned = managed.side === "BUY" ? latest.close >= ma200 : latest.close <= ma200;
    const sameDirectionFvg = hasRelevantFvg(m15, m15.length - 1, managed.side, 12);

    if (sameDirectionFvg && ma50TrendIntact) {
      journal("FVG_HOLD_CONFIRMED", {
        ...(canonicalHoldReason(
          "TREND",
          managed,
        ) ?? {}),
        ticket: managed.ticket,
        side: managed.side,
        m15CloseTime: latest.closeTime,
        favorable,
        ma20: roundValue(ma20, 5),
        ma50: roundValue(ma50, 5),
        ma200: roundValue(ma200, 5),
        ma50TrendIntact,
        ma200MacroAligned,
      });

      if (favorable > 0) {
        journal("FVG_ADDON_SIGNAL_SHADOW", {
          ticket: managed.ticket,
          side: managed.side,
          m15CloseTime: latest.closeTime,
          favorable,
          referenceVolume: fixedVolume,
          shadowOnly: true,
          orderSent: false,
          reason: "SAME_DIRECTION_FVG_PLUS_MA50_TREND_WHILE_POSITION_WINNING",
        });
      }
    }

    managed.lastTrendM15CloseChecked = latest.closeTime;
    saveState();
    const runnerTrendBroken = managed.partialApplied && !ma50TrendIntact;
    if (runnerTrendBroken) {
      await closeAll(position, "RUNNER_TREND_MA50", latest.closeTime);
    }
  }
}

async function closeAll(position: Position, reason: string, m15CloseTime: number): Promise<void> {
  const managed = state.managed!;
  managed.exitAttempt += 1;
  saveState();
  const commandId = `p7b-exit-${reason}-${managed.ticket}-${m15CloseTime}-${managed.exitAttempt}`;
  const response = await post<CommandResponse>(`/v1/positions/${encodeURIComponent(managed.ticket)}/close`, {
    volume: position.volume,
    commandId,
  });
  if (!response.success) {
    journal("EXIT_REJECTED", { ticket: managed.ticket, reason, volume: position.volume, response });
    return;
  }
  journal("EXIT_EXECUTED", { ticket: managed.ticket, reason, volume: position.volume, response });
  state.managed = null;
  saveState();
}

function hasRelevantFvg(bars: Phase7Bar[], index: number, side: "BUY" | "SELL", lookback: number): boolean {
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

function latestConfirmedStructureStop(
  side: "BUY" | "SELL",
  bars: Phase7Bar[],
  afterTimestamp: number,
  atOrBefore: number,
): number | null {
  let latest: number | null = null;
  for (let i = 1; i < bars.length - 1; i += 1) {
    const left = bars[i - 1]!;
    const middle = bars[i]!;
    const right = bars[i + 1]!;
    if (right.closeTime > atOrBefore || right.closeTime <= afterTimestamp) continue;
    if (side === "BUY" && middle.low < left.low && middle.low <= right.low) latest = middle.low;
    if (side === "SELL" && middle.high > left.high && middle.high >= right.high) latest = middle.high;
  }
  return latest;
}

function opposingFvgRejectionAt(
  side: "BUY" | "SELL",
  bars: Phase7Bar[],
  closeTime: number,
  lookback: number,
  afterSignalTimestamp: number,
): boolean {
  const currentIndex = bars.findIndex((bar) => bar.closeTime === closeTime);
  if (currentIndex < 2) return false;
  const current = bars[currentIndex]!;
  if (current.closeTime <= afterSignalTimestamp) return false;
  const rejectionDirection = side === "BUY" ? current.close < current.open : current.close > current.open;
  if (!rejectionDirection) return false;
  const start = Math.max(2, currentIndex - lookback);
  for (let i = currentIndex - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.high < first.low) {
      const zoneLow = third.high;
      const zoneHigh = first.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close < zoneHigh) return true;
    }
    if (side === "SELL" && third.low > first.high) {
      const zoneLow = first.high;
      const zoneHigh = third.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close > zoneLow) return true;
    }
  }
  return false;
}

function latestClosedIndex(bars: Phase7Bar[], timestamp: number): number {
  let result = -1;
  for (let index = 0; index < bars.length; index += 1) {
    if (bars[index]!.closeTime <= timestamp) result = index;
    else break;
  }
  return result;
}

function structuralDistance(side: "BUY" | "SELL", entry: number, stop: number): number {
  return side === "BUY" ? entry - stop : stop - entry;
}

function trendMatches(side: "BUY" | "SELL", close: number, ma20: number, ma50: number, ma200: number): boolean {
  return side === "BUY"
    ? ma20 > ma50 && ma50 > ma200 && close > ma20
    : ma20 < ma50 && ma50 < ma200 && close < ma20;
}

function isBullish(bar: Phase7Bar): boolean {
  return bar.close > bar.open;
}

function isBearish(bar: Phase7Bar): boolean {
  return bar.close < bar.open;
}

function bodySize(bar: Phase7Bar): number {
  return Math.abs(bar.close - bar.open);
}

function phase7CBrokerComment(clientOrderId: string): string {
  const safeValue = Array.from(String(clientOrderId))
    .map((character) =>
      character.codePointAt(0)! <= 0x7f && /[A-Za-z0-9._-]/.test(character)
        ? character
        : "-",
    )
    .join("");
  const comment = `xau:${safeValue}`.replace(/^-+|-+$/g, "");
  return (comment || "xau").slice(0, 28);
}

function matchPendingTrendPosition(
  pending: PendingTrendEntry,
  position: Position,
  spec: SymbolSpec,
): { matched: boolean; reason: string } {
  if (
    pending.brokerTicket &&
    String(position.ticket) !== pending.brokerTicket
  ) {
    return {
      matched: false,
      reason: "PENDING_TICKET_MISMATCH",
    };
  }

  const expectedSide =
    pending.side === "BUY"
      ? "LONG"
      : "SHORT";

  if (position.side !== expectedSide) {
    return {
      matched: false,
      reason: "PENDING_SIDE_MISMATCH",
    };
  }

  if (
    !(spec.volumeStep > 0) ||
    !(spec.point > 0)
  ) {
    return {
      matched: false,
      reason: "PENDING_BROKER_SPEC_INVALID",
    };
  }

  let brokerProvenanceMatched = false;

  if (!pending.brokerTicket) {
    const brokerReferenceTimestamp =
      Number(pending.brokerReferenceTimestamp);

    const openedAt = Number(position.openedAt);

    if (
      !Number.isFinite(brokerReferenceTimestamp) ||
      brokerReferenceTimestamp <= 0 ||
      !Number.isFinite(openedAt) ||
      openedAt <= 0
    ) {
      return {
        matched: false,
        reason: "PENDING_TIMESTAMP_INVALID",
      };
    }

    const openTimeToleranceMs = 120_000;

    if (
      Math.abs(
        openedAt - brokerReferenceTimestamp,
      ) > openTimeToleranceMs
    ) {
      return {
        matched: false,
        reason: "PENDING_OPEN_TIME_MISMATCH",
      };
    }

    const positionMagic = Number(position.magic);
    const positionComment =
      typeof position.comment === "string"
        ? position.comment.trim()
        : "";
    const expectedComment =
      phase7CBrokerComment(pending.orderId);
    const hasBrokerProvenance =
      Number.isFinite(positionMagic) &&
      positionMagic > 0 &&
      positionComment.length > 0;

    if (hasBrokerProvenance) {
      if (positionMagic !== magicNumber) {
        return {
          matched: false,
          reason: "PENDING_MAGIC_MISMATCH",
        };
      }

      if (positionComment !== expectedComment) {
        return {
          matched: false,
          reason: "PENDING_COMMENT_MISMATCH",
        };
      }

      brokerProvenanceMatched = true;
    }

    if (!brokerProvenanceMatched) {
      const actualEntry = Number(position.entry);
      const referenceEntry = Number(pending.referenceEntry);

      if (
        !Number.isFinite(actualEntry) ||
        !Number.isFinite(referenceEntry)
      ) {
        return {
          matched: false,
          reason: "PENDING_ENTRY_PRICE_INVALID",
        };
      }

      const entryTolerance =
        Math.max(
          spec.point * (deviationPoints + 2),
          1e-6,
        );

      if (
        Math.abs(position.entry - pending.referenceEntry) >
        entryTolerance
      ) {
        return {
          matched: false,
          reason: "PENDING_ENTRY_PRICE_MISMATCH",
        };
      }
    }
  }

  const volumeTolerance =
    spec.volumeStep / 2 + 1e-9;

  if (
    Math.abs(position.volume - pending.volume) >
    volumeTolerance
  ) {
    return {
      matched: false,
      reason: "PENDING_VOLUME_MISMATCH",
    };
  }

  if (brokerProvenanceMatched) {
    return {
      matched: true,
      reason: "PENDING_POSITION_MATCHED_BY_BROKER_PROVENANCE",
    };
  }

  const priceTolerance =
    Math.max(spec.point * 2, 1e-6);

  if (
    Math.abs(position.stopLoss - pending.stopLoss) >
    priceTolerance
  ) {
    return {
      matched: false,
      reason: "PENDING_STOP_LOSS_MISMATCH",
    };
  }

  const expectedTakeProfit =
    pending.dailyMode !== "RECOVERY_TP" &&
    pending.fixedTpEnabled &&
    pending.fixedTpPrice !== null
      ? pending.fixedTpPrice
      : pending.takeProfit;

  if (
    Math.abs(position.takeProfit - expectedTakeProfit) >
    priceTolerance
  ) {
    return {
      matched: false,
      reason: "PENDING_TAKE_PROFIT_MISMATCH",
    };
  }

  return {
    matched: true,
    reason: "PENDING_POSITION_MATCHED",
  };
}

function managedFromPending(
  pending: PendingTrendEntry,
  position: Position,
): ManagedState {
  const fixedTpSnapshot = buildFixedTpSnapshot({
    enabled: pending.fixedTpEnabled,
    distance: pending.fixedTpDistance,
    side: pending.side,
    entry: position.entry,
  });
  return {
    ticket: position.ticket,
    side: pending.side,
    pattern: pending.pattern,
    signalTimestamp: pending.signalTimestamp,
    signalEntry: pending.signalEntry,
    entry: position.entry,
    initialVolume: position.volume,
    expectedRemainingVolume: position.volume,
    stopDistance: pending.stopDistance,
    fixedTpEnabled: pending.fixedTpEnabled,
    fixedTpDistance: pending.fixedTpDistance,
    fixedTpPrice: fixedTpSnapshot.targetPrice,
    breakEvenApplied: false,
    partialApplied: false,
    partialActivatedAt: null,
    lastStructuralStop:
      position.stopLoss || pending.stopLoss,
    lastReversalM15CloseChecked:
      pending.signalTimestamp,
    lastTrendM15CloseChecked:
      pending.signalTimestamp,
    beAttempt: 0,
    partialAttempt: 0,
    exitAttempt: 0,
    structureAttempt: 0,
    dailyMode: pending.dailyMode,
    dailyNetPnlAtEntry:
      pending.dailyNetPnlAtEntry,
    recoveryTargetNetPnl:
      pending.recoveryTargetNetPnl,
    recoveryTpDistance:
      pending.recoveryTpDistance,
    recoveryTakeProfit:
      pending.recoveryTakeProfit,
    recoveryDayStartTime:
      pending.recoveryDayStartTime,
  };
}

function partialVolume(initial: number, remaining: number, spec: SymbolSpec): number {
  const raw = initial / 3;
  const stepped = Math.floor((raw + 1e-9) / spec.volumeStep) * spec.volumeStep;
  const normalized = normalizeVolume(stepped, spec.volumeStep);
  if (normalized < spec.minVolume - 1e-9) return 0;
  if (remaining - normalized < spec.minVolume - 1e-9) return 0;
  return Math.min(normalized, remaining);
}

function validateVolume(spec: SymbolSpec): void {
  if (fixedVolume < spec.minVolume - 1e-9 || fixedVolume > spec.maxVolume + 1e-9) {
    throw new Error(`Fixed volume ${fixedVolume} is outside broker range ${spec.minVolume}-${spec.maxVolume}.`);
  }
  const units = fixedVolume / spec.volumeStep;
  if (Math.abs(units - Math.round(units)) > 1e-8) {
    throw new Error(`Fixed volume ${fixedVolume} does not align with broker step ${spec.volumeStep}.`);
  }
  if (Math.round(units) % 3 !== 0 || fixedVolume / 3 < spec.minVolume - 1e-9) {
    throw new Error(`Fixed volume ${fixedVolume} cannot preserve exact one-third partial management at broker step ${spec.volumeStep}.`);
  }
}

function normalizeVolume(value: number, step: number): number {
  return Math.round(Math.max(0, Math.round((value + 1e-9) / step) * step) * 10_000) / 10_000;
}

function roundPrice(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundValue(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sma(values: number[]): number {
  return smaPeriod(values, 20);
}

function smaPeriod(values: number[], period: number): number {
  if (values.length < period) throw new Error(`Not enough M15 bars for MA${period}.`);
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function loadState(file: string): BotState {
  const normalizePendingEntry = (raw: PendingTrendEntry | null | undefined): PendingTrendEntry | null => {
    if (!raw) return null;
    const distance = Number(raw.fixedTpDistance);
    const price = Number(raw.fixedTpPrice);
    const fixedTpEnabled = raw.fixedTpEnabled === true && Number.isFinite(distance) && distance > 0 && Number.isFinite(price);
    return {
      ...raw,
      fixedTpEnabled: fixedTpEnabled ? true : false,
      fixedTpDistance: fixedTpEnabled ? distance : 0,
      fixedTpPrice: fixedTpEnabled ? price : null,
    };
  };
  const normalizeManagedState = (raw: ManagedState | null | undefined): ManagedState | null => {
    if (!raw) return null;
    const distance = Number(raw.fixedTpDistance);
    const price = Number(raw.fixedTpPrice);
    const fixedTpEnabled = raw.fixedTpEnabled === true && Number.isFinite(distance) && distance > 0 && Number.isFinite(price);
    return {
      ...raw,
      fixedTpEnabled: fixedTpEnabled ? true : false,
      fixedTpDistance: fixedTpEnabled ? distance : 0,
      fixedTpPrice: fixedTpEnabled ? price : null,
    };
  };
  if (!fs.existsSync(file)) {
    return {
      version: 2,
      accountLogin: null,
      lastEvaluatedM15Close: 0,
      lastEvaluatedM5Close: 0,
      pendingPullback: null,
      pendingEntry: null,
      managed: null,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedBotState;
  if (parsed.version === 1) {
    return {
      version: 2,
      accountLogin: parsed.accountLogin ?? null,
      lastEvaluatedM15Close: parsed.lastEvaluatedM15Close ?? 0,
      lastEvaluatedM5Close: 0,
      pendingPullback: null,
      pendingEntry: null,
      managed: normalizeManagedState(parsed.managed),
    };
  }
  if (parsed.version !== 2) throw new Error("Unsupported Phase 7B demo state version.");
  return {
    version: 2,
    accountLogin: parsed.accountLogin ?? null,
    lastEvaluatedM15Close: parsed.lastEvaluatedM15Close ?? 0,
    lastEvaluatedM5Close: parsed.lastEvaluatedM5Close ?? 0,
    pendingPullback: parsed.pendingPullback ?? null,
    pendingEntry: normalizePendingEntry(parsed.pendingEntry),
    managed: normalizeManagedState(parsed.managed),
  };
}

function saveState(): void {
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const result = writeStateFileAtomicSync(statePath, payload);
  if (result.recoveredFromTransientRename) {
    console.warn(
      `PHASE7B_DEMO_STATE_RENAME_RECOVERED=YES|ATTEMPTS=${result.attempts}|FILE=${statePath}`,
    );
  }
}

function journal(type: string, data: Record<string, unknown>): void {
  const row = { timestamp: new Date().toISOString(), type, ...data };
  fs.appendFileSync(journalPath, `${JSON.stringify(row)}\n`, "utf8");
  decisionAudit.record(type, row);
  console.log(`PHASE7B_DEMO_EVENT=${JSON.stringify(row)}`);
}

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) throw new Error(`Bridge env file not found: ${file}`);
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

async function get<T>(endpoint: string): Promise<T> {
  return bridgeRequest<T>("GET", endpoint);
}
async function post<T>(endpoint: string, body: unknown): Promise<T> {
  return bridgeRequest<T>("POST", endpoint, body);
}
async function patch<T>(endpoint: string, body: unknown): Promise<T> {
  return bridgeRequest<T>("PATCH", endpoint, body);
}

async function bridgeRequest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const normalizedMethod = method.toUpperCase();
  const timeoutMs = 8_000;
  const maxAttempts = normalizedMethod === "GET" ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${bridgeBase}${endpoint}`, {
          method: normalizedMethod,
          headers: {
            "x-mt5-api-key": apiKey,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const errorObject = error instanceof Error ? error : null;
        const aborted = timedOut || errorObject?.name === "AbortError";
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
        const transport = aborted
          ? `timeout=${timeoutMs}ms`
          : `transport=${errorObject?.message === "fetch failed" ? "fetch failed" : errorObject?.name || "request failed"}${causeCode ? `|cause=${causeCode}` : ""}`;

        // Do not immediately retry a timed-out bridge request. Abort only
        // cancels the client wait; the synchronous MT5 call can still be
        // running server-side and holding the shared gateway lock. Retrying
        // that timeout would queue duplicate reads behind the same stuck call.
        if (normalizedMethod === "GET" && !aborted && attempt < maxAttempts) {
          console.warn(
            `PHASE7B_MT5_READ_RETRY=GET|${endpoint}|attempt=${attempt}|reason=${transport}`,
          );
          await sleep(250);
          continue;
        }

        throw new Error(
          `MT5 bridge ${normalizedMethod} ${endpoint} | ${transport} | attempts=${attempt}`,
          errorObject ? { cause: errorObject } : undefined,
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        const errorObject = error instanceof Error ? error : null;
        if (normalizedMethod === "GET" && attempt < maxAttempts) {
          console.warn(
            `PHASE7B_MT5_READ_RETRY=GET|${endpoint}|attempt=${attempt}|reason=response-read-failed`,
          );
          await sleep(250);
          continue;
        }
        throw new Error(
          `MT5 bridge ${normalizedMethod} ${endpoint} | response-read-failed | attempts=${attempt}`,
          errorObject ? { cause: errorObject } : undefined,
        );
      }

      if (!response.ok) {
        throw new Error(
          `MT5 bridge ${normalizedMethod} ${endpoint} failed ${response.status}: ${text}`,
        );
      }

      return (text ? JSON.parse(text) : null) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`MT5 bridge ${normalizedMethod} ${endpoint} | exhausted safe read retry`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
