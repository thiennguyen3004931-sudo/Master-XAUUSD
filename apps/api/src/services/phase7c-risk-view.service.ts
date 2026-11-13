import { getPhase7CAccountRiskPreview } from "./phase7c-account-risk.service";
import { phase7CLotSettingsService } from "./phase7c-lot-settings.service";

export async function getPhase7CCanonicalAccountRisk(riskPercent = 0.25, maxLot = 0.03) {
  const data = await getPhase7CAccountRiskPreview(riskPercent, maxLot);
  const lotSettings = phase7CLotSettingsService.get();
  const activeLotSettings = lotSettings.activeAlive && lotSettings.active?.armed
    ? lotSettings.active
    : null;
  const step = Number(data.spec.volumeStep);
  const minVolume = Number(data.spec.minVolume);
  const brokerMax = Number(data.spec.maxVolume);
  const balance = Number(data.account.accountBalance ?? 0);

  const rows = data.rows.map((row) => {
    const cap = Math.min(row.rawLot, maxLot, brokerMax);
    const recommendedLot = canonicalCompatibleLot(cap, minVolume, step);
    const estimatedRiskUsd = recommendedLot * row.lossAtSlOneLot;
    const approved = recommendedLot >= minVolume - 1e-9;
    return {
      ...row,
      recommendedLot: round(recommendedLot, 4),
      estimatedRiskUsd: round(estimatedRiskUsd, 2),
      estimatedRiskPercent: balance > 0 ? round(estimatedRiskUsd / balance * 100, 4) : 0,
      approved,
      reason: approved
        ? "Read-only preview preserves exact +10 one-third partial management; the Sideway executor must validate account, symbol, stop distance and freshness again at its final gate."
        : "Risk/cap cannot support a broker-step lot that preserves exact one-third partial management; BLOCK.",
    };
  });

  return {
    ...data,
    configuration: {
      ...data.configuration,
      currentFixedVolume: activeLotSettings?.trendFixedLot ?? lotSettings.state.trendFixedLot,
      configuredTrendFixedLot: lotSettings.state.trendFixedLot,
      activeTrendFixedLot: activeLotSettings?.trendFixedLot ?? null,
      configuredSidewayRiskPercent: lotSettings.state.sidewayRiskPercent,
      configuredSidewayMaxLot: lotSettings.state.sidewayMaxLot,
      lotSettingsRestartRequired: lotSettings.restartRequired,
      managementCompatibility: "EXACT_ONE_THIRD_PARTIAL_ONLY",
      previewOrderPermission: "NONE",
      sidewayExecutionOwner: "SIDEWAY_EXECUTOR_FINAL_GATE",
    },
    rows,
  };
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

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
