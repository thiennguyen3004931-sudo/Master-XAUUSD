import {
  CanonicalDealLedger,
  type CanonicalDealLedgerStore,
  type CanonicalDealRecord,
} from "@xauusd/mt5-broker";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
  type Phase7CAccountModeState,
} from "./phase7c-account-mode.service";
import { getMt5DealHistory } from "./mt5-market.service";
import {
  getMt5Telemetry,
  type Mt5TelemetrySnapshot,
} from "./mt5.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_BACKFILL_DAYS = 365;

type DealHistoryReader = typeof getMt5DealHistory;

export interface Phase7CCanonicalDealWindow {
  telemetry: Pick<Mt5TelemetrySnapshot, "accountLogin" | "health">;
  symbol: string;
  fromMs: number;
  toMs: number;
}

export interface Phase7CCanonicalDealSummaryInput extends Phase7CCanonicalDealWindow {
  ownedMagics: Iterable<number>;
}

export interface Phase7CCanonicalPositionRealizedInput extends Phase7CCanonicalDealWindow {
  positionId: string;
  ownedMagics: Iterable<number>;
}

export interface Phase7CCanonicalStartupBackfillDependencies {
  telemetryReader?: (symbol?: string) => Promise<Mt5TelemetrySnapshot>;
  accountModeReader?: () => Phase7CAccountModeState;
  historyReader?: DealHistoryReader;
}

export interface Phase7CCanonicalStartupBackfillResult {
  status: "BACKFILLED" | "SKIPPED";
  reason:
    | "OK"
    | "MT5_UNAVAILABLE"
    | "ACCOUNT_MODE_MISMATCH"
    | "BROKER_TIME_UNAVAILABLE";
  accountKey: string | null;
  inserted: number;
  total: number;
  fromMs: number | null;
  toMs: number | null;
}

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return resolve(demoDir, "..");
  return resolve(process.cwd(), ".runtime");
}

export function phase7CCanonicalDealLedgerStatePath(): string {
  return resolve(runtimeRoot(), "phase7c-canonical-deal-ledger.json");
}

function fileStore(filePath: string): CanonicalDealLedgerStore {
  return {
    load() {
      return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
    },
    save(serializedState) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporaryPath, serializedState, "utf8");
      renameSync(temporaryPath, filePath);
    },
  };
}

let cachedLedger:
  | {
      path: string;
      ledger: CanonicalDealLedger;
    }
  | undefined;

function ledger(): CanonicalDealLedger {
  const filePath = phase7CCanonicalDealLedgerStatePath();
  if (!cachedLedger || cachedLedger.path !== filePath) {
    cachedLedger = {
      path: filePath,
      ledger: new CanonicalDealLedger({ store: fileStore(filePath) }),
    };
  }
  return cachedLedger.ledger;
}

export function phase7CCanonicalAccountKey(
  telemetry: Pick<Mt5TelemetrySnapshot, "accountLogin" | "health">,
): string {
  const accountLogin = Number(telemetry.accountLogin);
  const accountMode = String(telemetry.health?.accountMode ?? "").trim().toLowerCase();
  const server = String(telemetry.health?.server ?? "").trim();

  if (!Number.isInteger(accountLogin) || accountLogin <= 0) {
    throw new Error("Canonical deal ledger requires MT5 accountLogin.");
  }
  if (accountMode !== "demo" && accountMode !== "real") {
    throw new Error(`Canonical deal ledger requires DEMO/real account mode. Actual=${accountMode || "missing"}`);
  }
  if (!server) {
    throw new Error("Canonical deal ledger requires MT5 server identity.");
  }

  return `${accountMode.toUpperCase()}:${server}:${accountLogin}`;
}

function validateWindow(input: Phase7CCanonicalDealWindow): {
  symbol: string;
  fromMs: number;
  toMs: number;
} {
  const symbol = input.symbol.trim().toUpperCase();
  const fromMs = Number(input.fromMs);
  const toMs = Number(input.toMs);

  if (!symbol) throw new Error("Canonical deal ledger symbol is required.");
  if (!Number.isFinite(fromMs) || fromMs < 0) {
    throw new Error("Canonical deal ledger fromMs is invalid.");
  }
  if (!Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("Canonical deal ledger toMs must be greater than fromMs.");
  }

  return { symbol, fromMs, toMs };
}

export async function backfillPhase7CCanonicalDealLedger(
  input: Phase7CCanonicalDealWindow,
  dependencies: { historyReader?: DealHistoryReader } = {},
): Promise<{ accountKey: string; inserted: number; total: number }> {
  const { symbol, fromMs, toMs } = validateWindow(input);
  const accountKey = phase7CCanonicalAccountKey(input.telemetry);
  const historyReader = dependencies.historyReader ?? getMt5DealHistory;
  const history = await historyReader(fromMs, toMs, symbol);
  const merged = ledger().mergeBackfill(accountKey, history);

  return {
    accountKey,
    inserted: merged.inserted,
    total: merged.total,
  };
}

export async function warmPhase7CCanonicalDealLedgerOnStartup(
  dependencies: Phase7CCanonicalStartupBackfillDependencies = {},
): Promise<Phase7CCanonicalStartupBackfillResult> {
  const telemetryReader = dependencies.telemetryReader ?? getMt5Telemetry;
  const accountModeReader = dependencies.accountModeReader ?? getPhase7CAccountModeState;
  const telemetry = await telemetryReader("XAUUSD");
  const accountState = accountModeReader();

  if (
    !telemetry.enabled ||
    !telemetry.configured ||
    !telemetry.reachable ||
    telemetry.health?.connected !== true
  ) {
    return {
      status: "SKIPPED",
      reason: "MT5_UNAVAILABLE",
      accountKey: null,
      inserted: 0,
      total: 0,
      fromMs: null,
      toMs: null,
    };
  }

  if (!accountModeAllowsBroker(telemetry.health.accountMode, accountState)) {
    return {
      status: "SKIPPED",
      reason: "ACCOUNT_MODE_MISMATCH",
      accountKey: null,
      inserted: 0,
      total: 0,
      fromMs: null,
      toMs: null,
    };
  }

  const toMs = Number(telemetry.quote?.timestamp);
  if (!Number.isFinite(toMs) || toMs <= 0) {
    return {
      status: "SKIPPED",
      reason: "BROKER_TIME_UNAVAILABLE",
      accountKey: null,
      inserted: 0,
      total: 0,
      fromMs: null,
      toMs: null,
    };
  }

  const fromMs = Math.max(0, toMs - STARTUP_BACKFILL_DAYS * DAY_MS);
  const merged = await backfillPhase7CCanonicalDealLedger(
    {
      telemetry,
      symbol: "XAUUSD",
      fromMs,
      toMs,
    },
    {
      historyReader: dependencies.historyReader,
    },
  );

  return {
    status: "BACKFILLED",
    reason: "OK",
    accountKey: merged.accountKey,
    inserted: merged.inserted,
    total: merged.total,
    fromMs,
    toMs,
  };
}

export async function getPhase7CCanonicalDeals(
  input: Phase7CCanonicalDealWindow,
): Promise<CanonicalDealRecord[]> {
  const { symbol, fromMs, toMs } = validateWindow(input);
  const { accountKey } = await backfillPhase7CCanonicalDealLedger(input);

  return ledger()
    .deals()
    .filter(
      (deal) =>
        deal.account === accountKey &&
        deal.symbol === symbol &&
        deal.timestamp >= fromMs &&
        deal.timestamp < toMs,
    );
}

export async function summarizePhase7CCanonicalDeals(
  input: Phase7CCanonicalDealSummaryInput,
): Promise<{ accountKey: string; dealCount: number; dailyNetPnl: number }> {
  const { symbol, fromMs, toMs } = validateWindow(input);
  const { accountKey } = await backfillPhase7CCanonicalDealLedger(input);
  const summary = ledger().summarize({
    account: accountKey,
    symbol,
    ownedMagics: input.ownedMagics,
    from: fromMs,
    to: toMs,
  });

  return {
    accountKey,
    ...summary,
  };
}

export async function getPhase7CCanonicalPositionRealizedDeals(
  input: Phase7CCanonicalPositionRealizedInput,
): Promise<{ accountKey: string; deals: CanonicalDealRecord[]; realizedNetPnl: number }> {
  const { symbol, fromMs, toMs } = validateWindow(input);
  const positionId = String(input.positionId ?? "").trim();
  if (!positionId) {
    throw new Error("Canonical realized P&L requires positionId.");
  }

  const { accountKey } = await backfillPhase7CCanonicalDealLedger(input);
  const deals = ledger().realizedClosingDeals({
    account: accountKey,
    positionId,
    symbol,
    ownedMagics: input.ownedMagics,
  }).filter(
    (deal) =>
      deal.timestamp >= fromMs &&
      deal.timestamp < toMs,
  );
  const realizedNetPnl = Math.round(
    (deals.reduce((sum, deal) => sum + deal.netPnl, 0) + Number.EPSILON) * 1e10,
  ) / 1e10;

  return {
    accountKey,
    deals,
    realizedNetPnl,
  };
}
