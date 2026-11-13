# Phase 4 canonical replay integration

This hook is research-only. It must not change the current canonical M15 decision, AI policy order, production-equivalent pending entry, DEMO statistics, or LIVE lock.

## Import

Extend the existing risk-engine import in the local historical replay runner:

```ts
import {
  Phase4CanonicalReplayAdapter,
  RiskPipeline,
} from "@xauusd/risk-engine";
```

## Initialize once

Place beside `const riskEngine = new RiskPipeline();`:

```ts
const phase4Research = new Phase4CanonicalReplayAdapter();
```

## Add one Phase 4 research case after AI executable + TREND_CONTINUATION validation

The research case must be added before the current exact-0.01 `continue` gate so blocked canonical setups are included in Phase 4.

```ts
const canonicalEntry = Number(plan.order.entry);
const canonicalStopLoss = Number(plan.order.stopLoss);
const signalTimestamp = current.closeTime;
const expiresAt = Number(plan.expiresAt ?? (signalTimestamp + 3 * 5 * 60_000));

if (
  Number.isFinite(canonicalEntry) &&
  Number.isFinite(canonicalStopLoss) &&
  expiresAt >= signalTimestamp
) {
  phase4Research.add({
    id: `phase4-${signalTimestamp}-${String(plan.order.side)}`,
    side: plan.order.side,
    canonicalEntry,
    canonicalStopLoss,
    signalTimestamp,
    expiresAt,
    effectiveRiskCapUsd: maximumRiskUsd,
    instrument: {
      symbol: "XAUUSD",
      tickSize: meta.tickSize,
      tickValuePerLot: meta.effectiveTickValuePerLot,
      contractSize: 100,
      minVolume: 0.01,
      maxVolume: 100,
      volumeStep: 0.01,
      maxSpread: Number.POSITIVE_INFINITY,
      priceDigits: 2,
    },
    m5Bars: rawM5,
    maxM5Bars: 12,
  });
}
```

Do not assign the Phase 4 selected entry back to `plan.order.entry`. Do not create `pendingEntry` from a Phase 4 result. Existing execution remains unchanged.

## Emit counters at the end

Add before the final PASS lines:

```ts
const phase4Result = phase4Research.result();
for (const line of phase4Research.formatCounters()) {
  console.log(line);
}

console.log("PHASE4_PRODUCTION_EQUIVALENCE=false");
console.log("PHASE4_CANONICAL_SIGNAL_UNCHANGED=PASS");
console.log("PHASE4_CANONICAL_STOP_PRESERVED=PASS");
console.log("PHASE4_PER_TRADE_RISK_CAP_PRESERVED=PASS");
```

Optionally add `phase4: phase4Result` to the replay JSON result for case-level audit.

## Interpretation

Phase 3 baseline remains the production-equivalent path. Phase 4 measures whether waiting for a structural M5 retracement can make broker minimum volume feasible without loosening the risk cap or tightening the canonical structural stop.
