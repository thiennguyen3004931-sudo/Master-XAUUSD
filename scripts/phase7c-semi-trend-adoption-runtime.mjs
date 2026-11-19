import {
  HttpMt5Transport,
  Mt5BridgeClient,
  Mt5ExecutionAdapter,
  Mt5MarketDataClient,
  defaultMt5BrokerConfig,
} from "@xauusd/mt5-broker";
import {
  evaluatePhase7CAccountHealth,
  resolvePhase7CAccountRuntime,
} from "./phase7c-account-runtime-guard.mjs";
import { acquireExecutionLock } from "./phase7c-execution-lock.mjs";

const SYMBOL = "XAUUSD";
const INITIAL_STOP_DISTANCE = 6;
const EPSILON = 1e-8;

function modeState(payload) {
  if (payload && typeof payload === "object" && payload.state) return payload.state;
  return payload;
}

function activationEpoch(payload) {
  const state = modeState(payload);
  const value = Date.parse(String(state?.updatedAt ?? ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function activeMode(payload) {
  return String(modeState(payload)?.mode ?? "PAUSE").trim().toUpperCase();
}

function samePrice(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= EPSILON;
}

function brokerGate(health, accountRuntime, armed) {
  const gate = evaluatePhase7CAccountHealth(health, accountRuntime, { armed });
  if (!gate.allowed) return { allowed: false, reason: gate.reason, login: null };

  if (
    accountRuntime.accountMode === "LIVE" &&
    (health?.liveExecutionArmed !== true || health?.liveArmStatus !== "ARMED")
  ) {
    return { allowed: false, reason: "LIVE_ARM_REQUIRED", login: gate.login ?? null };
  }

  return { allowed: true, reason: "PASS", login: gate.login ?? null };
}

function selectOpeningDeal(deals, position, activationEpochMs) {
  return [...deals]
    .filter((deal) =>
      String(deal?.positionId ?? "") === String(position.ticket) &&
      deal?.entry === "IN" &&
      Number.isFinite(Number(deal?.timestamp)) &&
      Number(deal.timestamp) > activationEpochMs,
    )
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))[0] ?? null;
}

function fixedTakeProfit(position, enabled, distance) {
  if (!enabled) return { enabled: false, price: null };
  if (!Number.isFinite(distance) || distance <= 0) {
    return { enabled: true, price: null };
  }
  return {
    enabled: true,
    price: position.side === "LONG"
      ? position.entry + distance
      : position.entry - distance,
  };
}

function buildEvaluationInput({
  position,
  openingDeal,
  mode,
  activationEpochMs,
  systemMagicNumber,
  quote,
  spec,
  trendFixedTpEnabled,
  trendFixedTpDistance,
}) {
  return {
    mode,
    activationEpochMs,
    symbol: SYMBOL,
    systemMagicNumber,
    position: {
      ticket: String(position.ticket),
      symbol: String(position.symbol),
      side: position.side,
      entry: Number(position.entry),
      stopLoss: Number(position.stopLoss ?? 0),
      takeProfit: Number(position.takeProfit ?? 0),
      openedAt: Number(position.openedAt),
    },
    openingDeal: openingDeal
      ? {
          ticket: String(openingDeal.ticket),
          positionId: String(openingDeal.positionId),
          symbol: String(openingDeal.symbol),
          side: openingDeal.side ?? null,
          entry: openingDeal.entry ?? "UNKNOWN",
          magic: Number(openingDeal.magic),
          comment: String(openingDeal.comment ?? ""),
          timestamp: Number(openingDeal.timestamp),
        }
      : null,
    quote: {
      bid: Number(quote?.bid),
      ask: Number(quote?.ask),
    },
    spec: {
      tickSize: Number(spec?.tickSize),
      stopsLevelTicks: Number(spec?.stopsLevelTicks),
      freezeLevelTicks: Number(spec?.freezeLevelTicks),
    },
    fixedTakeProfit: fixedTakeProfit(
      position,
      trendFixedTpEnabled,
      trendFixedTpDistance,
    ),
  };
}

function durablePendingState({
  evaluation,
  position,
  openingDeal,
  accountLogin,
  activationEpochMs,
  now,
  fixedTp,
}) {
  return {
    version: 1,
    ownershipId: `semi:${position.ticket}:${activationEpochMs}`,
    ticket: String(position.ticket),
    openingDealTicket: String(openingDeal.ticket),
    symbol: SYMBOL,
    accountLogin: String(accountLogin),
    entrySource: "MANUAL",
    managementStrategy: "TREND",
    side: position.side,
    entry: Number(position.entry),
    initialVolume: Number(position.volume),
    expectedRemainingVolume: Number(position.volume),
    activationEpochMs,
    manualOpenedAt: Number(position.openedAt),
    managementStartedAt: Math.max(Number(position.openedAt), now),
    initialStopDistance: INITIAL_STOP_DISTANCE,
    targetStopLoss: Number(evaluation.targetStopLoss),
    tightestStopLoss: Number(evaluation.targetStopLoss),
    protectionStatus: "PENDING",
    protectionReason: evaluation.reason,
    fixedTakeProfit: {
      enabled: fixedTp.enabled === true,
      targetPrice: fixedTp.enabled ? Number(fixedTp.price) : null,
    },
    updatedAt: now,
  };
}

function adoptionMatches(state, position, accountLogin, activationEpochMs) {
  return Boolean(
    state &&
    state.ticket === String(position.ticket) &&
    state.ownershipId === `semi:${position.ticket}:${activationEpochMs}` &&
    state.accountLogin === String(accountLogin) &&
    state.activationEpochMs === activationEpochMs &&
    state.symbol === SYMBOL &&
    state.entrySource === "MANUAL" &&
    state.managementStrategy === "TREND" &&
    state.side === position.side &&
    samePrice(Number(state.entry), Number(position.entry)),
  );
}

function toManagedState(adoption, position, input) {
  const fixedTpDistance = adoption.fixedTakeProfit.enabled
    ? Number(input.trendFixedTpDistance)
    : 0;
  const breakEvenApplied = adoption.side === "LONG"
    ? Number(position.stopLoss) + EPSILON >= Number(adoption.entry)
    : Number(position.stopLoss) - EPSILON <= Number(adoption.entry) && Number(position.stopLoss) > 0;

  return {
    ticket: adoption.ticket,
    side: adoption.side === "LONG" ? "BUY" : "SELL",
    pattern: "SEMI_MANUAL",
    signalTimestamp: adoption.manualOpenedAt,
    signalEntry: adoption.entry,
    entry: adoption.entry,
    initialVolume: adoption.initialVolume,
    expectedRemainingVolume: Number(position.volume),
    stopDistance: INITIAL_STOP_DISTANCE,
    fixedTpEnabled: adoption.fixedTakeProfit.enabled,
    fixedTpDistance,
    fixedTpPrice: adoption.fixedTakeProfit.targetPrice,
    breakEvenApplied,
    partialApplied: false,
    partialActivatedAt: null,
    lastStructuralStop: Number(position.stopLoss) > 0
      ? Number(position.stopLoss)
      : adoption.tightestStopLoss,
    lastReversalM15CloseChecked: Number(input.latestM15CloseTime) || adoption.manualOpenedAt,
    lastTrendM15CloseChecked: Number(input.latestM15CloseTime) || adoption.manualOpenedAt,
    beAttempt: 0,
    partialAttempt: 0,
    exitAttempt: 0,
    structureAttempt: 0,
    dailyMode: "TREND",
  };
}

function blocked(reason, detail = null) {
  return { status: "BLOCKED", reason, detail, managed: null };
}

export function createPhase7CSemiTrendAdoptionRuntime(dependencies) {
  const deps = dependencies;

  async function reconcile(input) {
    const firstMode = await deps.getBotMode();
    if (activeMode(firstMode) !== "SEMI") {
      return { status: "SKIPPED", reason: "MODE_NOT_SEMI", managed: null };
    }

    const activationEpochMs = activationEpoch(firstMode);
    if (!activationEpochMs) return blocked("INVALID_ACTIVATION_EPOCH");
    if (!deps.armed) return blocked("EXECUTOR_NOT_ARMED");

    const firstHealth = await deps.getHealth();
    const firstGate = brokerGate(firstHealth, deps.accountRuntime, true);
    if (!firstGate.allowed) return blocked(firstGate.reason);

    const firstPositions = await deps.getPositions(SYMBOL);
    if (firstPositions.length === 0) {
      return { status: "SKIPPED", reason: "NO_POSITION", managed: null };
    }
    if (firstPositions.length !== 1) return blocked("EXACTLY_ONE_POSITION_REQUIRED");

    const firstPosition = firstPositions[0];
    if (!firstPosition || String(firstPosition.symbol).trim().toUpperCase() !== SYMBOL) {
      return blocked("SYMBOL_NOT_ELIGIBLE");
    }

    const lock = deps.acquireExecutionLock({ owner: `SEMI_ADOPTION:${firstPosition.ticket}` });
    if (!lock?.acquired) return blocked("EXECUTION_LOCK_BUSY", lock?.reason ?? "LOCK_BUSY");

    try {
      const lockedMode = await deps.getBotMode();
      const lockedActivationEpochMs = activationEpoch(lockedMode);
      if (
        activeMode(lockedMode) !== "SEMI" ||
        !lockedActivationEpochMs ||
        lockedActivationEpochMs !== activationEpochMs
      ) {
        return blocked("MODE_CHANGED_UNDER_LOCK");
      }

      const lockedHealth = await deps.getHealth();
      const lockedGate = brokerGate(lockedHealth, deps.accountRuntime, true);
      if (!lockedGate.allowed) return blocked(lockedGate.reason);

      const positions = await deps.getPositions(SYMBOL);
      if (positions.length !== 1) return blocked("POSITION_SET_CHANGED_UNDER_LOCK");
      const position = positions[0];
      if (
        !position ||
        String(position.ticket) !== String(firstPosition.ticket) ||
        String(position.symbol).trim().toUpperCase() !== SYMBOL ||
        position.side !== firstPosition.side ||
        !samePrice(Number(position.entry), Number(firstPosition.entry))
      ) {
        return blocked("POSITION_IDENTITY_CHANGED_UNDER_LOCK");
      }

      const now = deps.now();
      const deals = await deps.getDeals(activationEpochMs, Math.max(now, activationEpochMs + 1), SYMBOL);
      const openingDeal = selectOpeningDeal(deals, position, activationEpochMs);
      const [quote, spec] = await Promise.all([
        deps.getQuote(SYMBOL),
        deps.getSpec(SYMBOL),
      ]);

      const evaluationInput = buildEvaluationInput({
        position,
        openingDeal,
        mode: "SEMI",
        activationEpochMs,
        systemMagicNumber: input.systemMagicNumber,
        quote,
        spec,
        trendFixedTpEnabled: input.trendFixedTpEnabled,
        trendFixedTpDistance: input.trendFixedTpDistance,
      });
      const evaluation = deps.evaluateAdoption(evaluationInput);
      if (evaluation.status !== "PENDING") return blocked(evaluation.reason);

      const fixedTp = evaluationInput.fixedTakeProfit;
      let adoption = await deps.adoptionRepository.findByTicket(String(position.ticket));
      if (adoption) {
        if (!adoptionMatches(adoption, position, lockedGate.login, activationEpochMs)) {
          return blocked("DURABLE_OWNERSHIP_MISMATCH");
        }
      } else {
        adoption = durablePendingState({
          evaluation,
          position,
          openingDeal,
          accountLogin: lockedGate.login,
          activationEpochMs,
          now,
          fixedTp,
        });
        try {
          await deps.adoptionRepository.save(adoption);
        } catch (error) {
          return blocked(
            "ADOPTION_PERSIST_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (
        adoption.protectionStatus !== "PROTECTED" &&
        adoption.protectionStatus !== "MANAGED"
      ) {
        const protection = await deps.executeProtection(String(position.ticket));
        if (protection?.status !== "PROTECTED") {
          return blocked(protection?.reason ?? "PROTECTION_BLOCKED");
        }
      }

      const protectedState = await deps.adoptionRepository.findByTicket(String(position.ticket));
      if (
        !protectedState ||
        (protectedState.protectionStatus !== "PROTECTED" && protectedState.protectionStatus !== "MANAGED")
      ) {
        return blocked("PROTECTION_NOT_DURABLY_CONFIRMED");
      }

      const confirmedPositions = await deps.getPositions(SYMBOL);
      const confirmedPosition = confirmedPositions.find(
        (row) => String(row.ticket) === String(position.ticket),
      );
      if (!confirmedPosition) return blocked("BROKER_POSITION_MISSING_AFTER_PROTECTION");

      const managed = toManagedState(protectedState, confirmedPosition, input);
      deps.log?.("SEMI_MANUAL_POSITION_PROTECTED", protectedState.ownershipId);
      return {
        status: "ADOPTED",
        reason: "BROKER_CONFIRMED",
        managed,
        position: confirmedPosition,
        adoption: protectedState,
      };
    } catch (error) {
      return blocked(
        "SEMI_ADOPTION_RUNTIME_ERROR_FAIL_CLOSED",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      lock.release();
    }
  }

  async function markClosedIfAdopted(ticket, closedAt = deps.now()) {
    const state = await deps.adoptionRepository.findByTicket(String(ticket));
    if (!state) return { status: "SKIPPED", reason: "NOT_SEMI_ADOPTED" };
    await deps.adoptionRepository.markClosed(String(ticket), closedAt, "BROKER_POSITION_CLOSED");
    deps.log?.("SEMI_MANUAL_POSITION_CLOSED", String(ticket));
    return { status: "CLOSED", reason: "BROKER_POSITION_CLOSED" };
  }

  return { reconcile, markClosedIfAdopted };
}

let productionRuntimePromise = null;

async function buildProductionRuntime() {
  const baseUrl = (
    process.env.MT5_BRIDGE_BASE_URL?.trim() ||
    `http://${process.env.MT5_BRIDGE_HOST ?? "127.0.0.1"}:${process.env.MT5_BRIDGE_PORT ?? "8765"}`
  ).replace(/\/$/, "");
  const apiKey = (
    process.env.MT5_BRIDGE_API_KEY?.trim() ||
    process.env.MT5_API_KEY?.trim() ||
    ""
  );
  if (!apiKey) throw new Error("SEMI Trend adoption requires the canonical MT5 bridge API key.");

  const requestTimeoutMs = Math.max(
    1_000,
    Number(process.env.MT5_BRIDGE_REQUEST_TIMEOUT_MS ?? 8_000) || 8_000,
  );
  const config = {
    ...defaultMt5BrokerConfig,
    bridgeBaseUrl: baseUrl,
    apiKey,
    requestTimeoutMs,
    healthTimeoutMs: Math.min(requestTimeoutMs, 3_000),
    retryAttempts: 0,
    deviationPoints: Number(process.env.MT5_DEVIATION_POINTS ?? 50) || 50,
    requireTradingEnabled: true,
  };
  const transport = new HttpMt5Transport(config);
  const client = new Mt5BridgeClient(transport, config.healthTimeoutMs);
  const adapter = new Mt5ExecutionAdapter(client, config);
  const market = new Mt5MarketDataClient({
    baseUrl,
    apiKey,
    timeoutMs: requestTimeoutMs,
  });

  const [
    adoptionModule,
    repositoryModule,
    protectionModule,
    botModeModule,
  ] = await Promise.all([
    import("../apps/api/dist/services/phase7c-semi-manual-adoption.service.js"),
    import("../apps/api/dist/services/phase7c-semi-adoption-runtime.service.js"),
    import("../apps/api/dist/services/phase7c-semi-protection-executor.service.js"),
    import("../apps/api/dist/services/phase7c-bot-mode.service.js"),
  ]);

  const adoptionRepository = repositoryModule.getPhase7CSemiAdoptionStateRepository();
  const executeProtection = protectionModule.createPhase7CSemiProtectionExecutor({
    now: () => Date.now(),
    adoptionRepository,
    adapter,
  });

  return createPhase7CSemiTrendAdoptionRuntime({
    now: () => Date.now(),
    accountRuntime: resolvePhase7CAccountRuntime(process.env),
    armed: /^(1|true|yes|on)$/i.test(process.env.ZIQ_DEMO_ARMED ?? "false"),
    getBotMode: async () => botModeModule.phase7CBotModeService.get(),
    getHealth: async () => client.health(),
    getPositions: async (symbol = SYMBOL) => adapter.getOpenPositions(symbol),
    getDeals: async (fromMs, toMs, symbol = SYMBOL) => market.getDeals(fromMs, toMs, symbol),
    getQuote: async (symbol = SYMBOL) => client.quote(symbol),
    getSpec: async (symbol = SYMBOL) => client.symbolSpec(symbol),
    evaluateAdoption: adoptionModule.evaluateSemiManualAdoption,
    adoptionRepository,
    acquireExecutionLock,
    executeProtection,
    log: (event, detail) => console.log(`PHASE7C_TREND_${event}=${detail ?? ""}`),
  });
}

async function productionRuntime() {
  productionRuntimePromise ??= buildProductionRuntime();
  return productionRuntimePromise;
}

export async function reconcilePhase7CSemiManualPosition(input) {
  try {
    return await (await productionRuntime()).reconcile(input);
  } catch (error) {
    return blocked(
      "SEMI_RUNTIME_INITIALIZATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function markPhase7CSemiManualAdoptionClosed(ticket, closedAt = Date.now()) {
  try {
    return await (await productionRuntime()).markClosedIfAdopted(ticket, closedAt);
  } catch (error) {
    console.error(
      `PHASE7C_TREND_SEMI_CLOSE_TOMBSTONE_FAIL=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { status: "BLOCKED", reason: "SEMI_CLOSE_TOMBSTONE_FAILED" };
  }
}
