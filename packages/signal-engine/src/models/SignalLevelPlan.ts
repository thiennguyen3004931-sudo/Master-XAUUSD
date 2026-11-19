export interface PartialTarget {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  closePercent: number;
  rewardMultiple: number;
}

export interface SignalLevelPlan {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskDistance: number;
  rewardDistance: number;
  riskReward: number;
  stopSource: string;
  targetSource: string;
  partialTargets: PartialTarget[];
}
