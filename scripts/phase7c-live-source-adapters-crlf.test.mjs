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

function asWindowsCrlf(source) {
  return source.replace(/\r?\n/g, "\r\n");
}

test("LIVE Trend adapter accepts Windows CRLF controller source", () => {
  const source = asWindowsCrlf(
    fs.readFileSync(path.join(here, "run-phase7b-demo-controller.ts"), "utf8"),
  );
  const output = transformPhase7CTrendLegacySource(source);

  assert.match(output, /reconcileManagedVolume/);
  assert.match(output, /remainingManagedPartialVolume/);
  assert.doesNotMatch(output, /journal\("MANAGED_POSITION_VOLUME_MISMATCH"/);
});

test("LIVE Sideway adapter accepts Windows CRLF controller source", () => {
  const source = asWindowsCrlf(
    fs.readFileSync(path.join(here, "run-phase7c-sideway-controller.mjs"), "utf8"),
  );
  const output = transformPhase7CSidewaySource(source);

  assert.match(output, /reconcileManagedVolume/);
  assert.match(output, /remainingManagedPartialVolume/);
  assert.doesNotMatch(output, /const closeVolume = oneThirdPartialVolume\(/);
});

console.log("PHASE7C_LIVE_SOURCE_ADAPTER_CRLF_CONTRACT=PASS");
