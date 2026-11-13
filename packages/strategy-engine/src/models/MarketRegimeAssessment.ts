import type { MarketRegime } from "./MarketRegime";

export interface MarketRegimeAssessment {
  regime: MarketRegime;
  confidence: number;
  reasons: string[];
  metrics: {
    adx: number | null;
    bollingerBandwidth: number | null;
    volatilityPercent: number;
    confirmedBosCount: number;
    confirmedChochCount: number;
  };
}
