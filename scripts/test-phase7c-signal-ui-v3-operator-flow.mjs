import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pagePath = "apps/web/src/pages/Phase7BPatternCheckPage.tsx";
const source = readFileSync(pagePath, "utf8");

function requireText(text, message) {
  assert.ok(source.includes(text), message);
}

function forbidText(text, message) {
  assert.ok(!source.includes(text), message);
}

requireText("SIGNAL UI V3", "Signal page must identify the approved SIGNAL UI V3 contract.");
requireText("OPERATOR DECISION FLOW", "Signal page must identify the operator decision flow.");
requireText("BOT ĐANG LÀM GÌ?", "Signal page must lead with the bot's current action/state.");
requireText("ĐANG CHỜ ĐIỀU KIỆN NÀO?", "Signal page must expose the active entry pipeline.");
requireText("CHIẾN LƯỢC ĐANG HOẠT ĐỘNG", "Signal page must prioritize the effective strategy.");
requireText("CHI TIẾT KỸ THUẬT", "Raw diagnostics must be available behind a technical-details disclosure.");
requireText("LÝ DO CHƯA VÀO LỆNH", "WAITING state must keep the canonical human-readable reason section.");
requireText("VỊ THẾ ĐANG QUẢN LÝ", "MANAGING state must retain canonical position monitoring.");

forbidText('title="UI State"', "The redundant UI State summary card must be removed.");
forbidText('title="Decision"', "The redundant Decision summary card must be removed.");

requireText("fetchPhase7CWebStatus", "V3 must keep the existing canonical read-only web status source.");
requireText("getTradeUiState", "V3 must keep semantic UI state derivation.");
requireText("ui?.entryChecks?.trend", "V3 must use canonical Trend entry diagnostics.");
requireText("ui?.entryChecks?.sideway", "V3 must use canonical Sideway entry diagnostics.");
requireText("ui?.setup", "V3 must use canonical setup data.");
requireText("ui?.position", "V3 must use canonical position data.");

assert.ok(
  !/const\s+activeStrategy\s*=\s*sidewayActive\s*\?\s*"SIDEWAY"\s*:\s*"TREND"/s.test(source),
  "V3 must not silently default an unknown effective strategy to TREND.",
);
assert.ok(
  /const\s+activeStrategy\s*=\s*normalizedStrategy\.includes\("TREND"\)[\s\S]*?normalizedStrategy\.includes\("SIDEWAY"\)[\s\S]*?:\s*"—";/s.test(source),
  "V3 must preserve an explicit unknown strategy instead of inferring TREND/SIDEWAY.",
);

forbidText('method: "POST"', "Signal UI V3 page must remain read-only.");
forbidText("method: 'POST'", "Signal UI V3 page must remain read-only.");
forbidText('method: "PUT"', "Signal UI V3 page must remain read-only.");
forbidText('method: "PATCH"', "Signal UI V3 page must remain read-only.");
forbidText('method: "DELETE"', "Signal UI V3 page must remain read-only.");

console.log("PHASE7C_SIGNAL_UI_V3_OPERATOR_FLOW_CONTRACT=PASS");
