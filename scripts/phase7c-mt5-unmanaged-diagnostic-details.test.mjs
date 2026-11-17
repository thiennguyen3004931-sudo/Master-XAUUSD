import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const monitorPath = "apps/api/src/services/phase7c-decision-monitor.service.ts";
const mt5Path = "mt5/XAUUSD_AI_Master_Decision_Panel.mq5";

const monitorSource = readFileSync(monitorPath, "utf8");
const mt5Source = readFileSync(mt5Path, "utf8");

assert.match(
  monitorSource,
  /const\s+inferredTp1\s*=\s*side\s*===\s*"BUY"\s*\?\s*position\.entry\s*\+\s*10\s*:\s*position\.entry\s*-\s*10\s*;/,
  "Decision monitor must continue exposing that position.tp1 can be inferred from the broker reference position.",
);
assert.match(
  monitorSource,
  /const\s+tp1\s*=\s*finite\(managed\?\.tp1\)\s*\?\?\s*finite\(entryPlan\?\.tp1\)\s*\?\?\s*inferredTp1\s*;/,
  "The test premise requires inferredTp1 to remain the final fallback when executor-owned TP data is absent.",
);

const planStart = mt5Source.indexOf("void DrawTradePlan");
const planEnd = mt5Source.indexOf("color EntryCheckTone", planStart);
assert.ok(planStart >= 0 && planEnd > planStart, "DrawTradePlan block was not found.");
const plan = mt5Source.slice(planStart, planEnd);

assert.match(
  plan,
  /Field\(payload,\s*"positionState"\)/,
  "DrawTradePlan must inspect canonical positionState before presenting managed-position details.",
);
assert.match(
  plan,
  /position_unmanaged\s*=\s*managing\s*&&\s*position_state\s*==\s*"UNMANAGED"/,
  "DrawTradePlan must distinguish UNMANAGED from canonical MANAGING state.",
);
assert.match(
  plan,
  /string\s+tp\s*=\s*position_unmanaged\s*\?\s*"n\/a"\s*:/,
  "UNMANAGED must fail closed instead of rendering inferred positionTp1/positionTp2 as a management target.",
);
assert.match(
  plan,
  /string\s+tp_label\s*=\s*position_unmanaged\s*\?\s*"TP KHÔNG QUẢN LÝ"\s*:/,
  "UNMANAGED TP card must explicitly say it is not a managed target.",
);
assert.match(
  plan,
  /Card\(bx3,[\s\S]*?position_unmanaged\s*\?[^\n]*C'35,18,18'[^\n]*:/,
  "UNMANAGED TP card must use an error/fail-closed background rather than the managed green card.",
);

const managingStart = mt5Source.indexOf("void DrawManaging");
const managingEnd = mt5Source.indexOf("void RenderPanel", managingStart);
assert.ok(managingStart >= 0 && managingEnd > managingStart, "DrawManaging block was not found.");
const managingBlock = mt5Source.slice(managingStart, managingEnd);

assert.match(
  managingBlock,
  /position_unmanaged\s*\?\s*"P\/L tham chiếu: "\s*:\s*"Lãi\/lỗ: "/,
  "UNMANAGED first-position P/L must be labeled as a reference diagnostic rather than canonical managed P/L.",
);

console.log("PHASE7C_MT5_UNMANAGED_DIAGNOSTIC_DETAILS=PASS");
