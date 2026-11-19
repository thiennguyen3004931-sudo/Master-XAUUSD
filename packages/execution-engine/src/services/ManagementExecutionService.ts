import type {
  IClock,
  IExecutionAdapter,
  IExecutionRepository,
} from "../contracts";
import type {
  ExecutionRecord,
  ManagementCommand,
  ManagementCommandResult,
} from "../models";
import { SystemClock } from "../utils";

export class ManagementExecutionService {
  constructor(
    private readonly adapter: IExecutionAdapter,
    private readonly clock: IClock = new SystemClock(),
    private readonly repository?: IExecutionRepository,
  ) {}

  async execute(
    commands: readonly ManagementCommand[],
  ): Promise<ManagementCommandResult[]> {
    const results: ManagementCommandResult[] = [];

    for (const command of commands) {
      if (command.expiresAt <= this.clock.now()) {
        results.push({
          commandId: command.commandId,
          success: false,
          message: "Management command expired before execution.",
          executedAt: this.clock.now(),
        });
        continue;
      }

      const result =
        command.type === "MODIFY_STOP"
          ? await this.adapter.modifyPosition(
              command.ticket,
              command.stopLoss,
              command.takeProfit,
              command.commandId,
            )
          : await this.adapter.closePosition(
              command.ticket,
              command.volume,
              command.commandId,
            );

      results.push(
        await this.synchronizeLifecycle(command, result),
      );
    }

    return results;
  }

  private async synchronizeLifecycle(
    command: ManagementCommand,
    result: ManagementCommandResult,
  ): Promise<ManagementCommandResult> {
    if (!result.success || !this.repository) {
      return result;
    }

    try {
      const record = await this.repository.findByTicket(
        command.ticket,
      );

      if (!record) {
        throw new Error(
          `Execution record for ticket ${command.ticket} was not found.`,
        );
      }

      if (!record.receipt) {
        throw new Error(
          `Execution record ${record.id} has no broker receipt.`,
        );
      }

      const brokerPositions =
        await this.adapter.getOpenPositions();
      const brokerPosition = brokerPositions.find(
        (position) => position.ticket === command.ticket,
      );

      const nextRecord = this.createSynchronizedRecord(
        record,
        brokerPosition,
        result.executedAt,
      );

      await this.repository.update(nextRecord);
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown lifecycle synchronization error.";

      return {
        ...result,
        success: false,
        message:
          `${result.message} ` +
          `Execution record lifecycle synchronization failed: ${message}`,
      };
    }
  }

  private createSynchronizedRecord(
    record: ExecutionRecord,
    brokerPosition:
      | Awaited<
          ReturnType<IExecutionAdapter["getOpenPositions"]>
        >[number]
      | undefined,
    executedAt: number,
  ): ExecutionRecord {
    if (!record.receipt) {
      throw new Error(
        `Execution record ${record.id} has no broker receipt.`,
      );
    }

    if (!brokerPosition) {
      return {
        ...record,
        status: "CLOSED",
        receipt: {
          ...record.receipt,
          position: record.receipt.position
            ? {
                ...record.receipt.position,
                closedAt: executedAt,
              }
            : undefined,
        },
        updatedAt: executedAt,
      };
    }

    if (
      !["FILLED", "PARTIALLY_FILLED"].includes(record.status)
    ) {
      throw new Error(
        `Execution record ${record.id} is ${record.status} ` +
        `while broker ticket ${brokerPosition.ticket} is still open.`,
      );
    }

    return {
      ...record,
      receipt: {
        ...record.receipt,
        position: structuredClone(brokerPosition),
      },
      updatedAt: executedAt,
    };
  }
}