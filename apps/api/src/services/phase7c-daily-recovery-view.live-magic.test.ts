import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePhase7CDailyRecoveryMagicNumbers,
} from "./phase7c-daily-recovery-view.service";

test("Daily Recovery uses LIVE trend magic when Phase 7C account mode is LIVE and API env has no MT5_MAGIC_NUMBER", () => {
  const resolved = resolvePhase7CDailyRecoveryMagicNumbers({
    accountMode: "LIVE",
    env: {},
  });

  assert.deepEqual(resolved, {
    trendMagicNumber: 270715,
    sidewayMagicNumber: 270714,
    configuredMagicNumbers: [270715, 270714],
  });
});

test("Daily Recovery keeps DEMO trend magic when Phase 7C account mode is DEMO and API env has no MT5_MAGIC_NUMBER", () => {
  const resolved = resolvePhase7CDailyRecoveryMagicNumbers({
    accountMode: "DEMO",
    env: {},
  });

  assert.deepEqual(resolved, {
    trendMagicNumber: 270713,
    sidewayMagicNumber: 270714,
    configuredMagicNumbers: [270713, 270714],
  });
});

test("Daily Recovery ignores generic bridge MT5_MAGIC_NUMBER when canonical account mode is LIVE", () => {
  const resolved = resolvePhase7CDailyRecoveryMagicNumbers({
    accountMode: "LIVE",
    env: {
      // The persistent API/Web Scheduled Task can still be launched with
      // the DEMO BridgeEnv after the canonical Phase 7C account mode
      // has switched to LIVE. This generic bridge magic must not override
      // the canonical LIVE Trend strategy magic.
      MT5_MAGIC_NUMBER: "270713",
      ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER: "990002",
    },
  });

  assert.deepEqual(resolved, {
    trendMagicNumber: 270715,
    sidewayMagicNumber: 990002,
    configuredMagicNumbers: [270715, 990002],
  });
});
