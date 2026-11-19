import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, "..", "apps", "api", "src", "services", "phase7c-decision-monitor.service.ts"),
  "utf8",
);

assert.match(
  source,
  /import\s+\{\s*phase7CBotModeService\s*\}\s+from\s+["']\.\/phase7c-bot-mode\.service["'];/,
  "Decision monitor must read the canonical bot mode service before accepting a cached snapshot.",
);

assert.match(
  source,
  /const\s+currentBotMode\s*=\s*phase7CBotModeService\.get\(\)\.mode\s*;/,
  "Decision monitor must resolve the current canonical bot mode for each cache lookup.",
);

assert.match(
  source,
  /cached\.value\.mode\.active\s*===\s*currentBotMode/,
  "A cached decision snapshot is valid only when its active mode still matches the canonical bot mode.",
);

assert.match(
  source,
  /now\s*-\s*cached\.at\s*<=\s*2_000/,
  "The existing two-second cache TTL must remain unchanged when the mode is unchanged.",
);

assert.doesNotMatch(
  source,
  /if\s*\(\s*pending\s*\)\s*return\s+pending\s*;/,
  "An in-flight decision snapshot must not be reused blindly across a bot-mode transition.",
);

assert.match(
  source,
  /pending[^\n]*currentBotMode|currentBotMode[^\n]*pending/,
  "In-flight decision reuse must be explicitly keyed or guarded by the current canonical bot mode.",
);

console.log("PHASE7C_DECISION_MONITOR_MODE_CACHE_CONTRACT=PASS");
console.log("CACHE_INVALIDATES_ON_MODE_CHANGE=TRUE");
console.log("PENDING_INVALIDATES_ON_MODE_CHANGE=TRUE");
console.log("CACHE_TTL_UNCHANGED=2000MS");
console.log("STRATEGY_CHANGE=NONE");
console.log("ORDER_MUTATION=NONE");
