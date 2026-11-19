export interface SlippageAssessment {
  plannedPrice: number;
  executablePrice: number;
  slippageDistance: number;
  slippageTicks: number;
  favorable: boolean;
}
