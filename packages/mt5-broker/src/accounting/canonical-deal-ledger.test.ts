import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Mt5BridgeDeal } from "../models/Mt5BridgeDeal";
import {
  CanonicalDealLedger,
  type CanonicalDealLedgerStore,
} from "./canonical-deal-ledger";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fileStore(label: string): CanonicalDealLedgerStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phase7c-ledger-${label}-`));
  const filePath = path.join(dir, "canonical-deal-ledger.json");
  tempDirs.push(dir);

  return {
    load() {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    },
    save(serializedState) {
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, serializedState, "utf8");
      fs.renameSync(tempPath, filePath);
    },
  };
}

function deal(overrides: Partial<Mt5BridgeDeal> = {}): Mt5BridgeDeal {
  return {
    ticket: "1001",
    orderId: "2001",
    positionId: "3001",
    symbol: "XAUUSD",
    side: "BUY",
    entry: "OUT",
    volume: 0.04,
    price: 4705,
    profit: 10,
    commission: -1,
    swap: -0.5,
    fee: -0.25,
    netPnl: 999,
    magic: 270715,
    comment: "phase7c",
    timestamp: Date.UTC(2026, 7, 29, 2, 0, 0),
    isTradingDeal: true,
    ...overrides,
  };
}

describe("CanonicalDealLedger identity and durability", () => {
  it("deduplicates by account + MT5 deal ticket while allowing the same ticket on another account", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("identity") });
    const original = deal();

    expect(ledger.mergeBackfill("LIVE:10001", [original, original])).toEqual({ inserted: 1, total: 1 });
    expect(ledger.mergeBackfill("LIVE:10001", [original])).toEqual({ inserted: 0, total: 1 });
    expect(ledger.mergeBackfill("DEMO:10001", [original])).toEqual({ inserted: 1, total: 2 });
  });

  it("restores persisted deals after restart without duplicating a replayed backfill", () => {
    const store = fileStore("restart");
    const first = new CanonicalDealLedger({ store });
    first.mergeBackfill("LIVE:10001", [deal({ ticket: "1101" }), deal({ ticket: "1102" })]);

    const restarted = new CanonicalDealLedger({ store });
    expect(restarted.size).toBe(2);
    expect(
      restarted.mergeBackfill("LIVE:10001", [deal({ ticket: "1101" }), deal({ ticket: "1102" })]),
    ).toEqual({ inserted: 0, total: 2 });
  });

  it("persists an authoritative correction when the same account + MT5 deal ticket is replayed", () => {
    const store = fileStore("authoritative-replay");
    const first = new CanonicalDealLedger({ store });

    first.mergeBackfill("LIVE:10001", [deal({ ticket: "1150", symbol: "XAUUSD.G" })]);
    expect(
      first.mergeBackfill("LIVE:10001", [deal({ ticket: "1150", symbol: "XAUUSD" })]),
    ).toEqual({ inserted: 0, total: 1 });
    expect(first.deals()).toHaveLength(1);
    expect(first.deals()[0]?.symbol).toBe("XAUUSD");

    const restarted = new CanonicalDealLedger({ store });
    expect(restarted.deals()).toHaveLength(1);
    expect(restarted.deals()[0]?.symbol).toBe("XAUUSD");
  });

  it("merges historical deals that arrive older than already persisted deals without a timestamp cursor", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("historical") });
    const newer = deal({ ticket: "1202", timestamp: Date.UTC(2026, 7, 29, 9) });
    const older = deal({ ticket: "1201", timestamp: Date.UTC(2026, 7, 28, 9) });

    ledger.mergeBackfill("LIVE:10001", [newer]);
    expect(ledger.mergeBackfill("LIVE:10001", [older])).toEqual({ inserted: 1, total: 2 });
    expect(ledger.deals().map((item) => item.ticket)).toEqual(["1201", "1202"]);
  });
});

describe("CanonicalDealLedger accounting", () => {
  it("computes canonical netPnl from profit + commission + swap + fee and never trusts bridge netPnl", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("components") });
    ledger.mergeBackfill("LIVE:10001", [
      deal({ profit: 10, commission: -1.25, swap: -0.5, fee: -0.25, netPnl: 777 }),
    ]);

    const [stored] = ledger.deals();
    expect(stored.netPnl).toBe(8);
    expect(
      ledger.summarize({
        account: "LIVE:10001",
        symbol: "XAUUSD",
        ownedMagics: [270715, 270714],
        from: Date.UTC(2026, 7, 29, 0),
        to: Date.UTC(2026, 7, 30, 0),
      }),
    ).toEqual({ dealCount: 1, dailyNetPnl: 8 });
  });

  it("isolates daily P&L by account + symbol + owned magic + broker-day", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("isolation") });
    const dayStart = Date.UTC(2026, 7, 29, 0);
    const dayEnd = Date.UTC(2026, 7, 30, 0);

    ledger.mergeBackfill("LIVE:10001", [
      deal({ ticket: "1301", profit: 10, commission: 0, swap: 0, fee: 0, timestamp: dayStart + 1 }),
      deal({ ticket: "1302", magic: 999999, profit: 100, commission: 0, swap: 0, fee: 0, timestamp: dayStart + 2 }),
      deal({ ticket: "1303", symbol: "EURUSD", profit: 100, commission: 0, swap: 0, fee: 0, timestamp: dayStart + 3 }),
      deal({ ticket: "1304", profit: 100, commission: 0, swap: 0, fee: 0, timestamp: dayEnd + 1 }),
      deal({ ticket: "1305", isTradingDeal: false, profit: 100, commission: 0, swap: 0, fee: 0, timestamp: dayStart + 4 }),
    ]);
    ledger.mergeBackfill("DEMO:10001", [
      deal({ ticket: "1306", profit: 100, commission: 0, swap: 0, fee: 0, timestamp: dayStart + 5 }),
    ]);

    expect(
      ledger.summarize({
        account: "LIVE:10001",
        symbol: "XAUUSD",
        ownedMagics: [270715, 270714],
        from: dayStart,
        to: dayEnd,
      }),
    ).toEqual({ dealCount: 1, dailyNetPnl: 10 });
  });

  it("attributes a magic-zero close to a system-owned position even when ownership was established before the broker day", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("magic-zero-close") });
    const dayStart = Date.UTC(2026, 8, 1, 0);
    const dayEnd = Date.UTC(2026, 8, 2, 0);
    const positionId = "304565255";

    ledger.mergeBackfill("LIVE:10001", [
      deal({
        ticket: "304428974",
        orderId: positionId,
        positionId,
        side: "SELL",
        entry: "IN",
        volume: 0.12,
        price: 4351.08,
        profit: 0,
        commission: 0,
        swap: 0,
        fee: 0,
        magic: 270715,
        timestamp: dayStart - 1,
      }),
      deal({
        ticket: "304429128",
        orderId: "304565413",
        positionId,
        side: "BUY",
        entry: "OUT",
        volume: 0.12,
        price: 4345.09,
        profit: 71.88,
        commission: 0,
        swap: 0,
        fee: 0,
        magic: 0,
        comment: "",
        timestamp: dayStart + 1,
      }),
    ]);

    expect(
      ledger.summarize({
        account: "LIVE:10001",
        symbol: "XAUUSD",
        ownedMagics: [270715, 270714],
        from: dayStart,
        to: dayEnd,
      }),
    ).toEqual({ dealCount: 1, dailyNetPnl: 71.88 });

    const closes = ledger.realizedClosingDeals({
      account: "LIVE:10001",
      positionId,
      symbol: "XAUUSD",
      ownedMagics: [270715, 270714],
    });
    expect(closes.map((item) => item.ticket)).toEqual(["304429128"]);
    expect(closes.map((item) => item.netPnl)).toEqual([71.88]);
  });

  it("keeps magic-zero closes fail-closed when the position has no system-owned provenance", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("magic-zero-foreign") });
    const dayStart = Date.UTC(2026, 8, 1, 0);
    const dayEnd = Date.UTC(2026, 8, 2, 0);

    ledger.mergeBackfill("LIVE:10001", [
      deal({
        ticket: "1350",
        positionId: "FOREIGN",
        entry: "IN",
        magic: 999999,
        profit: 0,
        commission: 0,
        swap: 0,
        fee: 0,
        timestamp: dayStart - 1,
      }),
      deal({
        ticket: "1351",
        positionId: "FOREIGN",
        entry: "OUT",
        magic: 0,
        profit: 250,
        commission: 0,
        swap: 0,
        fee: 0,
        timestamp: dayStart + 1,
      }),
      deal({
        ticket: "1352",
        positionId: "OWNED",
        entry: "OUT",
        magic: 270715,
        profit: 10,
        commission: 0,
        swap: 0,
        fee: 0,
        timestamp: dayStart + 2,
      }),
    ]);

    expect(
      ledger.summarize({
        account: "LIVE:10001",
        symbol: "XAUUSD",
        ownedMagics: [270715, 270714],
        from: dayStart,
        to: dayEnd,
      }),
    ).toEqual({ dealCount: 1, dailyNetPnl: 10 });

    expect(
      ledger.realizedClosingDeals({
        account: "LIVE:10001",
        positionId: "FOREIGN",
        symbol: "XAUUSD",
        ownedMagics: [270715, 270714],
      }),
    ).toEqual([]);
  });

  it("returns all actual MT5 closing deals for multiple partials and the final exit of one position", () => {
    const ledger = new CanonicalDealLedger({ store: fileStore("position") });
    ledger.mergeBackfill("LIVE:10001", [
      deal({ ticket: "1400", positionId: "P-1", entry: "IN", volume: 0.12, timestamp: 100 }),
      deal({ ticket: "1401", positionId: "P-1", entry: "OUT", volume: 0.04, profit: 4, commission: -0.1, swap: 0, fee: 0, timestamp: 200 }),
      deal({ ticket: "1402", positionId: "P-1", entry: "OUT", volume: 0.03, profit: 3, commission: -0.1, swap: 0, fee: 0, timestamp: 300 }),
      deal({ ticket: "1403", positionId: "P-1", entry: "OUT", volume: 0.05, profit: 5, commission: -0.1, swap: -0.2, fee: 0, timestamp: 400 }),
      deal({ ticket: "1499", positionId: "OTHER", entry: "OUT", timestamp: 500 }),
    ]);

    const closes = ledger.realizedClosingDeals({
      account: "LIVE:10001",
      positionId: "P-1",
      symbol: "XAUUSD",
      ownedMagics: [270715, 270714],
    });

    expect(closes.map((item) => item.ticket)).toEqual(["1401", "1402", "1403"]);
    expect(closes.map((item) => item.volume)).toEqual([0.04, 0.03, 0.05]);
    expect(closes.map((item) => item.netPnl)).toEqual([3.9, 2.9, 4.7]);
  });
});
