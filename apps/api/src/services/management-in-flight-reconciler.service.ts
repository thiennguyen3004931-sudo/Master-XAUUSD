import type {
  IExecutionAdapter,
  IExecutionRepository,
  ManagementCommand,
  ManagementCommandResult,
} from "@xauusd/execution-engine";

import type {
  Position,
} from "@xauusd/types";

import type {
  DurableManagementCommand,
  IManagementStateRepository,
} from "./sqlite-management-state.repository";

export interface ManagementRecoveryControlState {
  mode: "SHADOW" | "DEMO";
  tradingEnabled: boolean;
  liveUnlockAvailable: false;
}

export interface InFlightReconcilerConfig {
  enabled: boolean;
  symbol: string;
  maximumCommands: number;
}

export const defaultInFlightReconcilerConfig:
  Readonly<InFlightReconcilerConfig> =
  Object.freeze({
    enabled: false,
    symbol: "XAUUSD",
    maximumCommands: 1,
  });

export type InFlightRecoveryDisposition =
  | "ALREADY_APPLIED"
  | "REPLAY_REQUIRED"
  | "LIFECYCLE_RECONCILED"
  | "BLOCKED";

export interface InFlightRecoveryItem {
  commandKey: string;
  commandId: string;
  ticket: string;
  disposition: InFlightRecoveryDisposition;
  reason: string;
  brokerMutationPerformed: false;
}

export interface InFlightRecoveryResult {
  status:
    | "DISABLED"
    | "CLEAR"
    | "RECONCILED"
    | "BLOCKED";
  items: InFlightRecoveryItem[];
  unresolvedCount: number;
  brokerMutationPerformed: false;
  generatedAt: number;
}

export interface InFlightReconcilerDependencies {
  now: () => number;
  getControlState:
    () => ManagementRecoveryControlState;
  managementRepository:
    IManagementStateRepository;
  executionRepository:
    Pick<
      IExecutionRepository,
      "findByTicket" | "update"
    >;
  adapter:
    Pick<
      IExecutionAdapter,
      "getOpenPositions" | "getSymbolSpec"
    >;
}

function approximatelyEqual(
  left: number,
  right: number,
  tolerance: number,
): boolean {
  return Math.abs(left - right) <= tolerance;
}

function modifyEffectApplied(
  command: Extract<
    ManagementCommand,
    { type: "MODIFY_STOP" }
  >,
  position: Position,
  tickSize: number,
): boolean {
  const tolerance =
    Math.max(tickSize / 2, 1e-8);

  if (
    !approximatelyEqual(
      position.stopLoss,
      command.stopLoss,
      tolerance,
    )
  ) {
    return false;
  }

  if (
    command.takeProfit !== undefined &&
    !approximatelyEqual(
      position.takeProfit,
      command.takeProfit,
      tolerance,
    )
  ) {
    return false;
  }

  return true;
}

function syntheticSuccess(
  command: ManagementCommand,
  now: number,
  message: string,
): ManagementCommandResult {
  return {
    commandId: command.commandId,
    success: true,
    message,
    executedAt: now,
  };
}

async function validateOwnership(
  durable: DurableManagementCommand,
  repository:
    InFlightReconcilerDependencies[
      "executionRepository"
    ],
) {
  const record =
    await repository.findByTicket(
      durable.ticket,
    );

  if (
    !record ||
    record.id !==
      durable.executionRecordId ||
    record.receipt?.ticket !==
      durable.ticket ||
    record.strategyPlan?.order.symbol !==
      "XAUUSD" ||
    record.strategyPlan?.selectedStrategy
      .strategyId !== "TREND_CONTINUATION"
  ) {
    return null;
  }

  return record;
}

export function createInFlightManagementReconciler(
  dependencies: InFlightReconcilerDependencies,
) {
  return async function reconcileInFlightManagement(
    override: Partial<
      InFlightReconcilerConfig
    > = {},
  ): Promise<InFlightRecoveryResult> {
    const config = {
      ...defaultInFlightReconcilerConfig,
      ...override,
    };

    const generatedAt =
      dependencies.now();

    if (!config.enabled) {
      return {
        status: "DISABLED",
        items: [],
        unresolvedCount: 0,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    const control =
      dependencies.getControlState();

    if (
      control.mode !== "DEMO" ||
      !control.tradingEnabled ||
      control.liveUnlockAvailable !== false
    ) {
      return {
        status: "BLOCKED",
        items: [],
        unresolvedCount: 1,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    if (
      config.symbol !== "XAUUSD" ||
      config.maximumCommands !== 1
    ) {
      return {
        status: "BLOCKED",
        items: [],
        unresolvedCount: 1,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    const inFlight =
      await dependencies
        .managementRepository
        .listCommandsByStatus(
          "IN_FLIGHT",
        );

    if (inFlight.length === 0) {
      return {
        status: "CLEAR",
        items: [],
        unresolvedCount: 0,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    if (inFlight.length > 1) {
      return {
        status: "BLOCKED",
        items: inFlight.map(
          (entry) => ({
            commandKey:
              entry.commandKey,
            commandId:
              entry.command.commandId,
            ticket:
              entry.ticket,
            disposition: "BLOCKED",
            reason:
              "More than one IN_FLIGHT management command requires manual review.",
            brokerMutationPerformed: false,
          }),
        ),
        unresolvedCount:
          inFlight.length,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    const durable = inFlight[0]!;
    const command = durable.command;

    const record =
      await validateOwnership(
        durable,
        dependencies.executionRepository,
      );

    if (!record) {
      return {
        status: "BLOCKED",
        items: [{
          commandKey:
            durable.commandKey,
          commandId:
            command.commandId,
          ticket:
            durable.ticket,
          disposition: "BLOCKED",
          reason:
            "IN_FLIGHT command ownership does not match the durable system execution record.",
          brokerMutationPerformed: false,
        }],
        unresolvedCount: 1,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    const brokerPositions =
      await dependencies.adapter
        .getOpenPositions(config.symbol);

    const brokerPosition =
      brokerPositions.find(
        (position) =>
          position.ticket ===
          durable.ticket,
      );

    if (
      command.type === "MODIFY_STOP"
    ) {
      if (!brokerPosition) {
        return {
          status: "BLOCKED",
          items: [{
            commandKey:
              durable.commandKey,
            commandId:
              command.commandId,
            ticket:
              durable.ticket,
            disposition: "BLOCKED",
            reason:
              "MODIFY_STOP position is missing at broker; lifecycle reconciliation is required.",
            brokerMutationPerformed: false,
          }],
          unresolvedCount: 1,
          brokerMutationPerformed: false,
          generatedAt,
        };
      }

      const spec =
        await dependencies.adapter
          .getSymbolSpec(
            config.symbol,
          );

      if (
        modifyEffectApplied(
          command,
          brokerPosition,
          spec.tickSize,
        )
      ) {
        await dependencies
          .managementRepository
          .markCommandExecuted(
            durable.commandKey,
            syntheticSuccess(
              command,
              generatedAt,
              "Recovered: broker protection already matches the IN_FLIGHT command.",
            ),
          );

        return {
          status: "RECONCILED",
          items: [{
            commandKey:
              durable.commandKey,
            commandId:
              command.commandId,
            ticket:
              durable.ticket,
            disposition:
              "ALREADY_APPLIED",
            reason:
              "Broker SL/TP already matches; command marked EXECUTED without broker mutation.",
            brokerMutationPerformed: false,
          }],
          unresolvedCount: 0,
          brokerMutationPerformed: false,
          generatedAt,
        };
      }

      return {
        status: "BLOCKED",
        items: [{
          commandKey:
            durable.commandKey,
          commandId:
            command.commandId,
          ticket:
            durable.ticket,
          disposition:
            "REPLAY_REQUIRED",
          reason:
            "Broker protection does not match. Only explicit replay of the SAME stable commandId is permitted.",
          brokerMutationPerformed: false,
        }],
        unresolvedCount: 1,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    if (
      command.type ===
      "PARTIAL_CLOSE"
    ) {
      return {
        status: "BLOCKED",
        items: [{
          commandKey:
            durable.commandKey,
          commandId:
            command.commandId,
          ticket:
            durable.ticket,
          disposition: "BLOCKED",
          reason:
            "PARTIAL_CLOSE recovery is unsupported for TrendContinuation and fails closed.",
          brokerMutationPerformed: false,
        }],
        unresolvedCount: 1,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    if (brokerPosition) {
      return {
        status: "BLOCKED",
        items: [{
          commandKey:
            durable.commandKey,
          commandId:
            command.commandId,
          ticket:
            durable.ticket,
          disposition:
            "REPLAY_REQUIRED",
          reason:
            "CLOSE_POSITION broker effect is not present. Only explicit replay of the SAME stable commandId is permitted.",
          brokerMutationPerformed: false,
        }],
        unresolvedCount: 1,
        brokerMutationPerformed: false,
        generatedAt,
      };
    }

    await dependencies
      .managementRepository
      .markCommandExecuted(
        durable.commandKey,
        syntheticSuccess(
          command,
          generatedAt,
          "Recovered: position is already absent at broker.",
        ),
      );

    if (
      record.status !== "CLOSED" &&
      record.receipt
    ) {
      await dependencies
        .executionRepository
        .update({
          ...record,
          status: "CLOSED",
          receipt: {
            ...record.receipt,
            position:
              record.receipt.position
                ? {
                    ...record.receipt.position,
                    closedAt:
                      generatedAt,
                  }
                : undefined,
          },
          updatedAt:
            generatedAt,
        });
    }

    return {
      status: "RECONCILED",
      items: [{
        commandKey:
          durable.commandKey,
        commandId:
          command.commandId,
        ticket:
          durable.ticket,
        disposition:
          "LIFECYCLE_RECONCILED",
        reason:
          "Position already absent; management command and durable execution lifecycle reconciled without broker mutation.",
        brokerMutationPerformed: false,
      }],
      unresolvedCount: 0,
      brokerMutationPerformed: false,
      generatedAt,
    };
  };
}