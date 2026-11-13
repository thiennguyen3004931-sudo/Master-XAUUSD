import { describe, expect, it } from "vitest";
import {
  AiResponseParser,
  ConsensusService,
  StaticAiProvider,
  defaultAiEngineConfig
} from "../src";
import {
  opinion
} from "./fixtures";

describe("ConsensusService", () => {
  it("uses conservative tie-breaking", async () => {
    const parser = new AiResponseParser(
      defaultAiEngineConfig
    );
    const request = {
      requestId: "r",
      promptVersion: "v",
      schemaVersion: "1.0.0",
      messages: [],
      features: {} as never,
      metadata: {},
      createdAt: 1
    };
    const providers = [
      new StaticAiProvider(
        "a",
        "m",
        opinion("CONFIRM")
      ),
      new StaticAiProvider(
        "b",
        "m",
        opinion("REJECT")
      )
    ];
    const opinions = await Promise.all(
      providers.map(async (provider) =>
        parser.parse(
          await provider.generate(request)
        )
      )
    );

    const consensus =
      new ConsensusService({
        ...defaultAiEngineConfig,
        minimumProviderCount: 1
      }).create(opinions);

    expect(consensus?.action).toBe("REJECT");
    expect(consensus?.agreementRatio).toBe(0.5);
  });
});
