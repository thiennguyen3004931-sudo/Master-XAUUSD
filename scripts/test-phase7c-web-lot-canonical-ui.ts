import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfiguredLotSettings } from "../apps/web/src/phase7c-lot-settings.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertLot(
  actual: ReturnType<typeof resolveConfiguredLotSettings>,
  expected: { trendFixedLot: number; sidewayRiskPercent: number; sidewayMaxLot: number },
  label: string,
) {
  assert(actual !== null, `${label}: expected a resolved lot profile`);
  assert(actual.trendFixedLot === expected.trendFixedLot, `${label}: trendFixedLot mismatch`);
  assert(actual.sidewayRiskPercent === expected.sidewayRiskPercent, `${label}: sidewayRiskPercent mismatch`);
  assert(actual.sidewayMaxLot === expected.sidewayMaxLot, `${label}: sidewayMaxLot mismatch`);
}

const canonicalEnvelope = {
  trendFixedLot: 0.12,
  sidewayRiskPercent: 0.5,
  sidewayMaxLot: 0.3,
  state: {
    version: 1,
    trendFixedLot: 0.06,
    sidewayRiskPercent: 1,
    sidewayMaxLot: 0.03,
  },
};

assertLot(
  resolveConfiguredLotSettings(canonicalEnvelope, {
    configuredTrendFixedLot: 0.09,
    configuredSidewayRiskPercent: 0.25,
    configuredSidewayMaxLot: 0.12,
  }),
  { trendFixedLot: 0.06, sidewayRiskPercent: 1, sidewayMaxLot: 0.03 },
  "canonical nested state wins",
);

assertLot(
  resolveConfiguredLotSettings({}, {
    configuredTrendFixedLot: 0.09,
    configuredSidewayRiskPercent: 0.25,
    configuredSidewayMaxLot: 0.12,
  }),
  { trendFixedLot: 0.09, sidewayRiskPercent: 0.25, sidewayMaxLot: 0.12 },
  "compatibility configuration fallback",
);

assert(
  resolveConfiguredLotSettings({}, {}) === null,
  "missing configured sources must return null instead of inventing trading values",
);

assert(
  resolveConfiguredLotSettings({ state: { trendFixedLot: 0.06, sidewayRiskPercent: 1 } }, {}) === null,
  "partial canonical state must not be treated as a complete configured profile",
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = path.join(root, "apps/web/src/pages/Phase7BOpsPage.tsx");
const page = fs.readFileSync(pagePath, "utf8");

for (const needle of [
  'import { resolveConfiguredLotSettings } from "../phase7c-lot-settings";',
  "const resolvedConfiguredLot = resolveConfiguredLotSettings(data?.lotSettings, configuration);",
  "const hasConfiguredLot = resolvedConfiguredLot !== null;",
]) {
  assert(page.includes(needle), `Phase7BOpsPage canonical lot wiring missing: ${needle}`);
}

for (const forbidden of [
  'useState("0.12")',
  'useState("1")',
  'useState("0.30")',
  "configuredLot.trendFixedLot ?? configuration.configuredTrendFixedLot ?? 0.12",
  "configuredLot.sidewayMaxLot ?? configuration.configuredSidewayMaxLot ?? 0.3",
]) {
  assert(!page.includes(forbidden), `Phase7BOpsPage still contains invented lot fallback: ${forbidden}`);
}

console.log("PHASE7C_WEB_LOT_CANONICAL_UI_TEST=PASS");
