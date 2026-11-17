import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const uiSource = fs.readFileSync(
  new URL("../apps/api/src/services/phase7c-ui-contract.service.ts", import.meta.url),
  "utf8",
);
const panelSource = fs.readFileSync(
  new URL("../mt5/XAUUSD_AI_Master_Decision_Panel.mq5", import.meta.url),
  "utf8",
);

test("UI MT5 contract preserves the broker position count for anomalous open risk", () => {
  assert.match(
    uiSource,
    /position:\s*null\s*\|\s*\{[\s\S]*?state:\s*string;[\s\S]*?count:\s*number;[\s\S]*?strategy:\s*string\s*\|\s*null;/,
    "Phase7C UI position contract must retain snapshot.position.count instead of dropping the broker count",
  );
  assert.match(
    uiSource,
    /const position = state === "MANAGING" \? \{[\s\S]*?state: snapshot\.position\.state,[\s\S]*?count: snapshot\.position\.count,/,
    "MANAGING UI projection must carry the real XAUUSD position count",
  );
  assert.match(
    uiSource,
    /\["positionCount",\s*position\?\.count\]/,
    "MT5 text payload must expose positionCount so the terminal can diagnose multiple-position anomalies",
  );
});

test("MT5 MANAGING card warns instead of claiming a UNMANAGED position is being held normally", () => {
  assert.match(
    panelSource,
    /DrawManaging\([\s\S]*?Field\(payload,\s*"positionState"\)/,
    "DrawManaging must inspect canonical positionState",
  );
  assert.match(
    panelSource,
    /DrawManaging\([\s\S]*?Field\(payload,\s*"positionCount"\)/,
    "DrawManaging must inspect canonical positionCount",
  );
  assert.match(
    panelSource,
    /position_state\s*==\s*"UNMANAGED"[\s\S]*?(?:VỊ THẾ|UNMANAGED|BẤT THƯỜNG|CHƯA ĐƯỢC QUẢN LÝ)/i,
    "UNMANAGED state must render an explicit warning title instead of the green ĐANG GIỮ LỆNH claim",
  );
  assert.match(
    panelSource,
    /position_count[\s\S]*?(?:vị thế|position)/i,
    "the warning card must make the anomalous broker position count visible",
  );
});
