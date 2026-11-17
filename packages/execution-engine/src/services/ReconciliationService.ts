import type {
  IClock,
  IExecutionAdapter,
  IExecutionRepository,
} from "../contracts";
import type { ReconciliationResult } from "../models";
import { NumberUtils, SystemClock } from "../utils";

export class ReconciliationService {
  constructor(
    private readonly adapter: IExecutionAdapter,
    private readonly repository: IExecutionRepository,
    private readonly clock: IClock = new SystemClock(),
  ) {}

  async reconcile(symbol?: string): Promise<ReconciliationResult> {
    const [brokerPositions, localRecords] = await Promise.all([
      this.adapter.getOpenPositions(symbol),
      this.repository.listOpen(),
    ]);

    const brokerByTicket = new Map(
      brokerPositions.map((position) => [position.ticket, position]),
    );
    const localByTicket = new Map(
      localRecords.flatMap((record) =>
        record.receipt?.ticket
          ? [[record.receipt.ticket, record] as const]
          : [],
      ),
    );

    const missingAtBroker = localRecords.filter((record) => {
      const ticket = record.receipt?.ticket;
      return ticket ? !brokerByTicket.has(ticket) : true;
    });

    const missingLocally = brokerPositions.filter(
      (position) => !localByTicket.has(position.ticket),
    );

    const volumeMismatches = localRecords.flatMap((record) => {
      const ticket = record.receipt?.ticket;
      const localVolume =
        record.receipt?.position?.volume ??
        record.receipt?.filledVolume;
      if (!ticket || localVolume === undefined) return [];

      const broker = brokerByTicket.get(ticket);
      if (!broker || Math.abs(broker.volume - localVolume) < 1e-8) {
        return [];
      }

      return [{
        ticket,
        localVolume: NumberUtils.round(localVolume),
        brokerVolume: NumberUtils.round(broker.volume),
      }];
    });

    return {
      missingAtBroker,
      missingLocally,
      volumeMismatches,
      consistent:
        missingAtBroker.length === 0 &&
        missingLocally.length === 0 &&
        volumeMismatches.length === 0,
      generatedAt: this.clock.now(),
    };
  }
}
