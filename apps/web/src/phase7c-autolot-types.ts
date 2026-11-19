export interface Phase7CAutoLotPreview {
  source: "MT5_DEMO_READ_ONLY";
  generatedAt: number;
  safety: {
    mode: "AUTO_LOT_SHADOW";
    executionMutation: false;
    phase7bFixedVolumeUnchanged: true;
    liveUnlockAvailable: false;
  };
  account: {
    login: number | null;
    server: string | null;
    mode: string | null;
    currency: string | null;
    balance: number;
    equity: number | null;
  };
  broker: {
    symbol: string;
    cashPerPriceUnitPerLot: number;
    minVolume: number;
    maxVolume: number;
    volumeStep: number;
  };
  configuration: {
    riskPercent: number;
    maxLot: number;
    currentFixedVolume: number;
    targetRiskUsd: number;
    managementCompatibility: "EXACT_ONE_THIRD_PARTIAL_ONLY";
  };
  preview: {
    stopDistance: number;
    lossAtSlOneLot: number;
    rawLot: number;
    recommendedLot: number;
    partialVolume: number;
    runnerVolume: number;
    estimatedRiskUsd: number;
    estimatedRiskPercent: number;
    approved: boolean;
    reason: string;
  };
}
