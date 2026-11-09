import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadPerformanceSnapshotWithFixtures({ telemetry, deals }) {
  const sourcePath = path.resolve("apps/api/src/services/mt5-performance.service.ts");
  const source = await readFile(sourcePath, "utf8");
  const sourceWithoutImports = source.replace(/^import[^\n]*\n/gm, "");
  const instrumented = `
const __telemetry = ${JSON.stringify(telemetry)};
const __deals = ${JSON.stringify(deals)};
async function getMt5Telemetry() { return __telemetry; }
async function getPhase7CCanonicalDeals(input) {
  return __deals.filter((deal) => deal.timestamp >= input.fromMs && deal.timestamp < input.toMs);
}
function resolvePhase7CDailyRecoveryMagicNumbers() {
  return { trendMagicNumber: 270715, sidewayMagicNumber: 270714, configuredMagicNumbers: [270715, 270714] };
}
${sourceWithoutImports}
`;
  const transpiled = ts.transpileModule(instrumented, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName: sourcePath,
  }).outputText;

  const tempFile = path.join(
    tmpdir(),
    `phase7c-mt5-performance-period-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  await writeFile(tempFile, transpiled, "utf8");
  try {
    const module = await import(`${pathToFileURL(tempFile).href}?v=${Date.now()}`);
    return module.getMt5PerformanceSnapshot;
  } finally {
    await rm(tempFile, { force: true });
  }
}

function deal(overrides) {
  return {
    ticket: String(overrides.ticket),
    orderTicket: String(overrides.orderTicket ?? overrides.ticket),
    positionId: String(overrides.positionId),
    timestamp: 0,
    symbol: "XAUUSD",
    side: null,
    entry: "UNKNOWN",
    volume: 0,
    price: 0,
    profit: 0,
    commission: 0,
    swap: 0,
    fee: 0,
    netPnl: 0,
    magic: 270715,
    comment: "phase7b-demo-trend",
    reason: null,
    isTradingDeal: true,
    ...overrides,
  };
}

test("performance period includes trades closed inside the window even when their opening deal is before the window", async () => {
  const brokerNow = Date.UTC(2026, 7, 31, 0, 0, 0);
  const periodStart = brokerNow - 7 * DAY_MS;
  const fixtures = [
    // Closed before the selected period: must stay excluded even if history is
    // widened to reconstruct carry-in positions.
    deal({ ticket: "101", positionId: "10001", timestamp: brokerNow - 10 * DAY_MS, entry: "IN", side: "BUY", volume: 0.1, price: 3300 }),
    deal({ ticket: "102", positionId: "10001", timestamp: brokerNow - 9 * DAY_MS, entry: "OUT", side: "SELL", volume: 0.1, price: 3310, netPnl: 20 }),

    // Carry-in trade: opening is before the selected period, closing is inside.
    deal({ ticket: "201", positionId: "20001", timestamp: brokerNow - 8 * DAY_MS, entry: "IN", side: "BUY", volume: 0.1, price: 3320 }),
    deal({ ticket: "202", positionId: "20001", timestamp: brokerNow - 6 * DAY_MS, entry: "OUT", side: "SELL", volume: 0.1, price: 3330, netPnl: 12 }),

    // Ordinary trade fully inside the selected period.
    deal({ ticket: "301", positionId: "30001", timestamp: brokerNow - 2 * DAY_MS, entry: "IN", side: "SELL", volume: 0.1, price: 3340 }),
    deal({ ticket: "302", positionId: "30001", timestamp: brokerNow - 1 * DAY_MS, entry: "OUT", side: "BUY", volume: 0.1, price: 3345, netPnl: -5 }),
  ];

  const getMt5PerformanceSnapshot = await loadPerformanceSnapshotWithFixtures({
    telemetry: {
      reachable: true,
      message: "ok",
      accountLogin: 123456,
      health: {
        connected: true,
        accountMode: "real",
        tradingEnabled: false,
        accountBalance: 10000,
        accountCurrency: "USD",
        server: "Synthetic-Live",
      },
      quote: { timestamp: brokerNow },
    },
    deals: fixtures,
  });

  const snapshot = await getMt5PerformanceSnapshot(7, "XAUUSD");

  assert.equal(periodStart, brokerNow - 7 * DAY_MS);
  assert.equal(snapshot.accountWide.metrics.totalTrades, 2, "the selected period is based on completed trades, not opening-deal timestamps");
  assert.equal(snapshot.accountWide.metrics.netPnl, 7);
  assert.deepEqual(
    snapshot.trades.map((trade) => ({ id: trade.id, closedAt: trade.closedAt, netPnl: trade.netPnl })),
    [
      { id: "mt5-30001", closedAt: brokerNow - 1 * DAY_MS, netPnl: -5 },
      { id: "mt5-20001", closedAt: brokerNow - 6 * DAY_MS, netPnl: 12 },
    ],
    "a carry-in opening must be available for reconstruction while trades closed before the requested period stay excluded",
  );
});
