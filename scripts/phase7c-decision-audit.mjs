import { canonicalHoldReason } from "./phase7c-hold-observability.mjs";
import fs from "node:fs";
import path from "node:path";

const STAGE_BY_EVENT = new Map([
  ["ENTRY_SUBMIT", "SUBMITTED"],
  ["ENTRY_FINAL_PERMISSION_GRANTED", "READY"],
  ["ENTRY_SHADOW_READY", "READY"],
  ["ENTRY_PENDING_DURABLE", "SUBMITTED"],
  ["ENTRY_FILLED", "FILLED"],
  ["PENDING_ENTRY_RECOVERED", "FILLED"],
  ["WAIT_PULLBACK", "WAITING"],
  ["PULLBACK_STILL_TOO_WIDE", "WAITING"],
  ["PULLBACK_ENTRY", "READY"],
  ["MANAGED_POSITION_CLOSED", "CLOSED"],
  ["POSITION_CLOSED", "CLOSED"],
  ["EXIT_EXECUTED", "CLOSED"],
  ["CYCLE_ERROR", "ERROR"],
]);

const BLOCK_EVENT_PATTERN = /(?:BLOCK|INVALID|EXPIRED|REJECTED|MISMATCH|UNMANAGED|UNEXPECTED|NOT_FEASIBLE|ERROR)$/;

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number !== null) return number;
  }
  return null;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 1_000) : null;
}

function eventTimestamp(payload) {
  const raw = payload?.timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = finite(raw);
  return numeric !== null && numeric > 0 ? numeric : Date.now();
}

function eventStage(event) {
  if (STAGE_BY_EVENT.has(event)) return STAGE_BY_EVENT.get(event);
  if (BLOCK_EVENT_PATTERN.test(event)) return "BLOCKED";
  if (/^(?:HOLD_POSITION|PLUS6|PLUS10|STRUCTURAL|MANAGEMENT|FVG_HOLD)/.test(event)) return "MANAGING";
  if (/^(?:M15_NO_ENTRY_SIGNAL|ENTRY_MODE_BLOCK|ENTRY_REGIME_BLOCK|ENTRY_LOCATION_BLOCK)/.test(event)) return "WAITING";
  return "OBSERVED";
}

function deriveReason(event, payload) {
  const candidates = [
    payload?.reason,
    payload?.message,
    payload?.note,
    payload?.validation?.reason,
    payload?.plan?.reason,
    payload?.finalPermission?.reason,
    payload?.recoveryReason,
  ];
  const detail = candidates.map(cleanText).find(Boolean);
  return detail ? `${event}: ${detail}` : event;
}

function normalizeRecord(strategy, symbol, configuration, event, payload) {
  const timestamp = eventTimestamp(payload);
  const plan = payload?.plan ?? payload?.executionPlan ?? {};
  const preview = payload?.preview ?? payload?.autoLotPreview ?? {};
  const position = payload?.position ?? {};
  const management = payload?.management ?? payload?.lastKnownState ?? {};
  const side = cleanText(payload?.side ?? management?.side ?? position?.side);
  const entry = firstFinite(
    plan?.entry,
    payload?.marketEntry,
    payload?.signalEntry,
    position?.entry,
    management?.entry,
  );
  const stopLoss = firstFinite(
    plan?.stopLoss,
    payload?.stopLoss,
    position?.stopLoss,
    management?.stopLoss,
    management?.lastStructuralStop,
  );
  const stopDistance = firstFinite(
    plan?.stopDistance,
    payload?.stopDistance,
    payload?.structuralStopDistance,
    management?.stopDistance,
  );
  const finalLot = firstFinite(
    payload?.volume,
    payload?.finalLot,
    position?.volume,
    management?.initialVolume,
  );
  const configuredLot = strategy === "TREND"
    ? firstFinite(payload?.configuredLot, configuration?.fixedLot, finalLot)
    : null;
  const maxLot = strategy === "SIDEWAY"
    ? firstFinite(payload?.maxLot, configuration?.maxLot)
    : configuredLot;
  const riskPercent = firstFinite(
    payload?.riskPercent,
    preview?.riskPercent,
    configuration?.riskPercent,
  );

  const canonicalHold =
    canonicalHoldReason(
      strategy,
      payload,
    );

  const canonicalHoldEvent =
    event === "HOLD_POSITION" ||
    event === "FVG_HOLD_CONFIRMED";

  return {
    schemaVersion: 1,
    timestamp,
    timestampIso: new Date(timestamp).toISOString(),
    strategy,
    symbol,
    event,
    stage: eventStage(event),
    reasonCode:
      canonicalHoldEvent && canonicalHold
        ? canonicalHold.reasonCode
        : event,

    reason:
      canonicalHoldEvent && canonicalHold
        ? canonicalHold.reason
        : deriveReason(event, payload),
    entryConditions:
      payload?.entryConditions && typeof payload.entryConditions === "object"
        ? payload.entryConditions
        : null,
    setup: {
      side,
      pattern: cleanText(payload?.pattern ?? payload?.confirmation),
      entryState: cleanText(payload?.entryState),
      activeMode: cleanText(payload?.activeMode ?? payload?.finalPermission?.activeMode),
      recommendedMode: cleanText(payload?.recommendedMode ?? payload?.finalPermission?.recommendedMode),
      regime: cleanText(payload?.regime),
      confidence: firstFinite(payload?.regimeConfidence, payload?.confidence),
    },
    sizing: {
      configuredLot,
      rawLot: firstFinite(payload?.rawLot, preview?.rawLot),
      finalLot,
      maxLot,
      riskPercent,
      estimatedRiskUsd: firstFinite(payload?.estimatedRiskUsd, preview?.estimatedRiskUsd),
      estimatedRiskPercent: firstFinite(payload?.estimatedRiskPercent, preview?.estimatedRiskPercent),
      limitReason: cleanText(payload?.lotLimitReason ?? preview?.reason ?? payload?.validation?.reason),
    },
    plan: {
      entry,
      stopLoss,
      stopDistance,
      breakEvenPrice: firstFinite(payload?.breakEvenPrice, entry),
      breakEvenTriggerDistance: 6,
      partialTriggerDistance: 10,
      partialFraction: "1/3",
      tp1: firstFinite(plan?.tp1, payload?.tp1),
      tp2: firstFinite(plan?.takeProfit, plan?.tp2, payload?.tp2, payload?.recoveryTakeProfit),
      dailyMode: cleanText(payload?.dailyMode ?? management?.dailyMode),
    },
    management: {
      ticket: cleanText(payload?.ticket ?? position?.ticket ?? management?.ticket),
      breakEvenApplied: Boolean(payload?.breakEvenApplied ?? management?.breakEvenApplied),
      partialApplied: Boolean(payload?.partialApplied ?? management?.partialApplied),
    },
    configuration: {
      fixedLot: firstFinite(configuration?.fixedLot),
      riskPercent: firstFinite(configuration?.riskPercent),
      maxLot: firstFinite(configuration?.maxLot),
    },
    source: `${strategy}_EXECUTOR_CANONICAL_JOURNAL`,
    raw: payload,
  };
}

export function createPhase7CDecisionAudit({
  strategy,
  symbol = "XAUUSD",
  configuration = {},
  directory = process.env.ZIQ_PHASE7C_DECISION_DIR,
}) {
  const normalizedStrategy = String(strategy ?? "").trim().toUpperCase();
  if (!new Set(["TREND", "SIDEWAY"]).has(normalizedStrategy)) {
    throw new Error(`Unsupported Phase 7C decision audit strategy: ${strategy}`);
  }
  const root = path.resolve(
    directory?.trim() || path.join(".runtime", "phase7c-executors", "decision-observability"),
  );
  const slug = normalizedStrategy.toLowerCase();
  const journalPath = path.join(root, `${slug}-decisions.jsonl`);
  const latestPath = path.join(root, `${slug}-latest.json`);

  return {
    root,
    journalPath,
    latestPath,
    record(event, payload = {}) {
      const normalizedEvent = String(event ?? "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
      const record = normalizeRecord(
        normalizedStrategy,
        String(symbol).trim().toUpperCase() || "XAUUSD",
        configuration,
        normalizedEvent,
        payload,
      );
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");
      const temporary = `${latestPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, latestPath);
      return record;
    },
  };
}

export const __test = {
  eventStage,
  normalizeRecord,
};
