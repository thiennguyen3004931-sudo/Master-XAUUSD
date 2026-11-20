import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = readFileSync(resolve(root, "apps/api/src/services/phase7c-backtest-evaluator.service.ts"), "utf8");
const route = readFileSync(resolve(root, "apps/api/src/routes/phase7c-backtest-evaluator.route.ts"), "utf8");
const web = readFileSync(resolve(root, "apps/web/src/pages/Phase7CBacktestEvaluatorPage.tsx"), "utf8");

test("Phase7C synthetic evaluator response always states its provenance (#75)", () => {
  const implementation = api.slice(api.indexOf("export function runPhase7CBacktestEvaluator("));
  assert.match(api, /dataStatus: "SYNTHETIC_ILLUSTRATION_ONLY"/);
  assert.match(implementation, /provenance:\s*\{/);
  for (const field of [
    "brokerEvidenceVerified", "historicalCandlesUsed", "brokerDealsUsed",
    "forwardPerformanceVerified", "liveReadinessEvidence",
  ]) {
    assert.match(implementation, new RegExp(field + ": false"));
  }
  assert.match(route, /runPhase7CBacktestEvaluator\(/);
  assert.match(api, /const baseWinRate =/); // This remains an assumption-based illustration.
});

test("synthetic tab warns at all times and never shows metrics without provenance", () => {
  assert.match(web, /CHỈ SỐ MINH HỌA — KHÔNG PHẢI LỊCH SỬ GIAO DỊCH/);
  assert.match(web, /data\.provenance\?\.brokerEvidenceVerified !== false/);
  assert.match(web, /data\?\.provenance\?\.dataStatus === "SYNTHETIC_ILLUSTRATION_ONLY"/);
  assert.match(web, /Win Rate minh họa/);
  assert.match(web, /không phải Equity thực/);
  assert.doesNotMatch(web, /Kiểm thử lịch sử XAUUSD, đối chiếu hiệu suất thực tế/);
});
