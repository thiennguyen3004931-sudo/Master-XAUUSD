import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fastMoveProfitLockCandidate } from "./phase7c-fast-move-profit-lock.mjs";
import {
  stopStrictlyTightens,
  tightestKnownStop,
} from "./phase7c-stop-monotonicity.mjs";
import {
  transformPhase7CSidewayM5TrailingSource,
  transformPhase7CTrendM5TrailingSource,
} from "./phase7c-m5-structural-trailing-source-adapter.mjs";
import {
  transformPhase7CSidewayM5PreStructureProfitLockSource,
  transformPhase7CTrendM5PreStructureProfitLockSource,
} from "./phase7c-m5-prestructure-profit-lock-source-adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const trendRawSource = fs.readFileSync(path.join(here, "run-phase7b-demo-controller.ts"), "utf8");
const sidewayRawSource = fs.readFileSync(path.join(here, "run-phase7c-sideway-controller.mjs"), "utf8");
const trendSource = transformPhase7CTrendM5PreStructureProfitLockSource(
  transformPhase7CTrendM5TrailingSource(trendRawSource),
);
const sidewaySource = transformPhase7CSidewayM5PreStructureProfitLockSource(
  transformPhase7CSidewayM5TrailingSource(sidewayRawSource),
);

const trendBuy = fastMoveProfitLockCandidate({
  side: "BUY",
  entry: 4300,
  marketPrice: 4315,
  previousPeakPrice: 4312,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(trendBuy.active, true);
assert.equal(trendBuy.peakPrice, 4315);
assert.equal(trendBuy.peakFavorable, 15);
assert.equal(trendBuy.candidateStop, 4305);

const trendSell = fastMoveProfitLockCandidate({
  side: "SELL",
  entry: 4300,
  marketPrice: 4285,
  previousPeakPrice: 4288,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(trendSell.active, true);
assert.equal(trendSell.peakPrice, 4285);
assert.equal(trendSell.peakFavorable, 15);
assert.equal(trendSell.candidateStop, 4295);

const belowActivation = fastMoveProfitLockCandidate({
  side: "BUY",
  entry: 4300,
  marketPrice: 4309.99,
  previousPeakPrice: 4309.99,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(belowActivation.active, false);
assert.equal(belowActivation.reason, "BELOW_ACTIVATION");
assert.equal(belowActivation.candidateStop, 0);

const exactlyAtActivation = fastMoveProfitLockCandidate({
  side: "BUY",
  entry: 4300,
  marketPrice: 4310,
  previousPeakPrice: 4310,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(exactlyAtActivation.active, false);
assert.equal(exactlyAtActivation.reason, "CANDIDATE_NOT_PROFIT_LOCK");
assert.equal(exactlyAtActivation.peakPrice, 4310);
assert.equal(exactlyAtActivation.candidateStop, 0);

const pullbackAfterPeak = fastMoveProfitLockCandidate({
  side: "BUY",
  entry: 4300,
  marketPrice: 4308,
  previousPeakPrice: 4315,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(pullbackAfterPeak.active, true);
assert.equal(pullbackAfterPeak.peakPrice, 4315);
assert.equal(pullbackAfterPeak.candidateStop, 4305);

const sidewaySamePeak = fastMoveProfitLockCandidate({
  side: "BUY",
  entry: 4300,
  marketPrice: 4315,
  previousPeakPrice: 4315,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(sidewaySamePeak.active, true);
assert.equal(sidewaySamePeak.candidateStop, 4305);

const invalidSide = fastMoveProfitLockCandidate({
  side: "HOLD",
  entry: 4300,
  marketPrice: 4315,
  previousPeakPrice: 4315,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(invalidSide.active, false);
assert.equal(invalidSide.reason, "INVALID_INPUT");

const invalidConfig = fastMoveProfitLockCandidate({
  side: "BUY",
  entry: 4300,
  marketPrice: 4315,
  previousPeakPrice: 4315,
  activationDistance: 4,
  givebackDistance: 6,
});
assert.equal(invalidConfig.active, false);
assert.equal(invalidConfig.reason, "INVALID_INPUT");

assert.equal(
  stopStrictlyTightens("BUY", tightestKnownStop("BUY", 4300, 4305), 4304),
  false,
  "Structure or any later stop source must never loosen a tighter pre-structure BUY floor.",
);
assert.equal(
  stopStrictlyTightens("SELL", tightestKnownStop("SELL", 4300, 4295), 4296),
  false,
  "Structure or any later stop source must never loosen a tighter pre-structure SELL floor.",
);

assert.match(trendSource, /FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE\s*=\s*10/);
assert.match(trendSource, /FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE\s*=\s*10/);
assert.match(trendSource, /FAST_MOVE_PROFIT_LOCK_TIGHTEN/);
assert.match(
  trendSource,
  /const fastMoveEligible = stopIsAtLeastAsTight\(\s*managed\.side,\s*Number\(position\.stopLoss\),\s*Number\(position\.entry\),\s*\);[\s\S]*?if \(fastMove\.active && fastMoveEligible\)/,
  "Pre-structure Trend lock must only tighten after the broker stop is already at BE or better.",
);
assert.match(
  trendSource,
  /if \(!managed\.fastMoveHandedOffToM5\) \{[\s\S]*?fastMoveProfitLockCandidate/,
  "Trend FastMove must remain active until a successful M5 stop handoff is durably confirmed.",
);
assert.doesNotMatch(
  trendSource,
  /if \(fastMoveStructure !== null && !managed\.fastMoveHandedOffToM5\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true/,
  "Trend must not disable FastMove merely because an M5 structure exists before that candidate is accepted.",
);
assert.match(
  trendSource,
  /if \(response\.success\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true;[\s\S]*?FAST_MOVE_HANDOFF_M5_STRUCTURE/,
  "Trend M5 ownership handoff must become durable only after the broker accepts the tighter M5 stop.",
);
assert.match(
  trendSource,
  /fastMoveCycleAnchorPrice\?: number;[\s\S]*?fastMoveCycleStartedAt\?: number;/,
  "Trend must persist cyclic FastMove/M5 handoff state.",
);
assert.match(
  trendSource,
  /if \(managed\.fastMoveHandedOffToM5 && !\(Number\(managed\.fastMoveCycleAnchorPrice\) > 0\)\) \{[\s\S]*?managed\.fastMoveCycleAnchorPrice = exitPrice;[\s\S]*?managed\.fastMovePeakPrice = exitPrice;[\s\S]*?FAST_MOVE_CYCLE_ANCHOR_MIGRATED/,
  "Trend must safely seed a cycle anchor for pre-existing handed-off runtime state.",
);
assert.match(
  trendSource,
  /const fastMoveReactivationDistance =[\s\S]*?FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE[\s\S]*?managed\.fastMoveHandedOffToM5 = false;[\s\S]*?managed\.fastMoveCycleStartedAt = Number\(quote\.timestamp\);[\s\S]*?managed\.fastMovePeakPrice = exitPrice;[\s\S]*?FAST_MOVE_REACTIVATED_AFTER_M5/,
  "Trend must reactivate FastMove after a new +10 favorable impulse from the M5 handoff anchor.",
);
assert.match(
  trendSource,
  /const fastMoveReferencePrice = Number\(managed\.fastMoveCycleAnchorPrice\) > 0[\s\S]*?entry: fastMoveReferencePrice/,
  "Trend reactivated FastMove must use the new cycle anchor, not the original entry.",
);
assert.match(
  trendSource,
  /afterTimestamp: managed\.fastMoveCycleStartedAt \?\? managed\.partialActivatedAt \?\? managed\.signalTimestamp/,
  "Trend M5 handoff after reactivation must require structure newer than the FastMove cycle start.",
);
assert.match(
  trendSource,
  /const handoffFromFastMove = !managed\.fastMoveHandedOffToM5;[\s\S]*?if \(handoffFromFastMove\) \{[\s\S]*?managed\.fastMoveCycleAnchorPrice = exitPrice;[\s\S]*?managed\.fastMovePeakPrice = exitPrice;[\s\S]*?FAST_MOVE_HANDOFF_M5_STRUCTURE/,
  "Trend successful M5 takeover must reset the next FastMove cycle anchor and peak.",
);
assert.doesNotMatch(
  trendSource,
  /const fastMoveStructure = managed\.partialApplied && latestM15[\s\S]*?latestConfirmedStructureStop/,
);

assert.match(sidewaySource, /FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE\s*=\s*10/);
assert.match(sidewaySource, /FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE\s*=\s*10/);
assert.match(sidewaySource, /FAST_MOVE_PROFIT_LOCK_TIGHTEN/);
assert.match(
  sidewaySource,
  /const fastMoveEligible = stopIsAtLeastAsTight\(\s*managed\.side,\s*Number\(position\.stopLoss\),\s*Number\(managed\.entry\),\s*\);[\s\S]*?if \(fastMove\.active && fastMoveEligible\)/,
  "Pre-structure Sideway lock must only tighten after the broker stop is already at BE or better.",
);
assert.match(
  sidewaySource,
  /if \(!managed\.fastMoveHandedOffToM5\) \{[\s\S]*?fastMoveProfitLockCandidate/,
  "Sideway FastMove must remain active until a successful M5 stop handoff is durably confirmed.",
);
assert.doesNotMatch(
  sidewaySource,
  /if \(fastMoveStructure !== null && !managed\.fastMoveHandedOffToM5\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true/,
  "Sideway must not disable FastMove merely because an M5 structure exists before that candidate is accepted.",
);
assert.match(
  sidewaySource,
  /if \(response\.success\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true;[\s\S]*?FAST_MOVE_HANDOFF_M5_STRUCTURE/,
  "Sideway M5 ownership handoff must become durable only after the broker accepts the tighter M5 stop.",
);
assert.match(
  sidewaySource,
  /fastMoveHandedOffToM5: false,[\s\S]*?fastMoveCycleAnchorPrice: null,[\s\S]*?fastMoveCycleStartedAt: null,/,
  "Sideway must persist cyclic FastMove/M5 handoff state.",
);
assert.match(
  sidewaySource,
  /if \(managed\.fastMoveHandedOffToM5 && !\(Number\(managed\.fastMoveCycleAnchorPrice\) > 0\)\) \{[\s\S]*?managed\.fastMoveCycleAnchorPrice = marketPrice;[\s\S]*?managed\.fastMovePeakPrice = marketPrice;[\s\S]*?FAST_MOVE_CYCLE_ANCHOR_MIGRATED/,
  "Sideway must safely seed a cycle anchor for pre-existing handed-off runtime state.",
);
assert.match(
  sidewaySource,
  /const fastMoveReactivationDistance =[\s\S]*?FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE[\s\S]*?managed\.fastMoveHandedOffToM5 = false;[\s\S]*?managed\.fastMoveCycleStartedAt = Number\(quote\.timestamp\);[\s\S]*?managed\.fastMovePeakPrice = marketPrice;[\s\S]*?FAST_MOVE_REACTIVATED_AFTER_M5/,
  "Sideway must reactivate FastMove after a new +10 favorable impulse from the M5 handoff anchor.",
);
assert.match(
  sidewaySource,
  /const fastMoveReferencePrice = Number\(managed\.fastMoveCycleAnchorPrice\) > 0[\s\S]*?entry: fastMoveReferencePrice/,
  "Sideway reactivated FastMove must use the new cycle anchor, not the original entry.",
);
assert.match(
  sidewaySource,
  /afterTimestamp: Number\(managed\.fastMoveCycleStartedAt \?\? managed\.partialActivatedAt \?\? managed\.signalM5CloseTime \?\? 0\)/,
  "Sideway M5 handoff after reactivation must require structure newer than the FastMove cycle start.",
);
assert.match(
  sidewaySource,
  /const handoffFromFastMove = !managed\.fastMoveHandedOffToM5;[\s\S]*?if \(handoffFromFastMove\) \{[\s\S]*?managed\.fastMoveCycleAnchorPrice = marketPrice;[\s\S]*?managed\.fastMovePeakPrice = marketPrice;[\s\S]*?FAST_MOVE_HANDOFF_M5_STRUCTURE/,
  "Sideway successful M5 takeover must reset the next FastMove cycle anchor and peak.",
);

console.log("M5_PRE_STRUCTURE_PROFIT_LOCK_CONTRACT=PASS");
console.log("M5_PRE_STRUCTURE_BUY_SELL_SYMMETRY=PASS");
console.log("M5_PRE_STRUCTURE_PEAK_PERSISTS_THROUGH_PULLBACK=PASS");
console.log("M5_PRE_STRUCTURE_GIVEBACK_10_BOTH_STRATEGIES=PASS");
console.log("M5_PRE_STRUCTURE_REQUIRES_BE_OR_BETTER=PASS");
console.log("M5_PRE_STRUCTURE_HANDOFF_AFTER_ACCEPTED_TIGHTEN=PASS");
console.log("M5_PRE_STRUCTURE_CYCLIC_HANDOFF=PASS");
console.log("M5_PRE_STRUCTURE_NEW_STRUCTURE_AFTER_REACTIVATION=PASS");
console.log("M5_PRE_STRUCTURE_NEVER_LOOSENS_STOP=PASS");
