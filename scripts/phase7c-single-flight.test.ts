import assert from "node:assert/strict";
import { runPhase7CSingleFlight } from "../apps/api/src/services/phase7c-single-flight";

async function main(): Promise<void> {
  const inFlight = new Map<string, Promise<unknown>>();

  let releaseSameKey!: () => void;
  const sameKeyGate = new Promise<void>((resolve) => {
    releaseSameKey = resolve;
  });
  let sameKeyFactoryCalls = 0;
  const sameKeyFactory = async () => {
    sameKeyFactoryCalls += 1;
    await sameKeyGate;
    return { value: "shared" };
  };

  const first = runPhase7CSingleFlight(inFlight, "same-key", sameKeyFactory);
  const second = runPhase7CSingleFlight(inFlight, "same-key", sameKeyFactory);

  assert.strictEqual(
    second,
    first,
    "identical concurrent keys must reuse the exact same in-flight Promise",
  );
  assert.equal(sameKeyFactoryCalls, 1, "identical concurrent keys must execute the factory once");
  assert.equal(inFlight.size, 1, "one in-flight key must occupy one map entry");

  releaseSameKey();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, { value: "shared" });
  assert.deepEqual(secondResult, { value: "shared" });
  assert.equal(inFlight.size, 0, "resolved work must be removed from the in-flight map");

  let postResolveCalls = 0;
  const afterResolve = await runPhase7CSingleFlight(inFlight, "same-key", async () => {
    postResolveCalls += 1;
    return "fresh";
  });
  assert.equal(afterResolve, "fresh");
  assert.equal(postResolveCalls, 1, "single-flight must not become a stale result cache");

  let differentKeyCalls = 0;
  let releaseDifferentKeys!: () => void;
  const differentKeyGate = new Promise<void>((resolve) => {
    releaseDifferentKeys = resolve;
  });
  const differentA = runPhase7CSingleFlight(inFlight, "key-a", async () => {
    differentKeyCalls += 1;
    await differentKeyGate;
    return "a";
  });
  const differentB = runPhase7CSingleFlight(inFlight, "key-b", async () => {
    differentKeyCalls += 1;
    await differentKeyGate;
    return "b";
  });
  assert.equal(differentKeyCalls, 2, "different keys must not be coalesced");
  assert.equal(inFlight.size, 2, "different in-flight keys must remain independent");
  releaseDifferentKeys();
  assert.deepEqual(await Promise.all([differentA, differentB]), ["a", "b"]);
  assert.equal(inFlight.size, 0);

  let rejectionCalls = 0;
  await assert.rejects(
    runPhase7CSingleFlight(inFlight, "retry-key", async () => {
      rejectionCalls += 1;
      throw new Error("expected-first-failure");
    }),
    /expected-first-failure/,
  );
  assert.equal(inFlight.size, 0, "rejected work must be removed from the in-flight map");

  const retryResult = await runPhase7CSingleFlight(inFlight, "retry-key", async () => {
    rejectionCalls += 1;
    return "retry-success";
  });
  assert.equal(retryResult, "retry-success");
  assert.equal(rejectionCalls, 2, "a rejection must not poison future requests for the same key");

  console.log("PHASE7C_SINGLE_FLIGHT_SEMANTIC=PASS");
  console.log("SAME_KEY_FACTORY_CALLS=1");
  console.log("SAME_KEY_PROMISE_REUSE=PASS");
  console.log("DIFFERENT_KEYS_ISOLATED=PASS");
  console.log("POST_RESOLVE_CACHE=NONE");
  console.log("REJECTION_RETRY=PASS");
}

main().catch((error) => {
  console.error("PHASE7C_SINGLE_FLIGHT_SEMANTIC=FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
