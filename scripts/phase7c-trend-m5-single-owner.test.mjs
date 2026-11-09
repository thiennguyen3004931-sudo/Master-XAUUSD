import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const accountModeWrapperSource = fs.readFileSync(
  new URL("./run-phase7c-trend-account-mode.mjs", import.meta.url),
  "utf8",
);
const canonicalRunnerSource = fs.readFileSync(
  new URL("./run-phase7c-trend-controller.mjs", import.meta.url),
  "utf8",
);

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("M5 source transforms have one canonical owner", () => {
  assert.doesNotMatch(
    accountModeWrapperSource,
    /transformPhase7CTrendM5TrailingSource/,
    "Account-mode wrapper must not apply the M5 structural adapter; the canonical Trend runner owns it.",
  );
  assert.doesNotMatch(
    accountModeWrapperSource,
    /transformPhase7CTrendM5PreStructureProfitLockSource/,
    "Account-mode wrapper must not apply the M5 pre-structure/FastMove adapter; the canonical Trend runner owns it.",
  );

  assert.equal(
    countMatches(canonicalRunnerSource, /source = transformPhase7CTrendM5TrailingSource\(source\);/g),
    1,
    "Canonical Trend runner must apply the M5 structural adapter exactly once.",
  );
  assert.equal(
    countMatches(canonicalRunnerSource, /source = transformPhase7CTrendM5PreStructureProfitLockSource\(source\);/g),
    1,
    "Canonical Trend runner must apply the M5 pre-structure/FastMove adapter exactly once.",
  );
  assert.match(
    canonicalRunnerSource,
    /source = transformPhase7CTrendM5TrailingSource\(source\);[\s\S]*?source = transformPhase7CTrendM5PreStructureProfitLockSource\(source\);[\s\S]*?source = transformPhase7CSemiTrendRuntimeSource\(source\);/,
    "Canonical order must remain M5 structural -> M5 pre-structure/FastMove -> SEMI.",
  );
});
