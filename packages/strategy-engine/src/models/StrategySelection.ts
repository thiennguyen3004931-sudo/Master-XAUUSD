import type { StrategyCandidate } from "./StrategyCandidate";

export interface StrategySelection {
  selected: StrategyCandidate | null;
  runnerUp: StrategyCandidate | null;
  edge: number;
  ranked: StrategyCandidate[];
}
