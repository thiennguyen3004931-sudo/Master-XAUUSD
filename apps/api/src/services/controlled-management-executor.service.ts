import type {
  IExecutionAdapter,
  IExecutionRepository,
  ManagementCommandResult,
  ManagementExecutionService,
} from "@xauusd/execution-engine";

import {
  createInFlightManagementReconciler,
  type ManagementRecoveryControlState,
} from "./management-in-flight-reconciler.service";

import type {
  DurableManagementCommand,
  IManagementStateRepository,
} from "./sqlite-management-state.repository";

export interface ControlledManagementExecutorConfig {
  enabled: boolean;
  executionEnabled: boolean;
  symbol: string;
  maximumCommands: 1;
}

export const defaultControlledManagementExecutorConfig:
  Readonly<ControlledManagementExecutorConfig> =
  Object.freeze({
    enabled: false,
    executionEnabled: false,
    symbol: "XAUUSD",
    maximumCommands: 1,
  });

export interface ControlledManagementExecutorDependencies {
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
  managementExecutionService:
    Pick<
      ManagementExecutionService,
      "execute"
    >;
}

export interface ControlledManagementExecutorResult {
  status:
    | "DISABLED"
    | "BLOCKED"
    | "NO_PENDING_COMMAND"
    | "EXECUTED"
    | "FAILED";
  command?: DurableManagementCommand;
  result?: ManagementCommandResult;
  brokerMutationAttempted: boolean;
  maximumCommands: 1;
  generatedAt: number;
  reason: string;
}

function isDemoUnlockedOnlyForDemo(
  state: ManagementRecoveryControlState,
): boolean {
  return (
    state.mode === "DEMO" &&
    state.tradingEnabled &&
    state.liveUnlockAvailable === false
  );
}

async function validatePendingOwnership(
  candidate: DurableManagementCommand,
  repository:
    ControlledManagementExecutorDependencies[
      "executionRepository"
    ],
) {
  const record =
    await repository.findByTicket(
      candidate.ticket,
    );

  if (
    !record ||
    record.id !==
      candidate.executionRecordId ||
    record.receipt?.ticket !==
      candidate.ticket ||
    record.strategyPlan?.order.symbol !==
      "XAUUSD" ||
    record.strategyPlan?.selectedStrategy
      .strategyId !== "TREND_CONTINUATION"
  ) {
    return null;
  }

  return record;
}

export function createControlledManagementExecutor(
  dependencies:
    ControlledManagementExecutorDependencies,
) {
  const reconcile =
    createInFlightManagementReconciler({
      now: dependencies.now,
      getControlState:
        dependencies.getControlState,
      managementRepository:
        dependencies.managementRepository,
      executionRepository:
        dependencies.executionRepository,
      adapter:
        dependencies.adapter,
    });

  return async function executeControlledManagement(
    override: Partial<
      ControlledManagementExecutorConfig
    > = {},
  ): Promise<ControlledManagementExecutorResult> {
    const config = {
      ...defaultControlledManagementExecutorConfig,
      ...override,
    };

    const generatedAt =
      dependencies.now();

    if (!config.enabled) {
      return {
        status: "DISABLED",
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Controlled management executor is dormant.",
      };
    }

    if (!config.executionEnabled) {
      return {
        status: "BLOCKED",
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "executionEnabled=false.",
      };
    }

    if (
      config.symbol !== "XAUUSD" ||
      config.maximumCommands !== 1
    ) {
      return {
        status: "BLOCKED",
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Only XAUUSD and maximumCommands=1 are supported.",
      };
    }

    const initialControl =
      dependencies.getControlState();

    if (
      !isDemoUnlockedOnlyForDemo(
        initialControl,
      )
    ) {
      return {
        status: "BLOCKED",
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "DEMO control mode is required and LIVE must remain unavailable.",
      };
    }

    const recovery =
      await reconcile({
        enabled: true,
        symbol: config.symbol,
        maximumCommands: 1,
      });

    if (
      recovery.status === "BLOCKED" ||
      recovery.unresolvedCount > 0
    ) {
      return {
        status: "BLOCKED",
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Unresolved IN_FLIGHT management command blocks new mutation.",
      };
    }

    const pending =
      await dependencies
        .managementRepository
        .listCommandsByStatus(
          "PENDING",
        );

    if (pending.length === 0) {
      return {
        status:
          "NO_PENDING_COMMAND",
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "No pending management command.",
      };
    }

    const candidate =
      pending[0]!;

    const record =
      await validatePendingOwnership(
        candidate,
        dependencies.executionRepository,
      );

    if (!record) {
      return {
        status: "BLOCKED",
        command: candidate,
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Pending command ownership does not match a system-owned TrendContinuation execution record.",
      };
    }

    const brokerPositions =
      await dependencies.adapter
        .getOpenPositions(
          config.symbol,
        );

    const brokerPosition =
      brokerPositions.find(
        (position) =>
          position.ticket ===
          candidate.ticket,
      );

    if (
      candidate.command.type ===
        "MODIFY_STOP" &&
      !brokerPosition
    ) {
      return {
        status: "BLOCKED",
        command: candidate,
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Pending MODIFY_STOP broker position is missing.",
      };
    }

    if (
      candidate.command.type ===
      "PARTIAL_CLOSE"
    ) {
      return {
        status: "BLOCKED",
        command: candidate,
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "PARTIAL_CLOSE is not allowed for the TrendContinuation management path.",
      };
    }

    const preClaimControl =
      dependencies.getControlState();

    if (
      !isDemoUnlockedOnlyForDemo(
        preClaimControl,
      )
    ) {
      return {
        status: "BLOCKED",
        command: candidate,
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Control mode changed before claim.",
      };
    }

    const claimed =
      await dependencies
        .managementRepository
        .claimCommand(
          candidate.commandKey,
          dependencies.now(),
        );

    if (!claimed) {
      return {
        status: "BLOCKED",
        command: candidate,
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Atomic command claim failed or command expired.",
      };
    }

    const preExecuteControl =
      dependencies.getControlState();

    if (
      !isDemoUnlockedOnlyForDemo(
        preExecuteControl,
      )
    ) {
      await dependencies
        .managementRepository
        .releaseCommand(
          claimed.commandKey,
          dependencies.now(),
        );

      return {
        status: "BLOCKED",
        command: claimed,
        brokerMutationAttempted: false,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Control mode changed after claim; claim released before mutation.",
      };
    }

    let executionResult:
      ManagementCommandResult;

    try {
      const results =
        await dependencies
          .managementExecutionService
          .execute([
            claimed.command,
          ]);

      executionResult =
        results[0] ?? {
          commandId:
            claimed.command.commandId,
          success: false,
          message:
            "ManagementExecutionService returned no result.",
          executedAt:
            dependencies.now(),
        };
    }
    catch (error) {
      // Mutation outcome is unknown. Leave IN_FLIGHT intact so
      // the next controlled cycle MUST reconcile broker state
      // before any replay.
      return {
        status: "FAILED",
        command: claimed,
        brokerMutationAttempted: true,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Management execution threw; IN_FLIGHT is intentionally preserved for reconciliation.",
        result: {
          commandId:
            claimed.command.commandId,
          success: false,
          message:
            error instanceof Error
              ? error.message
              : String(error),
          executedAt:
            dependencies.now(),
        },
      };
    }

    if (executionResult.success) {
      await dependencies
        .managementRepository
        .markCommandExecuted(
          claimed.commandKey,
          executionResult,
        );

      return {
        status: "EXECUTED",
        command: claimed,
        result:
          executionResult,
        brokerMutationAttempted: true,
        maximumCommands: 1,
        generatedAt,
        reason:
          "Exactly one controlled DEMO management command executed.",
      };
    }

    await dependencies
      .managementRepository
      .markCommandFailed(
        claimed.commandKey,
        executionResult,
      );

    return {
      status: "FAILED",
      command: claimed,
      result:
        executionResult,
      brokerMutationAttempted: true,
      maximumCommands: 1,
      generatedAt,
      reason:
        "Controlled management command returned failure.",
    };
  };
}