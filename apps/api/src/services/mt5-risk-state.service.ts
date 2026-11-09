import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface Mt5EquitySample {
  timestamp: number;
  balance: number;
  equity: number;
}

interface PersistedRiskState {
  version: 1;
  peakObservedEquity: number;
  samples: Mt5EquitySample[];
  updatedAt: number;
}

export interface Mt5RiskStateSnapshot {
  peakObservedEquity: number;
  samples: Mt5EquitySample[];
}

let queue: Promise<unknown> = Promise.resolve();

function getStatePath(): string {
  const configured = process.env.MT5_RISK_STATE_PATH?.trim();
  return configured || resolve(process.cwd(), "data", "mt5-risk-state.json");
}

function emptyState(equity: number, now: number): PersistedRiskState {
  return {
    version: 1,
    peakObservedEquity: equity,
    samples: [],
    updatedAt: now,
  };
}

async function readState(
  equity: number,
  now: number,
): Promise<PersistedRiskState> {
  const path = getStatePath();

  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<PersistedRiskState>;

    if (
      parsed.version !== 1 ||
      typeof parsed.peakObservedEquity !== "number" ||
      !Number.isFinite(parsed.peakObservedEquity) ||
      !Array.isArray(parsed.samples)
    ) {
      return emptyState(equity, now);
    }

    const samples = parsed.samples
      .filter(
        (sample): sample is Mt5EquitySample =>
          typeof sample === "object" &&
          sample !== null &&
          typeof sample.timestamp === "number" &&
          Number.isFinite(sample.timestamp) &&
          typeof sample.balance === "number" &&
          Number.isFinite(sample.balance) &&
          typeof sample.equity === "number" &&
          Number.isFinite(sample.equity),
      )
      .slice(-1_000);

    return {
      version: 1,
      peakObservedEquity: Math.max(
        parsed.peakObservedEquity,
        equity,
      ),
      samples,
      updatedAt:
        typeof parsed.updatedAt === "number"
          ? parsed.updatedAt
          : now,
    };
  } catch {
    return emptyState(equity, now);
  }
}

async function updateImpl(
  balance: number,
  equity: number,
  now: number,
): Promise<Mt5RiskStateSnapshot> {
  if (
    !Number.isFinite(balance) ||
    !Number.isFinite(equity) ||
    balance <= 0 ||
    equity <= 0
  ) {
    throw new Error("Invalid MT5 equity sample.");
  }

  const state = await readState(equity, now);
  const samples = [...state.samples];
  const last = samples.at(-1);

  if (last && now - last.timestamp < 60_000) {
    samples[samples.length - 1] = {
      timestamp: now,
      balance,
      equity,
    };
  } else {
    samples.push({
      timestamp: now,
      balance,
      equity,
    });
  }

  const next: PersistedRiskState = {
    version: 1,
    peakObservedEquity: Math.max(
      state.peakObservedEquity,
      equity,
    ),
    samples: samples.slice(-1_000),
    updatedAt: now,
  };

  const path = getStatePath();
  const temp = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
  await rename(temp, path);

  return {
    peakObservedEquity: next.peakObservedEquity,
    samples: next.samples,
  };
}

export function updateMt5RiskState(
  balance: number,
  equity: number,
  now: number,
): Promise<Mt5RiskStateSnapshot> {
  const run = queue.then(() => updateImpl(balance, equity, now));
  queue = run.catch(() => undefined);
  return run;
}
