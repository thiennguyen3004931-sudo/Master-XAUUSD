import type { JsonObject, SignedCopyCommand } from "@xauusd/copy-protocol";
import type { CustomerCopyCommandDecision } from "./copy-follower.js";

export type FollowerSide = "BUY" | "SELL";

export type CustomerFollowerExecutionRequest =
  | {
      readonly action: "POSITION_OPEN";
      readonly commandId: string;
      readonly sequence: number;
      readonly symbol: string;
      readonly masterPositionRef: string;
      readonly side: FollowerSide;
      readonly volume: number;
      readonly entry?: number;
      readonly stopLoss?: number;
      readonly takeProfit?: number;
    }
  | {
      readonly action: "STOP_LOSS_UPDATE";
      readonly commandId: string;
      readonly sequence: number;
      readonly symbol: string;
      readonly masterPositionRef: string;
      readonly stopLoss: number;
    }
  | {
      readonly action: "TAKE_PROFIT_UPDATE";
      readonly commandId: string;
      readonly sequence: number;
      readonly symbol: string;
      readonly masterPositionRef: string;
      readonly takeProfit: number;
    }
  | {
      readonly action: "PARTIAL_CLOSE";
      readonly commandId: string;
      readonly sequence: number;
      readonly symbol: string;
      readonly masterPositionRef: string;
      readonly volume: number;
    }
  | {
      readonly action: "POSITION_CLOSE";
      readonly commandId: string;
      readonly sequence: number;
      readonly symbol: string;
      readonly masterPositionRef: string;
    }
  | {
      readonly action: "POSITION_SNAPSHOT";
      readonly commandId: string;
      readonly sequence: number;
      readonly symbol: string;
      readonly masterPositionRef: string;
    };

export interface CustomerFollowerExecutor {
  execute(request: CustomerFollowerExecutionRequest): Promise<void>;
}

export type CustomerFollowerExecutionDecision =
  | {
      readonly ok: true;
      readonly code: "FORWARDED_TO_EXECUTOR";
      readonly request: CustomerFollowerExecutionRequest;
    }
  | {
      readonly ok: false;
      readonly code:
        | "COMMAND_NOT_ACCEPTED"
        | "INVALID_EXECUTION_PAYLOAD"
        | "EXECUTOR_FAILED";
    };

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function exactKeys(payload: JsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(payload).sort();
  const expected = [...allowed].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function optionalPrice(
  payload: JsonObject,
  key: "entry" | "stopLoss" | "takeProfit",
): number | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return undefined;
  const value = payload[key];
  return finitePositive(value) ? value : null;
}

function base(command: SignedCopyCommand) {
  return {
    commandId: command.commandId,
    sequence: command.sequence,
    symbol: command.symbol,
    masterPositionRef: command.masterPositionRef,
  };
}

export function toCustomerFollowerExecutionRequest(
  command: SignedCopyCommand,
): CustomerFollowerExecutionRequest | null {
  const payload = command.payload;

  switch (command.action) {
    case "POSITION_OPEN": {
      const allowed = ["side", "volume", "entry", "stopLoss", "takeProfit"];
      const keys = Object.keys(payload);
      if (keys.some((key) => !allowed.includes(key))) return null;
      if (!Object.prototype.hasOwnProperty.call(payload, "side")) return null;
      if (!Object.prototype.hasOwnProperty.call(payload, "volume")) return null;

      const side = payload.side;
      const volume = payload.volume;
      if ((side !== "BUY" && side !== "SELL") || !finitePositive(volume)) {
        return null;
      }

      const entry = optionalPrice(payload, "entry");
      const stopLoss = optionalPrice(payload, "stopLoss");
      const takeProfit = optionalPrice(payload, "takeProfit");
      if (entry === null || stopLoss === null || takeProfit === null) return null;

      return Object.freeze({
        action: "POSITION_OPEN",
        ...base(command),
        side,
        volume,
        ...(entry === undefined ? {} : { entry }),
        ...(stopLoss === undefined ? {} : { stopLoss }),
        ...(takeProfit === undefined ? {} : { takeProfit }),
      });
    }

    case "STOP_LOSS_UPDATE":
      if (!exactKeys(payload, ["stopLoss"]) || !finitePositive(payload.stopLoss)) {
        return null;
      }
      return Object.freeze({
        action: "STOP_LOSS_UPDATE",
        ...base(command),
        stopLoss: payload.stopLoss,
      });

    case "TAKE_PROFIT_UPDATE":
      if (
        !exactKeys(payload, ["takeProfit"]) ||
        !finitePositive(payload.takeProfit)
      ) {
        return null;
      }
      return Object.freeze({
        action: "TAKE_PROFIT_UPDATE",
        ...base(command),
        takeProfit: payload.takeProfit,
      });

    case "PARTIAL_CLOSE":
      if (!exactKeys(payload, ["volume"]) || !finitePositive(payload.volume)) {
        return null;
      }
      return Object.freeze({
        action: "PARTIAL_CLOSE",
        ...base(command),
        volume: payload.volume,
      });

    case "POSITION_CLOSE":
      if (!exactKeys(payload, [])) return null;
      return Object.freeze({
        action: "POSITION_CLOSE",
        ...base(command),
      });

    case "POSITION_SNAPSHOT":
      if (!exactKeys(payload, [])) return null;
      return Object.freeze({
        action: "POSITION_SNAPSHOT",
        ...base(command),
      });
  }
}

export class CustomerFollowerExecutionAdapter {
  constructor(private readonly executor: CustomerFollowerExecutor) {
    if (
      executor === null ||
      typeof executor !== "object" ||
      typeof executor.execute !== "function"
    ) {
      throw new TypeError("executor must implement execute(request)");
    }
  }

  async dispatch(
    decision: CustomerCopyCommandDecision,
  ): Promise<CustomerFollowerExecutionDecision> {
    if (!decision.ok) {
      return { ok: false, code: "COMMAND_NOT_ACCEPTED" };
    }

    const request = toCustomerFollowerExecutionRequest(decision.command);
    if (request === null) {
      return { ok: false, code: "INVALID_EXECUTION_PAYLOAD" };
    }

    try {
      await this.executor.execute(request);
    } catch {
      return { ok: false, code: "EXECUTOR_FAILED" };
    }

    return {
      ok: true,
      code: "FORWARDED_TO_EXECUTOR",
      request,
    };
  }
}
