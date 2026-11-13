import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../apps/api/src/services/phase7c-performance-intelligence.service";

test("canonical entryConditions statuses become PASS/FAIL rule evidence", () => {
  const evidence = __test.ruleEvidence({
    entryConditions: {
      failedConditions: ["supertrendM5"],
      conditions: [
        { id: "patternM15", status: "PASS" },
        { id: "supertrendM5", status: "FAIL" },
        { id: "fvg", status: "IGNORED" },
      ],
    },
  });

  assert.deepEqual(evidence.passed, ["patternM15"]);
  assert.deepEqual(evidence.blocked, ["supertrendM5"]);
});

test("Trend fill exposes only explicit SIGNAL and POSITION identity", () => {
  const identifiers = __test.identifiersOf(
    {
      event: "ENTRY_FILLED",
      raw: {
        signalId: "trend-signal-1",
        position: { ticket: "304590358" },
      },
    },
    "ENTRY_FILLED",
  );

  assert.deepEqual(
    identifiers.map((item) => item.token).sort(),
    ["POSITION:304590358", "SIGNAL:trend-signal-1"],
  );
});

test("Sideway fill exposes explicit ORDER and POSITION identity", () => {
  const identifiers = __test.identifiersOf(
    {
      event: "ENTRY_FILLED",
      raw: {
        orderId: "p7c-sideway-123-BUY",
        position: { ticket: "4001" },
      },
    },
    "ENTRY_FILLED",
  );

  assert.deepEqual(
    identifiers.map((item) => item.token).sort(),
    ["ORDER:p7c-sideway-123-BUY", "POSITION:4001"],
  );
});

test("entry type uses canonical entryState and does not confuse recovery workflow with Daily Recovery", () => {
  assert.equal(
    __test.entryTypeOf({ setup: { entryState: "PULLBACK_ENTRY" } }, "ENTRY_FILLED", "TREND"),
    "PULLBACK",
  );
  assert.equal(
    __test.entryTypeOf({ setup: { entryState: "ENTRY_IMMEDIATE" } }, "ENTRY_FILLED", "TREND"),
    "IMMEDIATE",
  );
  assert.equal(
    __test.entryTypeOf({}, "PENDING_ENTRY_RECOVERED", "TREND"),
    "UNKNOWN",
  );
  assert.equal(
    __test.entryTypeOf({ plan: { dailyMode: "RECOVERY_TP" } }, "ENTRY_FILLED", "TREND"),
    "RECOVERY",
  );
  assert.equal(
    __test.entryTypeOf({}, "ENTRY_FILLED", "SIDEWAY"),
    "IMMEDIATE",
  );
});

test("untrusted generic ticket is not accepted outside entry fill/recovery events", () => {
  const identifiers = __test.identifiersOf(
    { event: "HOLD_POSITION", raw: { ticket: "999" } },
    "HOLD_POSITION",
  );
  assert.equal(identifiers.some((item) => item.token === "POSITION:999"), false);
});


test("Performance Intelligence v2 separates REVERSAL from TREND execution source", () => {
  assert.equal(
    __test.performanceStrategyOf(
      "TREND",
      "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND",
      "REVERSAL",
    ),
    "REVERSAL",
  );
  assert.equal(__test.performanceStrategyOf("TREND", "TREND_CONTINUATION", "TRENDING"), "TREND");
  assert.equal(__test.performanceStrategyOf("TREND", null, "REVERSAL"), "TREND");
  assert.equal(__test.performanceStrategyOf("SIDEWAY", null, "RANGING"), "SIDEWAY");
  assert.equal(
    __test.entryPolicyOf({
      lifecycle: { entryPolicy: "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND" },
    }),
    "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND",
  );
  assert.equal(
    __test.entryPolicyOf({
      entryRule: "REVERSAL_CHOCH_DIRECTION_PLUS_PATTERN_PLUS_VALID_STRUCTURE",
    }),
    "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND",
  );
  assert.equal(
    __test.entryPolicyOf({
      reversalContext: { side: "BUY", chochTimestamp: 123 },
    }),
    "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND",
  );
});

test("entry funnel keeps SIDEWAY and REVERSAL blocker statistics independent", () => {
  const source = (strategy: "TREND" | "SIDEWAY", events: unknown[]) => ({
    strategy,
    relativePath: strategy.toLowerCase() + "-decisions.jsonl",
    available: true,
    parsedRows: events.length,
    malformedRows: 0,
    events,
  });
  const event = (
    eventName: string,
    performanceStrategy: "TREND" | "SIDEWAY" | "REVERSAL",
    blockedRules: string[] = [],
    passedRules: string[] = [],
  ) => ({
    raw: {},
    index: 0,
    eventId: eventName + ":" + performanceStrategy,
    eventName,
    identifiers: [],
    passedRules,
    blockedRules,
    blockReasons: blockedRules,
    entryType: "UNKNOWN",
    regime: performanceStrategy === "REVERSAL" ? "REVERSAL" : null,
    entryPolicy: performanceStrategy === "REVERSAL"
      ? "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"
      : null,
    performanceStrategy,
  });

  const funnel = __test.buildEntryFunnel([
    source("SIDEWAY", [
      event("ENTRY_WAIT", "SIDEWAY", ["SIDEWAY_ZONE"], ["PATTERN_M15"]),
      event("ENTRY_SUBMIT", "SIDEWAY", [], ["PATTERN_M15", "STRUCTURE"]),
      event("ENTRY_FILLED", "SIDEWAY"),
    ]),
    source("TREND", [
      event("ENTRY_WAIT", "REVERSAL", ["STRUCTURAL_STOP_DISTANCE"], ["PATTERN_M15"]),
      event("ENTRY_SUBMIT", "REVERSAL", [], ["PATTERN_M15", "VALID_STRUCTURE"]),
    ]),
  ] as never);

  const sideway = funnel.find((item) => item.strategy === "SIDEWAY");
  assert.ok(sideway);
  assert.equal(sideway.blockedEvents, 1);
  assert.equal(sideway.entrySubmitEvents, 1);
  assert.equal(sideway.entryFilledEvents, 1);
  assert.deepEqual(sideway.blockedReasons[0], { rule: "SIDEWAY_ZONE", count: 1 });

  const reversal = funnel.find((item) => item.strategy === "REVERSAL");
  assert.ok(reversal);
  assert.equal(reversal.blockedEvents, 1);
  assert.equal(reversal.entrySubmitEvents, 1);
  assert.equal(reversal.entryFilledEvents, 0);
  assert.deepEqual(reversal.blockedReasons[0], { rule: "STRUCTURAL_STOP_DISTANCE", count: 1 });
});


test("entry funnel captures Sideway event-level block reasons without changing rules", () => {
  assert.deepEqual(
    __test.entryBlockReasonsOf(
      { reason: "QUOTE_STALE" },
      "ENTRY_QUOTE_FRESHNESS_BLOCK",
      [],
    ),
    ["QUOTE_STALE"],
  );
  assert.deepEqual(
    __test.entryBlockReasonsOf(
      { spread: 2.5, maxSpread: 2 },
      "ENTRY_SPREAD_BLOCK",
      [],
    ),
    ["ENTRY_SPREAD_BLOCK"],
  );
  assert.deepEqual(
    __test.entryBlockReasonsOf(
      {
        reason: "ENTRY_STRATEGY_CONDITION_BLOCK: rangeEdge,m5Confirmation",
        raw: {
          entryConditions: {
            failedConditions: ["rangeEdge", "m5Confirmation"],
          },
          reason: "rangeEdge,m5Confirmation",
        },
      },
      "ENTRY_STRATEGY_CONDITION_BLOCK",
      ["m5Confirmation", "rangeEdge"],
    ),
    ["m5Confirmation", "rangeEdge"],
  );
  assert.deepEqual(
    __test.entryBlockReasonsOf(
      {
        raw: {
          structuralStopDistance: 13.97,
        },
      },
      "WAIT_PULLBACK",
      [],
    ),
    ["WAIT_PULLBACK"],
  );
});


test("audit event timestamp normalization supports milliseconds, seconds, and ISO", () => {
  const epochMs = 1_700_000_000_000;
  assert.equal(__test.auditEventTimestampMsOf({ timestamp: epochMs }), epochMs);
  assert.equal(__test.auditEventTimestampMsOf({ timestamp: epochMs / 1000 }), epochMs);
  assert.equal(
    __test.auditEventTimestampMsOf({ timestamp: "2023-11-14T22:13:20.000Z" }),
    1_700_000_000_000,
  );
  assert.equal(__test.auditEventTimestampMsOf({ reason: "no timestamp" }), null);
});

test("Performance Intelligence audit funnel respects the requested days window", () => {
  const endAtMs = 1_700_000_000_000;
  const withinWindow = endAtMs - 2 * 24 * 60 * 60_000;
  const outsideWindow = endAtMs - 10 * 24 * 60 * 60_000;

  const event = (occurredAtMs: number, reason: string) => ({
    raw: { timestamp: occurredAtMs, reason },
    index: 0,
    eventId: reason,
    eventName: "ENTRY_WAIT",
    occurredAtMs,
    identifiers: [],
    passedRules: [],
    blockedRules: [reason],
    blockReasons: [reason],
    entryType: "UNKNOWN",
    regime: "RANGING",
    entryPolicy: null,
    performanceStrategy: "SIDEWAY",
  });

  const sources = [{
    strategy: "SIDEWAY",
    relativePath: "sideway-decisions.jsonl",
    available: true,
    parsedRows: 3,
    malformedRows: 0,
    events: [
      event(withinWindow, "CURRENT_BLOCKER"),
      event(outsideWindow, "HISTORICAL_BLOCKER"),
      { ...event(withinWindow, "MISSING_TIMESTAMP"), occurredAtMs: null },
    ],
  }];

  const windowed = __test.filterAuditSourcesByWindow(sources as never, 7, endAtMs);
  assert.equal(windowed[0]?.events.length, 1);
  assert.equal(windowed[0]?.events[0]?.blockReasons[0], "CURRENT_BLOCKER");

  const funnel = __test.buildEntryFunnel(windowed as never);
  const sideway = funnel.find((item) => item.strategy === "SIDEWAY");
  assert.ok(sideway);
  assert.equal(sideway.blockedEvents, 1);
  assert.deepEqual(sideway.blockedReasons, [{ rule: "CURRENT_BLOCKER", count: 1 }]);
});

test("Sideway M5 confirmation age is read from persisted evidence and conflicts fail closed", () => {
  assert.equal(
    __test.confirmationAgeBarsOf({ raw: { confirmationAgeBars: 1 } }),
    1,
  );
  assert.equal(
    __test.confirmationAgeBarsOf({ confirmation_age_bars: 0 }),
    0,
  );
  assert.equal(
    __test.confirmationAgeBarsOf({ raw: { confirmationAgeBars: -1 } }),
    null,
  );
  assert.equal(__test.sidewayM5ConfirmationPath(0), "M5_CURRENT");
  assert.equal(__test.sidewayM5ConfirmationPath(1), "M5_CARRY_1");
  assert.equal(__test.sidewayM5ConfirmationPath(2), "M5_CARRY_OTHER");
  assert.equal(__test.sidewayM5ConfirmationPath(null), "UNKNOWN");

  const event = (age: number | null) => ({
    raw: {},
    index: 0,
    eventId: String(age),
    eventName: "ENTRY_SUBMIT",
    occurredAtMs: 1,
    identifiers: [],
    passedRules: [],
    blockedRules: [],
    blockReasons: [],
    entryType: "IMMEDIATE",
    regime: "RANGING",
    entryPolicy: null,
    performanceStrategy: "SIDEWAY",
    confirmationAgeBars: age,
  });

  assert.equal(__test.chooseConfirmationAgeBars([event(1)] as never), 1);
  assert.equal(__test.chooseConfirmationAgeBars([event(1), event(1)] as never), 1);
  assert.equal(__test.chooseConfirmationAgeBars([event(0), event(1)] as never), null);
});

test("Sideway M5 confirmation age profitability uses only EXACT SIDEWAY trades", () => {
  const trade = (
    ageBars: number | null,
    netPnl: number,
    verdict: "EXACT" | "AMBIGUOUS" = "EXACT",
    performanceStrategy: "SIDEWAY" | "TREND" = "SIDEWAY",
  ) => ({
    strategy: performanceStrategy === "SIDEWAY" ? "SIDEWAY" : "TREND",
    netPnl,
    correlation: { verdict },
    attribution: { performanceStrategy, confirmationAgeBars: ageBars },
  });

  const rows = __test.aggregateSidewayM5ConfirmationAge([
    trade(0, 10),
    trade(0, -4),
    trade(1, 8),
    trade(1, -2),
    trade(2, 5),
    trade(null, -1),
    trade(1, 999, "AMBIGUOUS"),
    trade(1, 999, "EXACT", "TREND"),
  ] as never);

  const current = rows.find((row) => row.path === "M5_CURRENT");
  const carry = rows.find((row) => row.path === "M5_CARRY_1");
  const other = rows.find((row) => row.path === "M5_CARRY_OTHER");
  const unknown = rows.find((row) => row.path === "UNKNOWN");

  assert.deepEqual(current, {
    path: "M5_CURRENT",
    ageBars: 0,
    sampleSize: 2,
    wins: 1,
    losses: 1,
    breakeven: 0,
    netPnl: 6,
    expectancy: 3,
    winRatePercent: 50,
    profitFactor: 2.5,
  });
  assert.deepEqual(carry, {
    path: "M5_CARRY_1",
    ageBars: 1,
    sampleSize: 2,
    wins: 1,
    losses: 1,
    breakeven: 0,
    netPnl: 6,
    expectancy: 3,
    winRatePercent: 50,
    profitFactor: 4,
  });
  assert.equal(other?.sampleSize, 1);
  assert.equal(other?.netPnl, 5);
  assert.equal(unknown?.sampleSize, 1);
  assert.equal(unknown?.netPnl, -1);
});

