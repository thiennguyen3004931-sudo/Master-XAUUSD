import { describe, expect, it } from "vitest";
import type {
  IAiProvider
} from "../src";
import {
  AiDecisionEngine,
  InMemoryAiAuditRepository,
  InMemoryAiCache,
  StaticAiProvider
} from "../src";
import {
  createContext,
  opinion
} from "./fixtures";

class CountingProvider
  extends StaticAiProvider
  implements IAiProvider
{
  calls = 0;

  override async generate(
    request: Parameters<
      StaticAiProvider["generate"]
    >[0]
  ) {
    this.calls += 1;
    return super.generate(request);
  }
}

describe("cache and audit", () => {
  it("returns cached decisions without a second provider call", async () => {
    const provider = new CountingProvider(
      "counter",
      "model",
      opinion("CONFIRM")
    );
    const audit =
      new InMemoryAiAuditRepository();
    const engine = new AiDecisionEngine(
      [provider],
      {},
      new InMemoryAiCache(),
      audit
    );

    await engine.review(createContext());
    await engine.review(createContext());

    expect(provider.calls).toBe(1);
    expect(await audit.list()).toHaveLength(1);
  });
});
