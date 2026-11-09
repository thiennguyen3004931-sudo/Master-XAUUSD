import type {
  IAiAuditRepository,
  IClock
} from "../contracts";
import type {
  AiDecision,
  AiProviderRequest
} from "../models";
import {
  IdFactory,
  SystemClock
} from "../utils";

export class AiAuditService {
  constructor(
    private readonly repository:
      IAiAuditRepository,
    private readonly clock: IClock =
      new SystemClock(),
    private readonly ids = new IdFactory()
  ) {}

  async record(
    request: AiProviderRequest,
    decision: AiDecision
  ): Promise<void> {
    const createdAt = this.clock.now();
    await this.repository.save({
      id: this.ids.create(
        "ai-audit",
        createdAt
      ),
      request,
      decision,
      createdAt
    });
  }
}
