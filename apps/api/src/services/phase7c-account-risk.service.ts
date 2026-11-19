import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
} from "./phase7c-account-mode.service";

type BridgeHealth = {
  status: "ok" | "degraded";
  connected: boolean;
  tradingEnabled: boolean;
  terminalTradeAllowed: boolean;
  expertTradeAllowed: boolean;
  accountLogin: number | null;
  accountMode: "demo" | "contest" | "real" | null;
  accountBalance: number | null;
  accountEquity: number | null;
  accountMargin: number | null;
  accountFreeMargin: number | null;
  accountProfit: number | null;
  accountLeverage: number | null;
  accountCurrency: string | null;
  server: string | null;
  terminalVersion: string | null;
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

type Spec = {
  symbol: string;
  brokerSymbol: string;
  tickSize: number;
  point: number;
  effectiveTickValuePerLot: number;
  cashPerPriceUnitPerLot: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
};

function bridgeBase(): string {
  return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765")
    .trim()
    .replace(/\/$/, "");
}

function bridgeApiKey(): string {
  const value = process.env.MT5_BRIDGE_API_KEY?.trim() || process.env.MT5_API_KEY?.trim() || "";
  if (!value) throw new Error("MT5 bridge API key is not configured for Phase 7C account risk preview.");
  return value;
}

async function bridgeGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${bridgeBase()}${path}`, {
      headers: { "x-mt5-api-key": bridgeApiKey() },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MT5 bridge ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function floorToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.floor((value + 1e-12) / step) * step;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export async function getPhase7CAccountRiskPreview(riskPercent = 0.25, maxLot = 0.03) {
  if (!Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 5) {
    throw new Error("riskPercent must be > 0 and <= 5.");
  }
  if (!Number.isFinite(maxLot) || maxLot <= 0) throw new Error("maxLot must be positive.");

  const [health, quote, spec] = await Promise.all([
    bridgeGet<BridgeHealth>("/health"),
    bridgeGet<Quote>("/v1/quotes/XAUUSD"),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec"),
  ]);
  const accountModeState = getPhase7CAccountModeState();
  if (!health.connected || health.status !== "ok") throw new Error("MT5 bridge is disconnected or unhealthy.");
  if (!accountModeAllowsBroker(health.accountMode, accountModeState)) {
    throw new Error(
      `Phase 7C account-mode guard blocked risk preview. configured=${accountModeState.accountMode}; broker=${health.accountMode ?? "unknown"}.`,
    );
  }

  const balance = Number(health.accountBalance ?? 0);
  if (!(balance > 0)) throw new Error("Account balance is unavailable for risk preview.");
  const targetRiskUsd = balance * riskPercent / 100;
  const effectiveMaxLot = Math.min(maxLot, spec.maxVolume);
  const cashPerPriceUnitPerLot = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0
      ? spec.effectiveTickValuePerLot / spec.tickSize
      : 0;
  if (!(cashPerPriceUnitPerLot > 0)) throw new Error("Broker cash-per-price-unit value is unavailable.");

  const rows = [6, 8, 10].map((stopDistance) => {
    const lossAtSlOneLot = stopDistance * cashPerPriceUnitPerLot;
    const rawLot = targetRiskUsd / lossAtSlOneLot;
    const cap = Math.min(rawLot, effectiveMaxLot);
    const stepped = floorToStep(cap, spec.volumeStep);
    const recommendedLot = stepped >= spec.minVolume - 1e-9 ? stepped : 0;
    const riskUsd = recommendedLot * lossAtSlOneLot;
    return {
      stopDistance,
      targetRiskUsd: round(targetRiskUsd, 2),
      lossAtSlOneLot: round(lossAtSlOneLot, 2),
      rawLot: round(rawLot, 4),
      recommendedLot: round(recommendedLot, 4),
      estimatedRiskUsd: round(riskUsd, 2),
      estimatedRiskPercent: round(riskUsd / balance * 100, 4),
      approved: recommendedLot >= spec.minVolume - 1e-9,
      reason: recommendedLot >= spec.minVolume - 1e-9
        ? "Read-only account sizing preview; executor remains the only execution owner."
        : "Broker minimum lot would exceed the configured risk target; BLOCK instead of forcing a lot.",
    };
  });

  return {
    source: "MT5_ACCOUNT_READ_ONLY",
    generatedAt: Date.now(),
    safety: {
      mode: "ACCOUNT_RISK_PREVIEW",
      executionMutation: false,
      orderPermission: "NONE" as const,
      accountMode: accountModeState.accountMode,
      liveExecutionEnabled: accountModeState.liveExecutionEnabled,
      accountGuardValid: accountModeState.valid,
    },
    account: health,
    quote,
    spec,
    configuration: {
      riskPercent,
      maxLot,
      targetRiskUsd: round(targetRiskUsd, 2),
    },
    rows,
  };
}
