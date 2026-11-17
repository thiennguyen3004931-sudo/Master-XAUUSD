import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  transformPhase7CSidewaySource,
  transformPhase7CTrendLegacySource,
} from "./phase7c-live-source-adapters.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = { minVolume: 0.01, volumeStep: 0.01 };
const baseManaged = {
  ticket: "304574820",
  side: "SELL",
  initialVolume: 0.12,
  expectedRemainingVolume: 0.12,
  partialApplied: false,
  partialActivatedAt: null,
  fixedTpEnabled: true,
  fixedTpDistance: 20,
  fixedTpPrice: 4282.47,
};

const moduleUrl = new URL("./phase7c-managed-volume-reconcile.mjs", import.meta.url);
const reconcileModule = await import(moduleUrl.href).catch(() => null);

assert.ok(
  reconcileModule,
  "RED_TARGET: shared managed-volume reconciliation helper must exist before controller integration can pass.",
);

const {
  reconcileManagedVolume,
  remainingManagedPartialVolume,
} = reconcileModule;

test("exact external one-third satisfies +10 without a second partial", () => {
  const result = reconcileManagedVolume(
    baseManaged,
    { ticket: "304574820", side: "SHORT", volume: 0.08 },
    spec,
    1788320000000,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.managed.expectedRemainingVolume, 0.08);
  assert.equal(result.managed.partialApplied, true);
  assert.equal(result.managed.partialActivatedAt, 1788320000000);
  assert.equal(remainingManagedPartialVolume(result.managed, 0.08, spec), 0);
});

test("external reduction below one-third reconciles and leaves only the missing obligation", () => {
  const result = reconcileManagedVolume(
    baseManaged,
    { ticket: "304574820", side: "SHORT", volume: 0.10 },
    spec,
    1788320000000,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.managed.expectedRemainingVolume, 0.10);
  assert.equal(result.managed.partialApplied, false);
  assert.equal(remainingManagedPartialVolume(result.managed, 0.10, spec), 0.02);
});

test("external reduction beyond one-third is accepted and never asks for more +10 volume", () => {
  const result = reconcileManagedVolume(
    baseManaged,
    { ticket: "304574820", side: "SHORT", volume: 0.01 },
    spec,
    1788320000000,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.managed.expectedRemainingVolume, 0.01);
  assert.equal(result.managed.partialApplied, true);
  assert.equal(remainingManagedPartialVolume(result.managed, 0.01, spec), 0);
  assert.equal(result.managed.fixedTpPrice, 4282.47);
});

test("broker volume increase fails closed", () => {
  const result = reconcileManagedVolume(
    baseManaged,
    { ticket: "304574820", side: "SHORT", volume: 0.13 },
    spec,
    1788320000000,
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "MANAGED_VOLUME_INCREASE");
});

test("ticket or side drift fails closed", () => {
  assert.equal(
    reconcileManagedVolume(baseManaged, { ticket: "DIFFERENT", side: "SHORT", volume: 0.08 }, spec, 1).reason,
    "MANAGED_TICKET_MISMATCH",
  );
  assert.equal(
    reconcileManagedVolume(baseManaged, { ticket: "304574820", side: "LONG", volume: 0.08 }, spec, 1).reason,
    "MANAGED_SIDE_MISMATCH",
  );
});

test("LIVE Trend adapter replaces hard volume mismatch block and +10 full-third close", () => {
  const trendSource = fs.readFileSync(path.join(here, "run-phase7b-demo-controller.ts"), "utf8");
  const output = transformPhase7CTrendLegacySource(trendSource);
  assert.match(output, /reconcileManagedVolume/);
  assert.match(output, /remainingManagedPartialVolume/);
  assert.doesNotMatch(output, /journal\("MANAGED_POSITION_VOLUME_MISMATCH"/);
  assert.doesNotMatch(output, /const closeVolume = partialVolume\(managed\.initialVolume, position\.volume, spec\);/);
});

test("LIVE Sideway adapter falls back to safe arbitrary-reduction reconcile and closes only missing +10 obligation", () => {
  const sidewaySource = fs.readFileSync(path.join(here, "run-phase7c-sideway-controller.mjs"), "utf8");
  const output = transformPhase7CSidewaySource(sidewaySource);
  assert.match(output, /reconcileManagedVolume/);
  assert.match(output, /remainingManagedPartialVolume/);
  assert.match(output, /MANAGED_VOLUME_MISMATCH/);
  assert.doesNotMatch(output, /const closeVolume = oneThirdPartialVolume\(/);
});

console.log("PHASE7C_MANAGED_VOLUME_SAFE_RECONCILIATION_CONTRACT=PASS");
