import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const servicePath = path.join(
  repo,
  "apps",
  "api",
  "src",
  "services",
  "mt5-performance.service.ts",
);

const source = fs.readFileSync(servicePath, "utf8");

/*
 * Regression:
 *
 * The performance service already asks the MT5 bridge for the
 * canonical requested symbol:
 *
 *   getMt5DealHistory(..., "XAUUSD")
 *
 * The bridge is allowed to resolve that canonical symbol to the
 * broker-specific symbol, e.g. XAUUSD.G.
 *
 * Therefore the performance layer must not discard returned deals
 * solely because deal.symbol !== canonical "XAUUSD".
 */

assert.match(
  source,
  /getMt5DealHistory\s*\(\s*fromMs\s*,\s*brokerNow\s*,\s*normalizedSymbol\s*\)/s,
  "precondition: performance service must request deal history with normalizedSymbol",
);

const strictReturnedSymbolFilter =
  /\.filter\s*\(\s*\(deal\)\s*=>\s*deal\.isTradingDeal\s*&&\s*deal\.symbol\s*===\s*normalizedSymbol\s*\)/s;

assert.doesNotMatch(
  source,
  strictReturnedSymbolFilter,
  [
    "BUG: performance service rejects broker-resolved symbol aliases.",
    "A canonical XAUUSD history request may legitimately return",
    "deal.symbol=XAUUSD.G. Those deals must remain eligible for",
    "reconstructTrades().",
  ].join(" "),
);

console.log(
  "MT5_PERFORMANCE_SYMBOL_ALIAS_REGRESSION=PASS",
);
