import assert from "node:assert/strict";
import { evaluatePhase7CExcursion } from "../apps/api/src/services/phase7c-performance-excursion.service";

const buy = evaluatePhase7CExcursion({
  side: "BUY",
  entry: 100,
  exit: 108,
  openedAt: 1_000,
  closedAt: 2_000,
  initialRiskPrice: 5,
  bars: [
    { openTime: 900, closeTime: 1_200, high: 103, low: 98 },
    { openTime: 1_200, closeTime: 1_500, high: 110, low: 101 },
    { openTime: 1_500, closeTime: 2_100, high: 112, low: 105 },
  ],
});
assert.equal(buy.evidence, "COMPLETE_M5_WINDOW");
assert.equal(buy.mfePrice, 12);
assert.equal(buy.maePrice, 2);
assert.equal(buy.mfeR, 2.4);
assert.equal(buy.maeR, 0.4);
assert.equal(buy.realizedR, 1.6);
assert.equal(buy.peakToExitGivebackPrice, 4);

const sell = evaluatePhase7CExcursion({
  side: "SELL",
  entry: 100,
  exit: 92,
  openedAt: 1_000,
  closedAt: 2_000,
  initialRiskPrice: 4,
  bars: [
    { openTime: 900, closeTime: 1_300, high: 103, low: 97 },
    { openTime: 1_300, closeTime: 1_700, high: 99, low: 90 },
    { openTime: 1_700, closeTime: 2_100, high: 96, low: 91 },
  ],
});
assert.equal(sell.evidence, "COMPLETE_M5_WINDOW");
assert.equal(sell.mfePrice, 10);
assert.equal(sell.maePrice, 3);
assert.equal(sell.mfeR, 2.5);
assert.equal(sell.maeR, 0.75);
assert.equal(sell.realizedR, 2);
assert.equal(sell.peakToExitGivebackPrice, 2);

const noRisk = evaluatePhase7CExcursion({
  side: "BUY",
  entry: 100,
  exit: 104,
  openedAt: 1_000,
  closedAt: 2_000,
  initialRiskPrice: null,
  bars: [
    { openTime: 900, closeTime: 1_500, high: 107, low: 99 },
    { openTime: 1_500, closeTime: 2_100, high: 108, low: 102 },
  ],
});
assert.equal(noRisk.evidence, "COMPLETE_M5_WINDOW");
assert.equal(noRisk.mfePrice, 8);
assert.equal(noRisk.maePrice, 1);
assert.equal(noRisk.mfeR, null);
assert.equal(noRisk.maeR, null);
assert.equal(noRisk.realizedR, null);
assert.equal(noRisk.peakToExitGivebackPrice, 4);

for (const incomplete of [
  evaluatePhase7CExcursion({
    side: "BUY",
    entry: 100,
    exit: 104,
    openedAt: 1_000,
    closedAt: 2_000,
    initialRiskPrice: 5,
    bars: [{ openTime: 1_100, closeTime: 2_100, high: 108, low: 99 }],
  }),
  evaluatePhase7CExcursion({
    side: "BUY",
    entry: 100,
    exit: 104,
    openedAt: 1_000,
    closedAt: 2_000,
    initialRiskPrice: 5,
    bars: [{ openTime: 900, closeTime: 1_900, high: 108, low: 99 }],
  }),
]) {
  assert.equal(incomplete.evidence, "INCOMPLETE");
  assert.equal(incomplete.mfePrice, null);
  assert.equal(incomplete.maePrice, null);
  assert.equal(incomplete.mfeR, null);
  assert.equal(incomplete.realizedR, null);
  assert.equal(incomplete.peakToExitGivebackPrice, null);
}

const malformed = evaluatePhase7CExcursion({
  side: "BUY",
  entry: 100,
  exit: 104,
  openedAt: 1_000,
  closedAt: 2_000,
  initialRiskPrice: 5,
  bars: [{ openTime: 900, closeTime: 2_100, high: 98, low: 101 }],
});
assert.equal(malformed.evidence, "UNAVAILABLE");
assert.equal(malformed.mfePrice, null);
assert.equal(malformed.maePrice, null);

console.log("P3_PERFORMANCE_EXCURSION_TEST=PASS");
console.log("P3_EXCURSION_INCOMPLETE=FAIL_CLOSED");
console.log("P3_EXCURSION_R_REQUIRES_PROVEN_INITIAL_RISK=TRUE");
