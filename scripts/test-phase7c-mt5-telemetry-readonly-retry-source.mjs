import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const sourcePath = path.resolve("apps/api/src/services/mt5.service.ts");
const source = fs.readFileSync(sourcePath, "utf8");

test("MT5 telemetry retries transient read failures without enabling trading", () => {
  assert.match(
    source,
    /retryAttempts:\s*readPositiveInteger\("MT5_TELEMETRY_RETRY_ATTEMPTS",\s*1\)/,
    "telemetry must default to one bounded retry"
  );
  assert.match(
    source,
    /requireTradingEnabled:\s*false/,
    "telemetry client must remain read-only"
  );
  assert.match(
    source,
    /config\.retryAttempts/,
    "cached client signature must include retryAttempts"
  );
  assert.doesNotMatch(
    source,
    /retryAttempts:\s*(?:[2-9]|[1-9]\d+)/,
    "source must not hard-code an aggressive retry count"
  );
});
