import type { SignalDirection, SignalRuleResult, SignalScore } from "../models";
import { NumberUtils } from "../utils";

export class SignalScoreService {
  calculate(results: readonly SignalRuleResult[]): SignalScore {
    const bullishPoints = results.reduce((sum, result) => sum + result.bullishPoints, 0);
    const bearishPoints = results.reduce((sum, result) => sum + result.bearishPoints, 0);
    const maximumPoints = results.reduce((sum, result) => sum + result.maximumPoints, 0);
    const winningPoints = Math.max(bullishPoints, bearishPoints);
    const confidence = maximumPoints === 0 ? 0 : (winningPoints / maximumPoints) * 100;
    const directionalEdge = maximumPoints === 0 ? 0 : (Math.abs(bullishPoints - bearishPoints) / maximumPoints) * 100;

    let direction: SignalDirection = "NEUTRAL";
    if (bullishPoints > bearishPoints) direction = "BULLISH";
    if (bearishPoints > bullishPoints) direction = "BEARISH";

    return {
      direction,
      bullishPoints: NumberUtils.round(bullishPoints, 4),
      bearishPoints: NumberUtils.round(bearishPoints, 4),
      maximumPoints: NumberUtils.round(maximumPoints, 4),
      confidence: NumberUtils.round(confidence, 2),
      directionalEdge: NumberUtils.round(directionalEdge, 2),
    };
  }
}
