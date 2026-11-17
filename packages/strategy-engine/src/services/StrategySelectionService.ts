import type { StrategyCandidate, StrategySelection } from "../models";

export class StrategySelectionService {
  select(candidates: readonly StrategyCandidate[]): StrategySelection {
    const ranked = [...candidates].sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.score - a.score;
    });
    const eligible = ranked.filter((candidate) => candidate.eligible);
    const selected = eligible[0] ?? null;
    const runnerUp = eligible[1] ?? null;
    return {
      selected,
      runnerUp,
      edge: selected ? selected.score - (runnerUp?.score ?? 0) : 0,
      ranked,
    };
  }
}
