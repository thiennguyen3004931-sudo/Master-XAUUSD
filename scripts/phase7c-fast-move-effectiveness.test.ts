import assert from "node:assert/strict";
import { evaluatePhase7CFastMoveEffectiveness } from "../apps/api/src/services/phase7c-fast-move-effectiveness.service";

const buyPath = [
  { timestamp: 1, price: 100 },
  { timestamp: 2, price: 106 },
  { timestamp: 3, price: 110 },
  { timestamp: 4, price: 115 },
  { timestamp: 5, price: 112 },
  { timestamp: 6, price: 109 },
];

const trendBuy = evaluatePhase7CFastMoveEffectiveness({
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  prices: buyPath,
  sampleSize: 29,
});
assert.deepEqual(trendBuy.current.contract, {
  activationPrice: 10,
  givebackPrice: 10,
  source: "LIVE_BID_ASK",
});
assert.equal(trendBuy.current.mode, "CURRENT_OBSERVED_CONTRACT");
assert.equal(trendBuy.current.result.triggered, true);
assert.equal(trendBuy.current.result.peakPrice, 115);
assert.equal(trendBuy.current.result.peakFavorable, 15);
assert.equal(trendBuy.current.result.stopHit, false);
assert.equal(trendBuy.current.result.stopPrice, 105);
assert.equal(trendBuy.current.result.lockedProfitPrice, 5);
assert.deepEqual(trendBuy.shadow.map((row) => row.givebackPrice), [4, 5, 7, 8]);
assert.ok(trendBuy.shadow.every((row) => row.mode === "SHADOW_ONLY"));
assert.equal(trendBuy.shadow[0]?.result.stopPrice, 111);
assert.equal(trendBuy.shadow[0]?.result.lockedProfitPrice, 11);
assert.equal(trendBuy.shadow[1]?.result.stopPrice, 110);
assert.equal(trendBuy.shadow[2]?.result.stopHit, false);
assert.equal(trendBuy.sample.recommendationEligible, false);
assert.equal(trendBuy.safety.readOnly, true);
assert.equal(trendBuy.safety.orderMutation, false);
assert.equal(trendBuy.safety.positionMutation, false);
assert.equal(trendBuy.safety.autoApply, false);

const reversalBuy = evaluatePhase7CFastMoveEffectiveness({
  strategy: "REVERSAL",
  side: "BUY",
  entry: 100,
  prices: buyPath,
  sampleSize: 30,
});
assert.deepEqual(reversalBuy.current.contract, trendBuy.current.contract);
assert.deepEqual(
  reversalBuy.shadow.map((row) => row.givebackPrice),
  trendBuy.shadow.map((row) => row.givebackPrice),
);
assert.equal(reversalBuy.sample.recommendationEligible, true);

const sellPath = [
  { timestamp: 1, price: 100 },
  { timestamp: 2, price: 94 },
  { timestamp: 3, price: 90 },
  { timestamp: 4, price: 85 },
  { timestamp: 5, price: 88 },
  { timestamp: 6, price: 91 },
];
const trendSell = evaluatePhase7CFastMoveEffectiveness({
  strategy: "TREND",
  side: "SELL",
  entry: 100,
  prices: sellPath,
  sampleSize: 30,
});
assert.equal(trendSell.current.result.triggered, true);
assert.equal(trendSell.current.result.peakPrice, 85);
assert.equal(trendSell.current.result.peakFavorable, 15);
assert.equal(trendSell.current.result.stopHit, false);
assert.equal(trendSell.current.result.stopPrice, 95);
assert.equal(trendSell.current.result.lockedProfitPrice, 5);
assert.equal(trendSell.sample.recommendationEligible, true);

const sideway = evaluatePhase7CFastMoveEffectiveness({
  strategy: "SIDEWAY",
  side: "BUY",
  entry: 100,
  prices: buyPath,
  sampleSize: 30,
});
assert.deepEqual(sideway.current.contract, {
  activationPrice: 10,
  givebackPrice: 10,
  source: "LIVE_BID_ASK",
});
assert.deepEqual(sideway.shadow.map((row) => row.givebackPrice), [3, 5, 6]);
assert.equal(sideway.current.result.stopPrice, 105);
assert.equal(sideway.current.result.lockedProfitPrice, 5);

const exactlyAtActivation = evaluatePhase7CFastMoveEffectiveness({
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  prices: [
    { timestamp: 1, price: 100 },
    { timestamp: 2, price: 110 },
  ],
  sampleSize: 50,
});
assert.equal(exactlyAtActivation.current.result.triggered, true);
assert.equal(exactlyAtActivation.current.result.stopPrice, null);
assert.equal(exactlyAtActivation.current.result.lockedProfitPrice, null);

const belowActivation = evaluatePhase7CFastMoveEffectiveness({
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  prices: [
    { timestamp: 1, price: 100 },
    { timestamp: 2, price: 109.99 },
    { timestamp: 3, price: 105 },
  ],
  sampleSize: 50,
});
assert.equal(belowActivation.current.result.triggered, false);
assert.equal(belowActivation.current.result.stopPrice, null);
assert.equal(belowActivation.current.result.lockedProfitPrice, null);

console.log("P3_FAST_MOVE_EFFECTIVENESS_TEST=PASS");
console.log("P3_FAST_MOVE_CURRENT_GIVEBACK_10=TRUE");
console.log("P3_FAST_MOVE_SHADOW_ONLY=TRUE");
console.log("P3_FAST_MOVE_MIN_RECOMMENDATION_SAMPLE=30");
