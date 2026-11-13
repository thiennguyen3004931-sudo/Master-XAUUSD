import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

async function loadReconstructTrades() {
  const sourcePath = path.resolve("apps/api/src/services/mt5-performance.service.ts");
  const source = await readFile(sourcePath, "utf8");
  const sourceWithoutImports = source.replace(/^import[^\n]*\n/gm, "");
  const instrumented = `${sourceWithoutImports}\nexport { reconstructTrades };\n`;
  const transpiled = ts.transpileModule(instrumented, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName: sourcePath,
  }).outputText;

  const tempFile = path.join(
    tmpdir(),
    `phase7c-mt5-performance-provenance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  await writeFile(tempFile, transpiled, "utf8");
  try {
    const module = await import(`${pathToFileURL(tempFile).href}?v=${Date.now()}`);
    return module.reconstructTrades;
  } finally {
    await rm(tempFile, { force: true });
  }
}

function deal(overrides) {
  return {
    ticket: String(overrides.ticket),
    orderTicket: String(overrides.orderTicket ?? overrides.ticket),
    positionId: "91001",
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

async function reconstruct(openings) {
  const reconstructTrades = await loadReconstructTrades();
  const t0 = Date.UTC(2026, 7, 31, 1, 0, 0);
  const deals = openings.map((opening, index) => deal({
    ticket: String(201 + index),
    timestamp: t0 + index * 60_000,
    entry: "IN",
    side: "BUY",
    volume: 0.5,
    price: 2000 + index,
    ...opening,
  }));
  deals.push(deal({
    ticket: "299",
    timestamp: t0 + openings.length * 60_000,
    entry: "OUT",
    side: "SELL",
    volume: openings.length * 0.5,
    price: 2010,
    magic: 0,
    comment: "broker-close",
  }));
  const trades = reconstructTrades(deals, 270715, 270714);
  assert.equal(trades.length, 1);
  return trades[0];
}

test("homogeneous Trend scale-in remains SYSTEM TREND", async () => {
  const trade = await reconstruct([
    { magic: 270715, comment: "phase7b-demo-trend" },
    { magic: 270715, comment: "phase7b-demo-trend-add" },
  ]);
  assert.equal(trade.ownership, "SYSTEM");
  assert.equal(trade.strategy, "TREND");
});

test("validation participation makes the reconstructed leg VALIDATION", async () => {
  const trade = await reconstruct([
    { magic: 270715, comment: "phase7b-demo-trend" },
    { magic: 270715, comment: "gate2-phase7b-demo-trend" },
  ]);
  assert.equal(trade.ownership, "VALIDATION");
  assert.equal(trade.strategy, "TREND");
});

test("mixed Trend and Sideway openings fail closed to OTHER ownership and strategy", async () => {
  const trade = await reconstruct([
    { magic: 270715, comment: "phase7b-demo-trend" },
    { magic: 270714, comment: "phase7c-sideway-add" },
  ]);
  assert.equal(trade.ownership, "OTHER");
  assert.equal(trade.strategy, "OTHER");
});
