import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  Phase7CPerformanceManagementEvent,
  Phase7CPerformanceManagementEvidence,
  Phase7CPerformanceManagementFamily,
  Phase7CPerformanceStrategy,
} from "../contracts/phase7c-performance-effectiveness.schema";

type AccountMode = "DEMO" | "LIVE";
type RawEvent = Record<string, unknown>;

const POSITION_KEYS = new Set([
  "ticket",
  "positionid",
  "position_id",
  "positionticket",
  "position_ticket",
]);

const EVENT_FAMILIES = new Map<string, Phase7CPerformanceManagementFamily>([
  ["PLUS6_SL_TO_ENTRY", "BREAK_EVEN"],
  ["PLUS6_SL_ALREADY_AT_OR_TIGHTER", "BREAK_EVEN"],
  ["PLUS10_PARTIAL_ONE_THIRD", "PARTIAL_CLOSE"],
  ["FAST_MOVE_PROFIT_LOCK_TIGHTEN", "FAST_MOVE_TIGHTEN"],
  ["FAST_MOVE_PROFIT_LOCK_REJECTED", "FAST_MOVE_REJECTED"],
  ["FAST_MOVE_HANDOFF_M5_STRUCTURE", "FAST_MOVE_HANDOFF_M5_STRUCTURE"],
  ["M5_STRUCTURAL_SL_TIGHTEN", "M5_STRUCTURAL_TIGHTEN"],
  ["SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN", "M5_STRUCTURAL_TIGHTEN"],
  ["M5_STRUCTURAL_SL_REJECTED", "M5_STRUCTURAL_REJECTED"],
  ["SIDEWAY_M5_STRUCTURAL_SL_REJECTED", "M5_STRUCTURAL_REJECTED"],
]);

export interface Phase7CManagementEvidenceInput {
  runtimeRoot: string;
  accountMode: AccountMode;
  strategy: Phase7CPerformanceStrategy;
  positionId: string;
  openedAt: number;
  closedAt: number;
}

export interface Phase7CManagementEvidenceResult {
  evidence: Phase7CPerformanceManagementEvidence;
  events: Phase7CPerformanceManagementEvent[];
  source: {
    journalPath: string;
    available: boolean;
    parsedRows: number;
    malformedRows: number;
  };
  warnings: string[];
}

function journalRelativePath(accountMode: AccountMode, strategy: Phase7CPerformanceStrategy): string {
  if (strategy === "TREND" || strategy === "REVERSAL") {
    const directory = accountMode === "LIVE" ? "phase7b-live-forward" : "phase7b-demo-forward";
    return path.join(directory, "phase7b-demo-events.jsonl");
  }
  const directory = accountMode === "LIVE" ? "phase7c-sideway-live-forward" : "phase7c-sideway-forward";
  return path.join(directory, "phase7c-sideway-events.jsonl");
}

function normalizeScalar(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return null;
}

function visitObject(value: unknown, visitor: (key: string, nested: unknown) => void, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    visitor(key, nested);
    visitObject(nested, visitor, depth + 1);
  }
}

function explicitPositionIds(raw: RawEvent): string[] {
  const values = new Set<string>();
  visitObject(raw, (key, value) => {
    if (!POSITION_KEYS.has(key.toLowerCase())) return;
    const scalar = normalizeScalar(value);
    if (scalar && scalar !== "0") values.add(scalar);
  });
  return [...values];
}

function eventName(raw: RawEvent): string | null {
  const value = normalizeScalar(raw.event) ?? normalizeScalar(raw.type);
  return value ? value.toUpperCase() : null;
}

function eventTimestamp(raw: RawEvent): number | null {
  const value = raw.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventPrice(raw: RawEvent): number | null {
  for (const key of ["peakPrice", "structurePrice", "marketPrice", "fillPrice", "price"]) {
    const value = finiteNumber(raw[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeEvent(
  raw: RawEvent,
  strategy: Phase7CPerformanceStrategy,
  relativeJournalPath: string,
  index: number,
  timestamp: number,
): Phase7CPerformanceManagementEvent | null {
  const name = eventName(raw);
  if (!name) return null;
  const family = EVENT_FAMILIES.get(name);
  if (!family) return null;
  return {
    family,
    timestamp,
    stopLoss: finiteNumber(raw.stopLoss),
    price: eventPrice(raw),
    favorablePrice: finiteNumber(raw.favorable),
    closedVolume: finiteNumber(raw.closedVolume),
    remainingVolume: finiteNumber(raw.remainingVolume),
    source: relativeJournalPath.split(path.sep).join("/"),
    eventId: `${strategy}:${relativeJournalPath.split(path.sep).join("/")}:${index}:${name}`,
  };
}

export function getPhase7CManagementEvidence(
  input: Phase7CManagementEvidenceInput,
): Phase7CManagementEvidenceResult {
  const relativeJournalPath = journalRelativePath(input.accountMode, input.strategy);
  const absoluteJournalPath = path.resolve(input.runtimeRoot, relativeJournalPath);
  const normalizedRelativePath = relativeJournalPath.split(path.sep).join("/");
  const base: Phase7CManagementEvidenceResult = {
    evidence: "UNMATCHED",
    events: [],
    source: {
      journalPath: normalizedRelativePath,
      available: existsSync(absoluteJournalPath),
      parsedRows: 0,
      malformedRows: 0,
    },
    warnings: [],
  };
  if (!base.source.available) return base;

  const requestedPositionId = String(input.positionId).trim();
  const openedAt = Number(input.openedAt);
  const closedAt = Number(input.closedAt);
  if (!requestedPositionId || !Number.isFinite(openedAt) || !Number.isFinite(closedAt) || closedAt < openedAt) {
    return {
      ...base,
      evidence: "AMBIGUOUS",
      warnings: ["INVALID_MANAGEMENT_EVIDENCE_WINDOW_OR_POSITION_ID"],
    };
  }

  const lines = readFileSync(absoluteJournalPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const matchedEvents: Phase7CPerformanceManagementEvent[] = [];
  let conflictingTargetIdentity = false;

  lines.forEach((line, index) => {
    let raw: RawEvent;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        base.source.malformedRows += 1;
        return;
      }
      raw = parsed as RawEvent;
      base.source.parsedRows += 1;
    } catch {
      base.source.malformedRows += 1;
      return;
    }

    const timestamp = eventTimestamp(raw);
    if (timestamp === null || timestamp < openedAt || timestamp > closedAt) return;

    const identities = explicitPositionIds(raw);
    if (identities.length > 1) {
      if (identities.includes(requestedPositionId)) conflictingTargetIdentity = true;
      return;
    }
    if (identities.length !== 1 || identities[0] !== requestedPositionId) return;

    const normalized = normalizeEvent(raw, input.strategy, relativeJournalPath, index, timestamp);
    if (normalized) matchedEvents.push(normalized);
  });

  if (conflictingTargetIdentity) {
    return {
      ...base,
      evidence: "AMBIGUOUS",
      events: [],
      warnings: ["CONFLICTING_EXPLICIT_POSITION_IDENTITIES"],
    };
  }

  matchedEvents.sort((left, right) => left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId));
  return {
    ...base,
    evidence: matchedEvents.length > 0 ? "EXACT" : "UNMATCHED",
    events: matchedEvents,
  };
}
