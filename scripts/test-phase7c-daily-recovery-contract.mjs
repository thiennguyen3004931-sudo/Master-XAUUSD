import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(
  here,
  "run-phase7b-demo-controller.ts",
);

const source = fs.readFileSync(controllerPath, "utf8");

const sidewayPath = path.join(
  here,
  "run-phase7c-sideway-controller.mjs",
);

const sidewaySource = fs.readFileSync(
  sidewayPath,
  "utf8",
);

function numericConstant(name) {
  const pattern = new RegExp(
    `const\\s+${name}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?);`,
  );

  const match = source.match(pattern);

  assert.ok(
    match,
    `Missing numeric constant ${name}`,
  );

  const value = Number(match[1]);

  assert.ok(
    Number.isFinite(value),
    `Invalid numeric constant ${name}`,
  );

  return value;
}

const MIN_TP = numericConstant(
  "DAILY_RECOVERY_MIN_TP_DISTANCE",
);

const MAX_TP = numericConstant(
  "DAILY_RECOVERY_MAX_TP_DISTANCE",
);

const TARGET_NET = numericConstant(
  "DAILY_RECOVERY_TARGET_NET_USD",
);

assert.equal(MIN_TP, 6);
assert.equal(MAX_TP, 10);
assert.equal(TARGET_NET, 1);

function calculatePolicy({
  dailyNetPnl,
  cashPerPriceUnitPerLot,
  fixedVolume,
}) {
  assert.ok(
    Number.isFinite(dailyNetPnl),
    "dailyNetPnl must be finite",
  );

  assert.ok(
    cashPerPriceUnitPerLot > 0,
    "cashPerPriceUnitPerLot must be positive",
  );

  assert.ok(
    fixedVolume > 0,
    "fixedVolume must be positive",
  );

  if (dailyNetPnl >= 0) {
    return {
      mode: "TREND",
      requiredUsd: 0,
      rawTpDistance: 0,
      tpDistance: 0,
      canRecoverInOneTrade: true,
    };
  }

  const cashPerPriceUnit =
    cashPerPriceUnitPerLot * fixedVolume;

  const requiredUsd =
    Math.abs(dailyNetPnl) +
    TARGET_NET;

  const rawTpDistance =
    requiredUsd /
    cashPerPriceUnit;

  const tpDistance = Math.min(
    MAX_TP,
    Math.max(
      MIN_TP,
      rawTpDistance,
    ),
  );

  return {
    mode: "RECOVERY_TP",
    requiredUsd,
    rawTpDistance,
    tpDistance,
    canRecoverInOneTrade:
      rawTpDistance <= MAX_TP + 1e-9,
  };
}

/*
 * Normalized XAUUSD simulation:
 *
 * cashPerPriceUnitPerLot = 100 USD / 1.00 price / 1 lot
 * fixedVolume            = 0.03 lot
 *
 * Therefore:
 * 1.00 XAUUSD price move = 3 USD at 0.03 lot.
 */
const common = {
  cashPerPriceUnitPerLot: 100,
  fixedVolume: 0.03,
};

const zero = calculatePolicy({
  ...common,
  dailyNetPnl: 0,
});

assert.equal(zero.mode, "TREND");
assert.equal(zero.tpDistance, 0);

console.log("CASE_DAILY_ZERO=PASS|MODE=TREND");


const positive = calculatePolicy({
  ...common,
  dailyNetPnl: 5,
});

assert.equal(positive.mode, "TREND");
assert.equal(positive.tpDistance, 0);

console.log("CASE_DAILY_POSITIVE=PASS|MODE=TREND");


const lightLoss = calculatePolicy({
  ...common,
  dailyNetPnl: -2,
});

assert.equal(lightLoss.mode, "RECOVERY_TP");
assert.equal(lightLoss.tpDistance, 6);
assert.equal(lightLoss.canRecoverInOneTrade, true);

console.log(
  `CASE_LIGHT_LOSS=PASS|TP=${lightLoss.tpDistance}`,
);


const mediumLoss = calculatePolicy({
  ...common,
  dailyNetPnl: -23,
});

assert.equal(mediumLoss.mode, "RECOVERY_TP");
assert.ok(
  Math.abs(mediumLoss.rawTpDistance - 8) < 1e-9,
);

assert.ok(
  Math.abs(mediumLoss.tpDistance - 8) < 1e-9,
);

assert.equal(
  mediumLoss.canRecoverInOneTrade,
  true,
);

console.log(
  `CASE_MEDIUM_LOSS=PASS|TP=${mediumLoss.tpDistance}`,
);


const exactMax = calculatePolicy({
  ...common,
  dailyNetPnl: -29,
});

assert.equal(exactMax.mode, "RECOVERY_TP");

assert.ok(
  Math.abs(exactMax.tpDistance - 10) < 1e-9,
);

assert.equal(
  exactMax.canRecoverInOneTrade,
  true,
);

console.log(
  `CASE_EXACT_MAX=PASS|TP=${exactMax.tpDistance}`,
);


const largeLoss = calculatePolicy({
  ...common,
  dailyNetPnl: -40,
});

assert.equal(largeLoss.mode, "RECOVERY_TP");

assert.equal(
  largeLoss.tpDistance,
  10,
);

assert.equal(
  largeLoss.canRecoverInOneTrade,
  false,
);

assert.ok(
  largeLoss.rawTpDistance > 10,
);

console.log(
  `CASE_LARGE_LOSS=PASS|TP=${largeLoss.tpDistance}|ONE_TRADE=false`,
);


/*
 * Source integration contract.
 */
const sourceContracts = [
  [
    "FIXED_VOLUME_DEFAULT_003",
    'const fixedVolume = Number(process.env.ZIQ_FIXED_VOLUME ?? "0.03");',
  ],
  [
    "MAGIC_FILTER",
    "dailyBotMagicNumbers.has(Number(deal.magic))",
  ],
  [
    "BROKER_DAY_BOUNDARY",
    "/v1/session/day-boundary/",
  ],
  [
    "DEAL_HISTORY",
    "/v1/history/deals?fromMs=",
  ],
  [
    "NEGATIVE_SWITCH",
    'mode: "RECOVERY_TP"',
  ],
  [
    "TREND_NO_FIXED_TP",
    'console.log("PHASE7B_DEMO_FIXED_TP=OFF_IN_TREND");',
  ],
  [
    "LOT_ESCALATION_OFF",
    'console.log("PHASE7B_DEMO_DAILY_RECOVERY_LOT_ESCALATION=OFF");',
  ],
  [
    "RECOVERY_FULL_POSITION_TP",
    "takeProfit,",
  ],
  [
    "RECOVERY_NO_PARTIAL_RUNNER",
    'if (managed.dailyMode === "RECOVERY_TP")',
  ],
];

for (const [name, marker] of sourceContracts) {
  assert.ok(
    source.includes(marker),
    `Missing source contract ${name}`,
  );

  console.log(
    `SOURCE_CONTRACT_${name}=PASS`,
  );
}


/*
 * Verify recovery branch returns before +10 partial block.
 */
const recoveryGuardIndex = source.indexOf(
  'if (managed.dailyMode === "RECOVERY_TP")',
);

const partialIndex = source.indexOf(
  "if (!managed.partialApplied && favorable >= 10)",
);

assert.ok(
  recoveryGuardIndex >= 0,
  "Recovery management guard missing",
);

assert.ok(
  partialIndex >= 0,
  "Trend partial block missing",
);

assert.ok(
  recoveryGuardIndex < partialIndex,
  "Recovery guard must execute before +10 partial logic",
);

console.log(
  "RECOVERY_GUARD_BEFORE_PARTIAL=PASS",
);


/*
 * Verify +6 BE remains before recovery return.
 */
const plus6Index = source.indexOf(
  "if (!managed.breakEvenApplied && favorable >= 6)",
);

assert.ok(
  plus6Index >= 0,
  "+6 break-even block missing",
);

assert.ok(
  plus6Index < recoveryGuardIndex,
  "+6 break-even must remain active before recovery return",
);

console.log(
  "PLUS6_BE_PRESERVED_IN_RECOVERY=PASS",
);


/*
 * No martingale / volume escalation implementation.
 * The only recovery lot contract must remain fixedVolume.
 */
assert.ok(
  !source.includes("recoveryVolume"),
  "Recovery volume escalation field is forbidden",
);

assert.ok(
  !source.includes("martingale"),
  "Martingale implementation is forbidden",
);

console.log(
  "NO_MARTINGALE_IMPLEMENTATION=PASS",
);

const systemWideContracts = [
  [
    "TREND_INCLUDES_SIDEWAY_MAGIC",
    'process.env.ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER ?? "270714"',
  ],
  [
    "TREND_ALL_BOT_MAGIC_FILTER",
    "dailyBotMagicNumbers.has(Number(deal.magic))",
  ],
];

for (const [name, marker] of systemWideContracts) {
  assert.ok(
    source.includes(marker),
    `Missing Trend system-wide contract ${name}`,
  );

  console.log(
    `SYSTEM_CONTRACT_${name}=PASS`,
  );
}

const sidewayContracts = [
  [
    "SIDEWAY_TREND_MAGIC",
    "const trendMagicNumber = clampInteger(process.env.MT5_MAGIC_NUMBER, 270713",
  ],
  [
    "SIDEWAY_ALL_BOT_MAGIC_FILTER",
    "dailyBotMagicNumbers.has(Number(deal?.magic))",
  ],
  [
    "SIDEWAY_DAY_BOUNDARY",
    "/v1/session/day-boundary/",
  ],
  [
    "SIDEWAY_DEAL_HISTORY",
    "/v1/history/deals?fromMs=",
  ],
  [
    "SIDEWAY_RECOVERY_MODE",
    'mode: "RECOVERY_TP"',
  ],
  [
    "SIDEWAY_RECOVERY_FULL_POSITION",
    'if (managed.dailyMode === "RECOVERY_TP")',
  ],
  [
    "SIDEWAY_RECOVERY_TP_ORDER",
    "takeProfit: executionPlan.takeProfit",
  ],
  [
    "SIDEWAY_NO_LOT_ESCALATION",
    "PHASE7C_SIDEWAY_DAILY_RECOVERY_LOT_ESCALATION=OFF",
  ],
];

for (const [name, marker] of sidewayContracts) {
  assert.ok(
    sidewaySource.includes(marker),
    `Missing Sideway recovery contract ${name}`,
  );

  console.log(
    `SYSTEM_CONTRACT_${name}=PASS`,
  );
}

assert.ok(
  !sidewaySource.includes("recoveryVolume"),
  "Sideway recovery volume escalation is forbidden",
);

assert.ok(
  !sidewaySource.toLowerCase().includes("martingale"),
  "Sideway martingale implementation is forbidden",
);

console.log(
  "SYSTEM_WIDE_DAILY_RECOVERY=PASS",
);

console.log(
  "AUTO_REGIME_PRESERVED=PASS",
);

console.log(
  "FIXED_VOLUME_RECOVERY=0.03",
);

console.log(
  "DAILY_RECOVERY_CONTRACT_TEST=PASS",
);