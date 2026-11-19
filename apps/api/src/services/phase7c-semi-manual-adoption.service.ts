import type { BotMode } from "@xauusd/strategy-engine";

export type SemiManualAdoptionStatus =
  | "REJECTED"
  | "PENDING"
  | "PROTECTION_BLOCKED";

export type SemiManualAdoptionReason =
  | "MODE_NOT_SEMI"
  | "INVALID_ACTIVATION_EPOCH"
  | "SYMBOL_NOT_ELIGIBLE"
  | "POSITION_NOT_AFTER_ACTIVATION"
  | "OPENING_DEAL_REQUIRED"
  | "OPENING_DEAL_POSITION_MISMATCH"
  | "OPENING_DEAL_NOT_AFTER_ACTIVATION"
  | "OPENING_DEAL_IDENTITY_MISMATCH"
  | "SYSTEM_OWNED_POSITION"
  | "MANUAL_PROVENANCE_NOT_PROVEN"
  | "BROKER_SPEC_INVALID"
  | "POSITION_ENTRY_INVALID"
  | "QUOTE_INVALID"
  | "FIXED_TP_INVALID"
  | "INITIAL_SL_INSIDE_BROKER_PROTECTION_DISTANCE"
  | "FIXED_TP_INSIDE_BROKER_PROTECTION_DISTANCE"
  | "PROTECTION_REQUIRED";

export interface SemiManualPositionSnapshot {
  ticket: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  openedAt?: number;
}

export interface SemiManualOpeningDealSnapshot {
  ticket: string;
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  entry: "IN" | "OUT" | "INOUT" | "OUT_BY" | "UNKNOWN";
  magic: number;
  comment: string;
  timestamp: number;
}

export interface SemiManualBrokerQuote {
  bid: number;
  ask: number;
}

export interface SemiManualBrokerSpec {
  tickSize: number;
  stopsLevelTicks: number;
  freezeLevelTicks: number;
}

export interface SemiManualFixedTakeProfit {
  enabled: boolean;
  price: number | null;
}

export interface SemiManualAdoptionInput {
  mode: BotMode;
  activationEpochMs: number;
  symbol: string;
  systemMagicNumber: number;
  position: SemiManualPositionSnapshot;
  openingDeal: SemiManualOpeningDealSnapshot | null;
  quote: SemiManualBrokerQuote;
  spec: SemiManualBrokerSpec;
  fixedTakeProfit: SemiManualFixedTakeProfit;
}

export interface SemiManualAdoptionEvaluation {
  status: SemiManualAdoptionStatus;
  reason: SemiManualAdoptionReason;
  targetStopLoss: number | null;
  targetTakeProfit: number | null;
}

const INITIAL_STOP_DISTANCE_PRICE = 6.0;
const SYSTEM_COMMENT_PREFIX = "xau:";

function result(
  status: SemiManualAdoptionStatus,
  reason: SemiManualAdoptionReason,
  targetStopLoss: number | null = null,
  targetTakeProfit: number | null = null,
): SemiManualAdoptionEvaluation {
  return { status, reason, targetStopLoss, targetTakeProfit };
}

function normalizeToTick(value: number, tickSize: number): number {
  const normalized = Math.round(value / tickSize) * tickSize;
  return Number(normalized.toFixed(10));
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isSystemComment(comment: string): boolean {
  return comment.trim().toLowerCase().startsWith(SYSTEM_COMMENT_PREFIX);
}

function approximatelyEqual(left: number, right: number, tickSize: number): boolean {
  const epsilon = Math.max(1e-9, tickSize * 1e-8);
  return Math.abs(left - right) <= epsilon;
}

export function evaluateSemiManualAdoption(
  input: SemiManualAdoptionInput,
): SemiManualAdoptionEvaluation {
  if (input.mode !== "SEMI") {
    return result("REJECTED", "MODE_NOT_SEMI");
  }

  if (!Number.isFinite(input.activationEpochMs) || input.activationEpochMs <= 0) {
    return result("REJECTED", "INVALID_ACTIVATION_EPOCH");
  }

  if (
    input.symbol.trim().toUpperCase() !== "XAUUSD" ||
    input.position.symbol.trim().toUpperCase() !== "XAUUSD"
  ) {
    return result("REJECTED", "SYMBOL_NOT_ELIGIBLE");
  }

  if (
    !Number.isFinite(input.position.openedAt) ||
    Number(input.position.openedAt) <= input.activationEpochMs
  ) {
    return result("REJECTED", "POSITION_NOT_AFTER_ACTIVATION");
  }

  const openingDeal = input.openingDeal;
  if (!openingDeal) {
    return result("REJECTED", "OPENING_DEAL_REQUIRED");
  }

  if (openingDeal.positionId !== input.position.ticket) {
    return result("REJECTED", "OPENING_DEAL_POSITION_MISMATCH");
  }

  if (!Number.isFinite(openingDeal.timestamp) || openingDeal.timestamp <= input.activationEpochMs) {
    return result("REJECTED", "OPENING_DEAL_NOT_AFTER_ACTIVATION");
  }

  const expectedDealSide = input.position.side === "LONG" ? "BUY" : "SELL";
  if (
    openingDeal.symbol.trim().toUpperCase() !== "XAUUSD" ||
    openingDeal.entry !== "IN" ||
    openingDeal.side !== expectedDealSide
  ) {
    return result("REJECTED", "OPENING_DEAL_IDENTITY_MISMATCH");
  }

  if (
    openingDeal.magic === input.systemMagicNumber ||
    isSystemComment(openingDeal.comment)
  ) {
    return result("REJECTED", "SYSTEM_OWNED_POSITION");
  }

  // Strong SEMI manual provenance is deliberately narrow: MT5 GUI/manual deals
  // carry magic=0 and must not carry the system's deterministic xau: comment.
  // Any foreign/non-zero magic is fail-closed rather than guessed to be manual.
  if (openingDeal.magic !== 0) {
    return result("REJECTED", "MANUAL_PROVENANCE_NOT_PROVEN");
  }

  const tickSize = input.spec.tickSize;
  const stopsLevelTicks = input.spec.stopsLevelTicks;
  const freezeLevelTicks = input.spec.freezeLevelTicks;
  if (
    !finitePositive(tickSize) ||
    !Number.isFinite(stopsLevelTicks) ||
    stopsLevelTicks < 0 ||
    !Number.isFinite(freezeLevelTicks) ||
    freezeLevelTicks < 0
  ) {
    return result("PROTECTION_BLOCKED", "BROKER_SPEC_INVALID");
  }

  if (!finitePositive(input.position.entry)) {
    return result("PROTECTION_BLOCKED", "POSITION_ENTRY_INVALID");
  }

  if (
    !finitePositive(input.quote.bid) ||
    !finitePositive(input.quote.ask) ||
    input.quote.ask < input.quote.bid
  ) {
    return result("PROTECTION_BLOCKED", "QUOTE_INVALID");
  }

  const rawCanonicalStopLoss = input.position.side === "LONG"
    ? input.position.entry - INITIAL_STOP_DISTANCE_PRICE
    : input.position.entry + INITIAL_STOP_DISTANCE_PRICE;
  const canonicalStopLoss = normalizeToTick(rawCanonicalStopLoss, tickSize);

  const currentStopLoss = finitePositive(input.position.stopLoss)
    ? normalizeToTick(input.position.stopLoss, tickSize)
    : null;
  const currentStopIsEqualOrTighter = currentStopLoss !== null && (
    input.position.side === "LONG"
      ? currentStopLoss >= canonicalStopLoss
      : currentStopLoss <= canonicalStopLoss
  );
  const targetStopLoss = currentStopIsEqualOrTighter
    ? currentStopLoss!
    : canonicalStopLoss;
  const stopMutationRequired = currentStopLoss === null ||
    !approximatelyEqual(currentStopLoss, targetStopLoss, tickSize);

  let targetTakeProfit: number | null = null;
  let takeProfitMutationRequired = false;
  if (input.fixedTakeProfit.enabled) {
    const fixedPrice = input.fixedTakeProfit.price;
    if (!finitePositive(Number(fixedPrice))) {
      return result("PROTECTION_BLOCKED", "FIXED_TP_INVALID", targetStopLoss);
    }
    targetTakeProfit = normalizeToTick(Number(fixedPrice), tickSize);
    const currentTakeProfit = finitePositive(input.position.takeProfit)
      ? normalizeToTick(input.position.takeProfit, tickSize)
      : null;
    takeProfitMutationRequired = currentTakeProfit === null ||
      !approximatelyEqual(currentTakeProfit, targetTakeProfit, tickSize);
  }

  const minimumProtectionDistance = Math.max(stopsLevelTicks, freezeLevelTicks) * tickSize;
  const epsilon = Math.max(1e-9, tickSize * 1e-8);

  if (stopMutationRequired) {
    const stopDistance = input.position.side === "LONG"
      ? input.quote.bid - targetStopLoss
      : targetStopLoss - input.quote.ask;

    if (stopDistance + epsilon < minimumProtectionDistance) {
      return result(
        "PROTECTION_BLOCKED",
        "INITIAL_SL_INSIDE_BROKER_PROTECTION_DISTANCE",
        targetStopLoss,
        targetTakeProfit,
      );
    }
  }

  if (targetTakeProfit !== null && takeProfitMutationRequired) {
    const takeProfitDistance = input.position.side === "LONG"
      ? targetTakeProfit - input.quote.ask
      : input.quote.bid - targetTakeProfit;
    if (takeProfitDistance + epsilon < minimumProtectionDistance) {
      return result(
        "PROTECTION_BLOCKED",
        "FIXED_TP_INSIDE_BROKER_PROTECTION_DISTANCE",
        targetStopLoss,
        targetTakeProfit,
      );
    }
  }

  return result(
    "PENDING",
    "PROTECTION_REQUIRED",
    targetStopLoss,
    targetTakeProfit,
  );
}
