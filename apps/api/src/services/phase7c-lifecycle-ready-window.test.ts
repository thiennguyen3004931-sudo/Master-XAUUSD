import assert from "node:assert/strict";
import { test } from "node:test";
import * as lifecycle from "./phase7c-lifecycle.service";

const evaluate = (lifecycle as any).evaluatePhase7CReadyWindow as
  | ((input: {
      startedAt: number;
      now: number;
      ready: boolean;
      readySince: number | null;
      acquireTimeoutMs?: number;
      stableMs?: number;
    }) => { state: string; readySince: number | null })
  | undefined;

function decision(input: {
  startedAt: number;
  now: number;
  ready: boolean;
  readySince: number | null;
  acquireTimeoutMs?: number;
  stableMs?: number;
}) {
  assert.equal(typeof evaluate, "function", "evaluatePhase7CReadyWindow export is required");
  return evaluate!(input);
}

test("exports the READY timing evaluator", () => {
  assert.equal(typeof evaluate, "function", "evaluatePhase7CReadyWindow export is required");
});

test("late READY acquired before 50s receives the full 5s stability window", () => {
  const startedAt = 1_000_000;

  const acquired = decision({
    startedAt,
    now: startedAt + 49_000,
    ready: true,
    readySince: null,
  });
  assert.deepEqual(acquired, {
    state: "WAITING_FOR_STABILITY",
    readySince: startedAt + 49_000,
  });

  const stillStabilizing = decision({
    startedAt,
    now: startedAt + 50_000,
    ready: true,
    readySince: acquired.readySince,
  });
  assert.deepEqual(stillStabilizing, {
    state: "WAITING_FOR_STABILITY",
    readySince: startedAt + 49_000,
  });

  const passed = decision({
    startedAt,
    now: startedAt + 54_000,
    ready: true,
    readySince: acquired.readySince,
  });
  assert.deepEqual(passed, {
    state: "PASS",
    readySince: startedAt + 49_000,
  });
});

test("READY flap after the 50s acquire deadline fails closed", () => {
  const startedAt = 2_000_000;
  const acquiredAt = startedAt + 49_000;

  const acquired = decision({
    startedAt,
    now: acquiredAt,
    ready: true,
    readySince: null,
  });
  assert.equal(acquired.state, "WAITING_FOR_STABILITY");

  const failed = decision({
    startedAt,
    now: startedAt + 52_000,
    ready: false,
    readySince: acquired.readySince,
  });
  assert.deepEqual(failed, {
    state: "FAIL",
    readySince: null,
  });
});

test("never acquiring READY by 50s fails closed", () => {
  const startedAt = 3_000_000;

  const beforeDeadline = decision({
    startedAt,
    now: startedAt + 49_999,
    ready: false,
    readySince: null,
  });
  assert.deepEqual(beforeDeadline, {
    state: "WAITING_FOR_READY",
    readySince: null,
  });

  const failed = decision({
    startedAt,
    now: startedAt + 50_000,
    ready: false,
    readySince: null,
  });
  assert.deepEqual(failed, {
    state: "FAIL",
    readySince: null,
  });
});
