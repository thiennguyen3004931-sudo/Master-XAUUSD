import { describe, expect, it } from "vitest";
import {
  PositionManagementService,
  defaultExecutionEngineConfig,
} from "../src";
import {
  NOW,
  createManagementContext,
  createQuote,
} from "./fixtures";

describe("PositionManagementService", () => {
  it("schedules TP1 partial close and break-even", () => {
    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(createManagementContext());

    expect(
      result.commands.some(
        (command) =>
          command.type === "PARTIAL_CLOSE" &&
          command.targetLabel === "TP1",
      ),
    ).toBe(true);
    expect(
      result.commands.some(
        (command) =>
          command.type === "MODIFY_STOP" &&
          command.reason === "BREAK_EVEN",
      ),
    ).toBe(true);
  });

  it("uses ATR trailing after the configured R multiple", () => {
    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(
      createManagementContext({
        quote: createQuote({
          bid: 2409,
          ask: 2409.1,
          timestamp: NOW + 120_000,
        }),
        state: {
          initialVolume: 0.2,
          completedTargetLabels: ["TP1", "TP2"],
          breakEvenApplied: true,
        },
        evaluatedAt: NOW + 120_000,
      }),
    );

    expect(
      result.commands.some(
        (command) =>
          command.type === "MODIFY_STOP" &&
          command.reason === "TRAILING_STOP",
      ),
    ).toBe(true);
  });

  it("closes the position at the time stop", () => {
    const context = createManagementContext();
    const result = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate({
      ...context,
      evaluatedAt: context.plan.management.timeStopAt,
    });

    expect(result.commands[0]?.type).toBe("CLOSE_POSITION");
    expect(
      result.commands[0]?.type === "CLOSE_POSITION"
        ? result.commands[0].reason
        : null,
    ).toBe("TIME_STOP");
  });
});
