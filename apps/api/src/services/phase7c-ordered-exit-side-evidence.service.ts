import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type AccountMode = "DEMO" | "LIVE";
type Strategy = "TREND" | "SIDEWAY";
type Side = "BUY" | "SELL";
type RawRecord = Record<string, unknown>;

export interface Phase7CObservedExitSidePrice {
  timestamp: number;
  price: number;
  sequence: number;
}

export interface Phase7COrderedExitSideEvidenceInput {
  runtimeRoot: string;
  accountMode: AccountMode;
  strategy: Strategy;
  positionId: string;
  side: Side;
  openedAt: number;
  closedAt: number;
  boundaryToleranceMs?: number;
}

export interface Phase7COrderedExitSideEvidenceResult {
  verdict: "COMPLETE_OBSERVED_WINDOW" | "UNAVAILABLE";
  complete: boolean;
  prices: Phase7CObservedExitSidePrice[];
  source: {
    journalPath: string;
    available: boolean;
    parsedRows: number;
    malformedRows: number;
    matchedRows: number;
  };
  warnings: string[];
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function scalar(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return null;
}

function recordObject(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RawRecord
    : null;
}

function timestampOf(record: RawRecord): number | null {
  const raw = record.timestamp;
  const numeric = finiteNumber(raw);
  if (numeric !== null && numeric > 0) return numeric;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function eventOf(record: RawRecord): string {
  return String(record.event ?? record.type ?? "").trim().toUpperCase();
}

function ticketOf(record: RawRecord): string | null {
  const management = recordObject(record.management);
  const raw = recordObject(record.raw);
  return scalar(record.ticket) ?? scalar(management?.ticket) ?? scalar(raw?.ticket);
}

function sideOf(record: RawRecord): Side | null {
  const setup = recordObject(record.setup);
  const raw = recordObject(record.raw);
  const value = String(record.side ?? setup?.side ?? raw?.side ?? "").trim().toUpperCase();
  return value === "BUY" || value === "SELL" ? value : null;
}

function priceOf(record: RawRecord): number | null {
  const raw = recordObject(record.raw);
  const value = finiteNumber(raw?.exitSidePrice ?? record.exitSidePrice);
  return value !== null && value > 0 ? value : null;
}

function evidenceVersionOf(record: RawRecord): number | null {
  const raw = recordObject(record.raw);
  return finiteNumber(raw?.evidenceVersion ?? record.evidenceVersion);
}

function relativeJournalCandidates(
  accountMode: AccountMode,
  strategy: Strategy,
): string[] {
  const fileName = strategy === "TREND"
    ? "trend-exit-side-samples.jsonl"
    : "sideway-exit-side-samples.jsonl";
  const base = path.join("phase7c-executors", "decision-observability");
  const accountAware = path.join(base, accountMode.toLowerCase(), fileName);
  if (accountMode === "LIVE") return [accountAware];
  return [accountAware, path.join(base, fileName)];
}

function resolveJournal(
  runtimeRoot: string,
  accountMode: AccountMode,
  strategy: Strategy,
): { absolutePath: string; relativePath: string; available: boolean } {
  const candidates = relativeJournalCandidates(accountMode, strategy);
  for (const relativePath of candidates) {
    const absolutePath = path.resolve(runtimeRoot, relativePath);
    if (existsSync(absolutePath)) {
      return {
        absolutePath,
        relativePath: relativePath.split(path.sep).join("/"),
        available: true,
      };
    }
  }
  const relativePath = candidates[0]!;
  return {
    absolutePath: path.resolve(runtimeRoot, relativePath),
    relativePath: relativePath.split(path.sep).join("/"),
    available: false,
  };
}

function unavailable(
  source: Phase7COrderedExitSideEvidenceResult["source"],
  warnings: string[],
  prices: Phase7CObservedExitSidePrice[] = [],
): Phase7COrderedExitSideEvidenceResult {
  return {
    verdict: "UNAVAILABLE",
    complete: false,
    prices,
    source,
    warnings: [...new Set(warnings)],
  };
}

export function getPhase7COrderedExitSideEvidence(
  input: Phase7COrderedExitSideEvidenceInput,
): Phase7COrderedExitSideEvidenceResult {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const positionId = String(input.positionId ?? "").trim();
  const openedAt = Number(input.openedAt);
  const closedAt = Number(input.closedAt);
  const boundaryToleranceMs = Math.max(
    0,
    Math.trunc(Number(input.boundaryToleranceMs ?? 15_000)),
  );
  const journal = resolveJournal(runtimeRoot, input.accountMode, input.strategy);
  const source = {
    journalPath: journal.relativePath,
    available: journal.available,
    parsedRows: 0,
    malformedRows: 0,
    matchedRows: 0,
  };

  if (!journal.available) {
    return unavailable(source, ["JOURNAL_UNAVAILABLE"]);
  }
  if (
    !positionId ||
    !Number.isFinite(openedAt) ||
    !Number.isFinite(closedAt) ||
    closedAt <= openedAt
  ) {
    return unavailable(source, ["INVALID_WINDOW_OR_POSITION"]);
  }

  const lowerBound = openedAt - boundaryToleranceMs;
  const upperBound = closedAt + boundaryToleranceMs;
  const rawSamples: Array<{ timestamp: number; price: number }> = [];
  const warnings: string[] = [];

  for (const line of readFileSync(journal.absolutePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: RawRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        source.malformedRows += 1;
        continue;
      }
      record = parsed as RawRecord;
      source.parsedRows += 1;
    } catch {
      source.malformedRows += 1;
      continue;
    }

    if (eventOf(record) !== "MANAGEMENT_EXIT_SIDE_SAMPLE") continue;
    if (ticketOf(record) !== positionId) continue;

    const timestamp = timestampOf(record);
    if (timestamp === null || timestamp < lowerBound || timestamp > upperBound) continue;

    const sampleSide = sideOf(record);
    if (sampleSide !== input.side) {
      warnings.push("SIDE_MISMATCH");
      continue;
    }

    const version = evidenceVersionOf(record);
    const price = priceOf(record);
    if (version !== 1 || price === null) {
      warnings.push("INVALID_SAMPLE");
      continue;
    }
    rawSamples.push({ timestamp, price });
  }

  if (source.malformedRows > 0) {
    warnings.push("JOURNAL_MALFORMED_ROWS");
  }
  if (rawSamples.length === 0) {
    warnings.push("NO_MATCHED_SAMPLES");
    return unavailable(source, warnings);
  }

  rawSamples.sort((left, right) => left.timestamp - right.timestamp);
  const deduped: Array<{ timestamp: number; price: number }> = [];
  for (const sample of rawSamples) {
    const previous = deduped.at(-1);
    if (!previous || previous.timestamp !== sample.timestamp) {
      deduped.push(sample);
      continue;
    }
    if (Math.abs(previous.price - sample.price) > 1e-9) {
      warnings.push("DUPLICATE_TIMESTAMP_CONFLICT");
    }
  }

  source.matchedRows = deduped.length;
  const prices = deduped.map((sample, sequence) => ({
    timestamp: sample.timestamp,
    price: sample.price,
    sequence,
  }));

  if (prices.length < 2) warnings.push("INSUFFICIENT_SAMPLE_COUNT");
  const first = prices[0];
  const last = prices.at(-1);
  if (!first || Math.abs(first.timestamp - openedAt) > boundaryToleranceMs) {
    warnings.push("OPEN_BOUNDARY_NOT_BRACKETED");
  }
  if (!last || Math.abs(last.timestamp - closedAt) > boundaryToleranceMs) {
    warnings.push("CLOSE_BOUNDARY_NOT_BRACKETED");
  }

  if (warnings.length > 0) {
    return unavailable(source, warnings, prices);
  }

  return {
    verdict: "COMPLETE_OBSERVED_WINDOW",
    complete: true,
    prices,
    source,
    warnings: [],
  };
}
