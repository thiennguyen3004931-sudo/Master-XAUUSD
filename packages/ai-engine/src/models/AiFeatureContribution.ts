export interface AiFeatureContribution {
  feature: string;
  impact: number;
  direction: "SUPPORT" | "OPPOSE" | "NEUTRAL";
  explanation: string;
}
