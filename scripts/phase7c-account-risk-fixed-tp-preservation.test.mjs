import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(
  path.join(root, "apps/web/src/pages/Phase7BOpsPage.tsx"),
  "utf8",
);

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `source must contain ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `source must contain ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("Account & Risk lot save carries forward all four canonical Fixed TP fields", () => {
  const fixedTpSnapshotType = block(page, "type FixedTpSnapshot =", "type LotSettingsMutationInput =");
  for (const field of [
    "trendFixedTpEnabled",
    "trendFixedTpDistance",
    "sidewayFixedTpEnabled",
    "sidewayFixedTpDistance",
  ]) {
    assert.match(
      fixedTpSnapshotType,
      new RegExp(`${field}\\s*:`),
      `RED_TARGET: Fixed TP mutation snapshot must carry canonical ${field}`,
    );
  }

  const mutationType = block(page, "type LotSettingsMutationInput =", "const LOT_SETTINGS_URL");
  assert.match(
    mutationType,
    /LotInput\s*&\s*FixedTpSnapshot/,
    "RED_TARGET: lot mutation input must compose lot/risk edits with the complete canonical Fixed TP snapshot.",
  );

  const canonicalRead = block(
    page,
    "const canonicalLotSettingsState =",
    "const currency =",
  );
  assert.match(
    canonicalRead,
    /data\?\.lotSettings[\s\S]*?\.state/,
    "RED_TARGET: Fixed TP preservation must come from the canonical lot-settings state, not a default or risk-view fallback.",
  );
  for (const field of [
    "trendFixedTpEnabled",
    "trendFixedTpDistance",
    "sidewayFixedTpEnabled",
    "sidewayFixedTpDistance",
  ]) {
    assert.match(
      canonicalRead,
      new RegExp(field),
      `RED_TARGET: canonical Fixed TP snapshot must include ${field}`,
    );
  }

  const submit = block(page, "const onSubmit = () => {", "const resetToSaved = () => {");
  assert.match(
    submit,
    /!canonicalFixedTp/,
    "RED_TARGET: lot save must fail closed when canonical Fixed TP state is unavailable.",
  );
  assert.match(
    submit,
    /mutation\.mutate\(\{[\s\S]*?\.\.\.draftLot[\s\S]*?\.\.\.canonicalFixedTp[\s\S]*?\}\)/,
    "RED_TARGET: lot mutation must update draft lot/risk while preserving the canonical Fixed TP snapshot unchanged.",
  );
});

test("Account & Risk UI makes missing canonical Fixed TP state an explicit save blocker", () => {
  assert.match(
    page,
    /!canonicalFixedTp[\s\S]*?<Alert[^>]*severity="warning"/,
    "RED_TARGET: operator must see why lot save is blocked when canonical Fixed TP state cannot be read.",
  );
  assert.match(
    page,
    /disabled=\{[\s\S]*?!canonicalFixedTp[\s\S]*?\}/,
    "RED_TARGET: Save button must be disabled rather than silently dropping Fixed TP fields.",
  );
});
