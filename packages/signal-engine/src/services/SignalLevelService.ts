import type { SignalEngineConfig } from "../config";
import type {
  PartialTarget,
  SignalContext,
  SignalDirection,
  SignalLevelPlan,
} from "../models";
import { NumberUtils } from "../utils";

interface PriceCandidate {
  price: number;
  source: string;
}

export class SignalLevelService {
  calculate(
    context: SignalContext,
    direction: Exclude<SignalDirection, "NEUTRAL">,
    config: SignalEngineConfig,
  ): SignalLevelPlan | null {
    const entry = context.indicators.latest.close;
    const atr = context.indicators.latest.atr ?? context.analysis.metrics.averageTrueRange;

    if (!NumberUtils.isFinitePositive(entry) || !NumberUtils.isFinitePositive(atr)) {
      return null;
    }

    const stopCandidate = direction === "BULLISH"
      ? this.findBuyStop(context, entry)
      : this.findSellStop(context, entry);
    const minimumRisk = atr * config.stopAtrMultiplier;
    const structuralRisk = stopCandidate
      ? Math.abs(entry - stopCandidate.price) + atr * config.stopBufferAtrMultiplier
      : 0;
    const riskDistance = Math.max(minimumRisk, structuralRisk);
    const stopLoss = direction === "BULLISH" ? entry - riskDistance : entry + riskDistance;

    const targetCandidate = this.findTarget(
      context,
      direction,
      entry,
      riskDistance,
      config.minimumRiskReward,
    );
    const fallbackTarget = direction === "BULLISH"
      ? entry + riskDistance * config.targetRiskReward
      : entry - riskDistance * config.targetRiskReward;
    const takeProfit = targetCandidate?.price ?? fallbackTarget;
    const rewardDistance = Math.abs(takeProfit - entry);
    const riskReward = rewardDistance / riskDistance;

    if (!Number.isFinite(riskReward) || riskReward < config.minimumRiskReward) {
      return null;
    }

    return {
      entry: NumberUtils.round(entry, config.priceDigits),
      stopLoss: NumberUtils.round(stopLoss, config.priceDigits),
      takeProfit: NumberUtils.round(takeProfit, config.priceDigits),
      riskDistance: NumberUtils.round(riskDistance, config.priceDigits),
      rewardDistance: NumberUtils.round(rewardDistance, config.priceDigits),
      riskReward: NumberUtils.round(riskReward, 2),
      stopSource: stopCandidate?.source ?? "ATR fallback",
      targetSource: targetCandidate?.source ?? `${config.targetRiskReward}R fallback`,
      partialTargets: this.createPartialTargets(
        direction,
        entry,
        riskDistance,
        riskReward,
        config.priceDigits,
      ),
    };
  }

  private findBuyStop(context: SignalContext, entry: number): PriceCandidate | undefined {
    const candidates: PriceCandidate[] = [];

    for (const swing of context.analysis.swings) {
      if (swing.type === "LOW" && swing.price < entry) candidates.push({ price: swing.price, source: "Swing low" });
    }
    for (const block of context.analysis.orderBlocks) {
      if (block.bullish && !block.mitigated && block.low < entry) candidates.push({ price: block.low, source: "Bullish order block" });
    }    for (const zone of context.analysis.supplyDemandZones ?? []) {
      if (zone.type === "DEMAND" && zone.active && zone.low < entry) {
        candidates.push({ price: zone.low, source: "Demand zone invalidation" });
      }
    }
    for (const gap of context.analysis.fairValueGaps) {
      if (gap.bullish && !gap.filled && gap.low < entry) {
        candidates.push({ price: gap.low, source: "Bullish FVG invalidation" });
      }
    }
    if (context.analysis.discountZone < entry) candidates.push({ price: context.analysis.discountZone, source: "Discount zone" });

    return candidates.sort((left, right) => right.price - left.price)[0];
  }

  private findSellStop(context: SignalContext, entry: number): PriceCandidate | undefined {
    const candidates: PriceCandidate[] = [];

    for (const swing of context.analysis.swings) {
      if (swing.type === "HIGH" && swing.price > entry) candidates.push({ price: swing.price, source: "Swing high" });
    }
    for (const block of context.analysis.orderBlocks) {
      if (!block.bullish && !block.mitigated && block.high > entry) candidates.push({ price: block.high, source: "Bearish order block" });
    }    for (const zone of context.analysis.supplyDemandZones ?? []) {
      if (zone.type === "SUPPLY" && zone.active && zone.high > entry) {
        candidates.push({ price: zone.high, source: "Supply zone invalidation" });
      }
    }
    for (const gap of context.analysis.fairValueGaps) {
      if (!gap.bullish && !gap.filled && gap.high > entry) {
        candidates.push({ price: gap.high, source: "Bearish FVG invalidation" });
      }
    }
    if (context.analysis.premiumZone > entry) candidates.push({ price: context.analysis.premiumZone, source: "Premium zone" });

    return candidates.sort((left, right) => left.price - right.price)[0];
  }

  private findTarget(
    context: SignalContext,
    direction: Exclude<SignalDirection, "NEUTRAL">,
    entry: number,
    riskDistance: number,
    minimumRiskReward: number,
  ): PriceCandidate | undefined {
    const candidates: PriceCandidate[] = [];

    for (const zone of context.analysis.liquidityZones) {
      if (!zone.touched) candidates.push({ price: zone.price, source: "Untapped liquidity" });
    }
    if (direction === "BULLISH") {
      candidates.push({ price: context.analysis.premiumZone, source: "Premium zone" });
      candidates.push({ price: context.analysis.metrics.rangeHigh, source: "Analysis range high" });
    } else {
      candidates.push({ price: context.analysis.discountZone, source: "Discount zone" });
      candidates.push({ price: context.analysis.metrics.rangeLow, source: "Analysis range low" });
    }

    return candidates
      .filter((candidate) => direction === "BULLISH" ? candidate.price > entry : candidate.price < entry)
      .filter((candidate) => Math.abs(candidate.price - entry) / riskDistance >= minimumRiskReward)
      .sort((left, right) => direction === "BULLISH" ? left.price - right.price : right.price - left.price)[0];
  }

  private createPartialTargets(
    direction: Exclude<SignalDirection, "NEUTRAL">,
    entry: number,
    riskDistance: number,
    finalRewardMultiple: number,
    digits: number,
  ): PartialTarget[] {
    const multipliers = [1, Math.min(2, finalRewardMultiple), finalRewardMultiple];
    const labels: PartialTarget["label"][] = ["TP1", "TP2", "TP3"];
    const closePercents = [40, 30, 30];

    return multipliers.map((multiple, index) => ({
      label: labels[index]!,
      price: NumberUtils.round(direction === "BULLISH" ? entry + riskDistance * multiple : entry - riskDistance * multiple, digits),
      closePercent: closePercents[index]!,
      rewardMultiple: NumberUtils.round(multiple, 2),
    }));
  }
}
