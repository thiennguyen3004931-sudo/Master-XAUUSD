import { describe, expect, it } from "vitest";
import { PositionSide } from "@xauusd/types";
import {
  PositionManagementService,
  defaultExecutionEngineConfig,
  type PositionManagementContext,
} from "../src";
import {
  NOW,
  createManagementContext,
  createQuote,
} from "./fixtures";

const ACTIVATION_MESSAGE =
  "Đã đủ điều kiện kích hoạt Trailing Stop.";

function trendContext(
  favorableMove: number,
  options: {
    assessedAt?: number;
    trendValid?: boolean;
    structureBroken?: boolean;
    withSwing?: boolean;
    evaluatedAt?: number;
    stopLoss?: number;
  } = {},
): PositionManagementContext {
  const base = createManagementContext();
  const evaluatedAt =
    options.evaluatedAt ?? NOW + 180_000;

  const isLong =
    base.position.side === PositionSide.LONG;

  const exitPrice = isLong
    ? base.position.entry + favorableMove
    : base.position.entry - favorableMove;

  const quote = isLong
    ? createQuote({
        bid: exitPrice,
        ask: exitPrice + 0.1,
        timestamp: evaluatedAt,
      })
    : createQuote({
        bid: exitPrice - 0.1,
        ask: exitPrice,
        timestamp: evaluatedAt,
      });

  const latestSwingLow =
    options.withSwing === false
      ? undefined
      : isLong
        ? base.position.entry + 7.5
        : undefined;

  const latestSwingHigh =
    options.withSwing === false
      ? undefined
      : !isLong
        ? base.position.entry - 7.5
        : undefined;

  return {
    ...base,
    position: {
      ...base.position,
      stopLoss:
        options.stopLoss ??
        base.position.stopLoss,
    },
    plan: {
      ...base.plan,
      management: {
        ...base.plan.management,
        partialTargets: [],
        trendHoldUntilStructureBreak: true,
        trailingStop: {
          enabled: true,
          startAtR: 1.5,
          mode: "TREND_STRUCTURE",
          atrMultiple: 1.5,
          neverWidenStop: true,
          activateAtProfitPrice: 6,
          structureTrailAtProfitPrice: 10,
          positiveLockPrice: 0.5,
          swingBufferAtrMultiple: 0.25,
          minimumDistanceAtrMultiple: 0.5,
        },
      },
    },
    quote,
    atr: 2,
    state: {
      initialVolume: base.state.initialVolume,
      completedTargetLabels: [],
      breakEvenApplied: false,
      trailingActivated: false,
    },
    trendStructure: {
      trendValid:
        options.trendValid ?? true,
      structureBroken:
        options.structureBroken ?? false,
      latestSwingLow,
      latestSwingHigh,
      assessedAt:
        options.assessedAt ?? evaluatedAt,
    },
    evaluatedAt,
  };
}

function modifyCommands(
  context: PositionManagementContext,
) {
  return new PositionManagementService(
    defaultExecutionEngineConfig,
  ).evaluate(context).commands.filter(
    (command) => command.type === "MODIFY_STOP",
  );
}

describe("Trend hold / structure trailing", () => {
  it("does not arm or modify the stop before +6 price units", () => {
    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(trendContext(5.99));

    expect(
      result.commands.some(
        (command) =>
          command.type === "MODIFY_STOP",
      ),
    ).toBe(false);

    expect(result.notes).not.toContain(
      ACTIVATION_MESSAGE,
    );

    expect(
      result.updatedState.trailingActivated,
    ).not.toBe(true);
  });
  it("+6 arms trailing without forcing a fixed entry +0.50 stop when no protective swing exists", () => {
    const context = trendContext(
      6.5,
      {
        withSwing: false,
      },
    );

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(context);

    expect(result.notes).toContain(
      ACTIVATION_MESSAGE,
    );

    expect(
      result.updatedState.trailingActivated,
    ).toBe(true);

    expect(
      result.commands.some(
        (item) =>
          item.type === "MODIFY_STOP",
      ),
    ).toBe(false);

    expect(
      result.updatedState.breakEvenApplied,
    ).toBe(false);
  });

  it("between +6 and +10 moves the stop only when a fresh protective swing locks positive", () => {
    // Default fixture swing is entry +7.5 for LONG.
    // Use +8.5 current favorable move so the confirmed swing is
    // strictly behind current price and can act as a protective stop.
    const context = trendContext(8.5);

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(context);

    const command = result.commands.find(
      (item) =>
        item.type === "MODIFY_STOP" &&
        item.reason === "BREAK_EVEN",
    );

    expect(command).toBeDefined();

    if (
      !command ||
      command.type !== "MODIFY_STOP"
    ) {
      throw new Error(
        "Expected structure-confirmed positive protective stop.",
      );
    }

    const isLong =
      context.position.side ===
      PositionSide.LONG;

    const swing = isLong
      ? context.trendStructure?.latestSwingLow
      : context.trendStructure?.latestSwingHigh;

    expect(swing).toBeDefined();

    if (swing === undefined) {
      throw new Error(
        "Protective swing fixture missing.",
      );
    }

    const expected = isLong
      ? swing - context.atr * 0.25
      : swing + context.atr * 0.25;

    expect(command.stopLoss).toBeCloseTo(
      expected,
      2,
    );

    expect(
      isLong
        ? command.stopLoss >
          context.position.entry
        : command.stopLoss <
          context.position.entry,
    ).toBe(true);
  });

  it("uses swing structure after +10 when a fresh protective swing exists", () => {
    const context = trendContext(10.5);

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate({
      ...context,
      state: {
        ...context.state,
        breakEvenApplied: true,
        trailingActivated: true,
      },
    });

    const command = result.commands.find(
      (item) =>
        item.type === "MODIFY_STOP" &&
        item.reason === "TRAILING_STOP",
    );

    expect(command).toBeDefined();

    if (
      !command ||
      command.type !== "MODIFY_STOP"
    ) {
      throw new Error(
        "Expected swing trailing command.",
      );
    }

    const isLong =
      context.position.side ===
      PositionSide.LONG;

    const swing = isLong
      ? context.trendStructure?.latestSwingLow
      : context.trendStructure?.latestSwingHigh;

    expect(swing).toBeDefined();

    if (swing === undefined) {
      throw new Error("Swing fixture missing.");
    }

    const expected = isLong
      ? swing - context.atr * 0.25
      : swing + context.atr * 0.25;

    expect(command.stopLoss).toBeCloseTo(
      expected,
      2,
    );
  });

  it("falls back to 1.5 ATR trailing after +10 if no usable swing is available", () => {
    const context = trendContext(
      10.5,
      { withSwing: false },
    );

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate({
      ...context,
      state: {
        ...context.state,
        breakEvenApplied: true,
        trailingActivated: true,
      },
    });

    const command = result.commands.find(
      (item) =>
        item.type === "MODIFY_STOP" &&
        item.reason === "TRAILING_STOP",
    );

    expect(command).toBeDefined();

    if (
      !command ||
      command.type !== "MODIFY_STOP"
    ) {
      throw new Error(
        "Expected ATR fallback trailing command.",
      );
    }

    const currentPrice =
      context.position.side ===
      PositionSide.LONG
        ? context.quote.bid
        : context.quote.ask;

    const expected =
      context.position.side ===
      PositionSide.LONG
        ? currentPrice - context.atr * 1.5
        : currentPrice + context.atr * 1.5;

    expect(command.stopLoss).toBeCloseTo(
      expected,
      2,
    );
  });

  it("holds past the legacy time stop only with a fresh explicitly valid trend", () => {
    const base = trendContext(8);
    const evaluatedAt =
      base.plan.management.timeStopAt;

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate({
      ...base,
      quote:
        base.position.side ===
        PositionSide.LONG
          ? createQuote({
              bid:
                base.position.entry + 8,
              ask:
                base.position.entry + 8.1,
              timestamp: evaluatedAt,
            })
          : createQuote({
              bid:
                base.position.entry - 8.1,
              ask:
                base.position.entry - 8,
              timestamp: evaluatedAt,
            }),
      trendStructure: {
        ...base.trendStructure!,
        trendValid: true,
        structureBroken: false,
        assessedAt: evaluatedAt,
      },
      evaluatedAt,
    });

    expect(
      result.commands.some(
        (command) =>
          command.type === "CLOSE_POSITION" &&
          command.reason === "TIME_STOP",
      ),
    ).toBe(false);
  });

  it("fails safe to TIME_STOP when the trend snapshot is stale", () => {
    const base = trendContext(8);
    const evaluatedAt =
      base.plan.management.timeStopAt;

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate({
      ...base,
      quote:
        base.position.side ===
        PositionSide.LONG
          ? createQuote({
              bid:
                base.position.entry + 8,
              ask:
                base.position.entry + 8.1,
              timestamp: evaluatedAt,
            })
          : createQuote({
              bid:
                base.position.entry - 8.1,
              ask:
                base.position.entry - 8,
              timestamp: evaluatedAt,
            }),
      trendStructure: {
        ...base.trendStructure!,
        assessedAt:
          evaluatedAt -
          5 * 60_000 -
          1,
      },
      evaluatedAt,
    });

    expect(
      result.commands.some(
        (command) =>
          command.type === "CLOSE_POSITION" &&
          command.reason === "TIME_STOP",
      ),
    ).toBe(true);
  });

  it("closes immediately on an explicit fresh trend structure break", () => {
    const context = trendContext(
      4,
      {
        structureBroken: true,
        trendValid: false,
      },
    );

    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(context);

    expect(
      result.commands[0]?.type,
    ).toBe("CLOSE_POSITION");

    expect(
      result.commands[0]?.type ===
        "CLOSE_POSITION"
        ? result.commands[0].reason
        : null,
    ).toBe("TREND_STRUCTURE_BREAK");
  });

  it("never widens a stop that is already more protective", () => {
    const base = trendContext(10.5);

    const isLong =
      base.position.side ===
      PositionSide.LONG;

    const alreadyProtected = isLong
      ? base.position.entry + 9
      : base.position.entry - 9;

    const commands = modifyCommands({
      ...base,
      position: {
        ...base.position,
        stopLoss: alreadyProtected,
      },
      state: {
        ...base.state,
        breakEvenApplied: true,
        trailingActivated: true,
        trailingStopPrice:
          alreadyProtected,
      },
    });

    expect(commands).toHaveLength(0);
  });

  it("keeps trend runner free of mechanical partial closes", () => {
    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(trendContext(12));

    expect(
      result.commands.some(
        (command) =>
          command.type === "PARTIAL_CLOSE",
      ),
    ).toBe(false);
  });
});