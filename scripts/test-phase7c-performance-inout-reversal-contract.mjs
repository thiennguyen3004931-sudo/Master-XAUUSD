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
    `phase7c-mt5-performance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
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
    positionId: "90001",
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

test("reconstructTrades splits an INOUT reversal into the closed leg and opposite residual leg", async () => {
  const reconstructTrades = await loadReconstructTrades();
  const t0 = Date.UTC(2026, 7, 26, 9, 0, 0);

  const trades = reconstructTrades(
    [
      deal({ ticket: "101", timestamp: t0, entry: "IN", side: "BUY", volume: 1, price: 2000 }),
      deal({ ticket: "102", timestamp: t0 + 60_000, entry: "INOUT", side: "SELL", volume: 1.5, price: 2010 }),
      deal({ ticket: "103", timestamp: t0 + 120_000, entry: "OUT", side: "BUY", volume: 0.5, price: 2005 }),
    ],
    270715,
    270714,
  );

  assert.equal(trades.length, 2, "a reversal with residual volume must reconstruct two completed trade legs");

  const chronological = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  assert.deepEqual(
    chronological.map(({ side, volume, entry, exit, openedAt, closedAt }) => ({ side, volume, entry, exit, openedAt, closedAt })),
    [
      { side: "BUY", volume: 1, entry: 2000, exit: 2010, openedAt: t0, closedAt: t0 + 60_000 },
      { side: "SELL", volume: 0.5, entry: 2010, exit: 2005, openedAt: t0 + 60_000, closedAt: t0 + 120_000 },
    ],
  );
});
