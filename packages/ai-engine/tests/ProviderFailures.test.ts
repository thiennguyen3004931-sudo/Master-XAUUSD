import { describe, expect, it } from "vitest";
import type {
  IAiProvider
} from "../src";
import {
  AiDecisionEngine
} from "../src";
import {
  createContext
} from "./fixtures";

class InvalidJsonProvider
  implements IAiProvider
{
  readonly id = "invalid-json";
  readonly kind = "LOCAL" as const;
  readonly model = "broken";

  async generate(request: Parameters<
    IAiProvider["generate"]
  >[0]) {
    return {
      providerId: this.id,
      providerKind: this.kind,
      model: this.model,
      requestId: request.requestId,
      content: "not-json",
      latencyMs: 0,
      createdAt: request.createdAt
    };
  }
}

describe("provider failures", () => {
  it("fails closed when all providers fail", async () => {
    const result = await new AiDecisionEngine(
      [new InvalidJsonProvider()],
      {
        providerMaxRetries: 0
      }
    ).review(createContext());

    expect(result.executable).toBe(false);
    expect(result.providerFailures).toHaveLength(1);
    expect(result.diagnostics.rejectionCodes).toContain(
      "ALL_PROVIDERS_FAILED"
    );
  });
});
