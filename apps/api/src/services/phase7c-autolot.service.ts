import { phase7CLotSettingsService } from "./phase7c-lot-settings.service";
import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
} from "./phase7c-account-mode.service";

type BridgeHealth = {
  connected: boolean;
  tradingEnabled: boolean;
  terminalTradeAllowed: boolean;
  expertTradeAllowed: boolean;
  accountLogin: number | null;
  accountMode: "demo" | "contest" | "real" | null;
  accountBalance: number | null;
  accountEquity: number | null;
  accountCurrency: string | null;
  server: string | null;
};

type Spec = {
  brokerSymbol: string;
  tickSize: number;
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
  const value = (
    process.env.MT5_BRIDGE_API_KEY?.trim() ||
    process.env.MT5_API_KEY?.trim() ||
    ""
  );
  if (!value) {
    throw new Error("MT5_BRIDGE_API_KEY or MT5_API_KEY is not configured for Phase 7C.");
  }
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

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function canonicalCompatibleLot(cap: number, minVolume: number, step: number): number {
  if (!(cap > 0) || !(minVolume > 0) || !(step > 0)) return 0;
  const minUnits = Math.max(1, Math.ceil((minVolume - 1e-12) / step));
  let units = Math.floor((cap + 1e-12) / step);
  while (units >= minUnits * 3) {
    if (units % 3 === 0 && units / 3 >= minUnits && (units * 2) / 3 >= minUnits) {
      return round(units * step, 8);
    }
    units -= 1;
  }
  return 0;
}

export async function getPhase7CAutoLotPreview(
  stopDistance: number,
  riskPercent = 0.25,
  maxLot = 0.03,
) {
  if (!Number.isFinite(stopDistance) || stopDistance <= 0 || stopDistance > 50) {
    throw new Error("stopDistance must be > 0 and <= 50 XAUUSD price units.");
  }
  if (!Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 5) {
    throw new Error("riskPercent must be > 0 and <= 5.");
  }
  if (!Number.isFinite(maxLot) || maxLot <= 0) {
    throw new Error("maxLot must be positive.");
  }

  const [health, spec] = await Promise.all([
    bridgeGet<BridgeHealth>("/health"),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec"),
  ]);
  const accountModeState = getPhase7CAccountModeState();
  const lotSettings = phase7CLotSettingsService.get();
  const trendFixedVolume = lotSettings.activeAlive && lotSettings.active?.armed
    ? lotSettings.active.trendFixedLot
    : lotSettings.state.trendFixedLot;

  if (!health.connected) throw new Error("MT5 bridge is disconnected.");
  if (!accountModeAllowsBroker(health.accountMode, accountModeState)) {
    throw new Error(
      `Phase 7C account-mode guard blocked Auto Lot preview. configured=${accountModeState.accountMode}; broker=${health.accountMode ?? "unknown"}.`,
    );
  }

  const balance = Number(health.accountBalance ?? 0);
  if (!(balance > 0)) throw new Error("Account balance is unavailable for Auto Lot preview.");

  const cashPerPriceUnitPerLot = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0
      ? spec.effectiveTickValuePerLot / spec.tickSize
      : 0;
  if (!(cashPerPriceUnitPerLot > 0)) {
    throw new Error("Broker cash-per-price-unit value is unavailable.");
  }

  const targetRiskUsd = balance * riskPercent / 100;
  const lossAtSlOneLot = stopDistance * cashPerPriceUnitPerLot;
  const rawLot = targetRiskUsd / lossAtSlOneLot;
  const effectiveMaxLot = Math.min(maxLot, spec.maxVolume);
  const cappedLot = Math.min(rawLot, effectiveMaxLot);
  const recommendedLot = canonicalCompatibleLot(cappedLot, spec.minVolume, spec.volumeStep);
  const estimatedRiskUsd = recommendedLot * lossAtSlOneLot;
  const approved = recommendedLot >= spec.minVolume - 1e-9;
  const partialVolume = approved ? round(recommendedLot / 3, 8) : 0;
  const runnerVolume = approved ? round(recommendedLot - partialVolume, 8) : 0;

  return {
    source: "MT5_ACCOUNT_READ_ONLY",
    generatedAt: Date.now(),
    safety: {
      mode: "AUTO_LOT_SHADOW",
      executionMutation: false,
      phase7bFixedVolumeUnchanged: true,
      liveUnlockAvailable: accountModeState.accountMode === "LIVE" && accountModeState.liveExecutionEnabled,
      accountModeGuard: accountModeState.valid ? "PASS" : "BLOCK",
    },
    accountMode: {
      configured: accountModeState.accountMode,
      liveExecutionEnabled: accountModeState.liveExecutionEnabled,
      valid: accountModeState.valid,
      source: accountModeState.source,
    },
    account: {
      login: health.accountLogin,
      server: health.server,
      mode: health.accountMode,
      currency: health.accountCurrency,
      balance: round(balance, 2),
      equity: health.accountEquity === null ? null : round(health.accountEquity, 2),
    },
    broker: {
      symbol: spec.brokerSymbol,
      cashPerPriceUnitPerLot: round(cashPerPriceUnitPerLot, 4),
      minVolume: spec.minVolume,
      maxVolume: spec.maxVolume,
      volumeStep: spec.volumeStep,
    },
    configuration: {
      riskPercent,
      maxLot,
      currentFixedVolume: trendFixedVolume,
      targetRiskUsd: round(targetRiskUsd, 2),
      managementCompatibility: "EXACT_ONE_THIRD_PARTIAL_ONLY",
    },
    preview: {
      stopDistance: round(stopDistance, 5),
      lossAtSlOneLot: round(lossAtSlOneLot, 2),
      rawLot: round(rawLot, 4),
      recommendedLot: round(recommendedLot, 4),
      partialVolume,
      runnerVolume,
      estimatedRiskUsd: round(estimatedRiskUsd, 2),
      estimatedRiskPercent: round(estimatedRiskUsd / balance * 100, 4),
      approved,
      reason: approved
        ? "Read-only sizing snapshot preserves exact +10 one-third partial and runner management; the executor must validate account mode, market state and sizing again at the final gate before any order."
        : "Risk/cap cannot support a broker-step lot that preserves exact one-third partial management; shadow recommendation is BLOCK.",
    },
  };
}
