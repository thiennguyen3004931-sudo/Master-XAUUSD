import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const webPath = "apps/web/src/pages/Phase7CControlCenterPage.tsx";
const monitorPath = "apps/api/src/services/phase7c-decision-monitor.service.ts";

const webSource = readFileSync(webPath, "utf8");
const monitorSource = readFileSync(monitorPath, "utf8");

assert.match(
  monitorSource,
  /state:\s*strategy\s*\?\s*"MANAGING"\s+as\s+const\s*:\s*"UNMANAGED"\s+as\s+const,[\s\S]*?count:\s*positions\.length,/,
  "Decision monitor must continue exposing the real broker count while classifying non-owned open risk as UNMANAGED.",
);

const stateStart = webSource.indexOf("const position = decision?.position;");
const stateEnd = webSource.indexOf("const isLiveAccount", stateStart);
assert.ok(stateStart >= 0 && stateEnd > stateStart, "Control Center position-state projection block was not found.");
const stateBlock = webSource.slice(stateStart, stateEnd);

assert.match(
  stateBlock,
  /const\s+managing\s*=\s*position\?\.state\s*===\s*"MANAGING"\s*;/,
  "Web must reserve managing=true for canonical MANAGING ownership only.",
);
assert.match(
  stateBlock,
  /const\s+unmanaged\s*=\s*position\?\.state\s*===\s*"UNMANAGED"\s*;/,
  "Web must track UNMANAGED open risk separately from canonical MANAGING state.",
);
assert.match(
  stateBlock,
  /const\s+(?:hasOpenPosition|openPosition)\s*=\s*managing\s*\|\|\s*unmanaged\s*;/,
  "Web must keep anomalous open broker risk visible without calling it canonically managed.",
);
assert.doesNotMatch(
  stateBlock,
  /const\s+managing\s*=\s*position\?\.state\s*===\s*"MANAGING"\s*\|\|\s*position\?\.state\s*===\s*"UNMANAGED"/,
  "UNMANAGED must not be folded back into the managing boolean.",
);
assert.match(
  stateBlock,
  /const\s+displayedTp1\s*=\s*managing\s*\?[^;]*:\s*unmanaged\s*\?\s*null\s*:/,
  "UNMANAGED must fail closed instead of presenting inferred TP1 management levels from positions[0].",
);
assert.match(
  stateBlock,
  /const\s+displayedTp2\s*=\s*managing\s*\?[^;]*:\s*unmanaged\s*\?\s*null\s*:/,
  "UNMANAGED must fail closed instead of presenting inferred TP2 management levels from positions[0].",
);

const decisionCardStart = webSource.indexOf("Quyết định hiện tại · Web đồng bộ panel MT5");
const decisionCardEnd = webSource.indexOf("Nhật ký quyết định gần nhất", decisionCardStart);
assert.ok(decisionCardStart >= 0 && decisionCardEnd > decisionCardStart, "Current decision card block was not found.");
const decisionCard = webSource.slice(decisionCardStart, decisionCardEnd);

assert.match(
  decisionCard,
  /unmanaged\s*\?\s*"error"/,
  "UNMANAGED status chip must render as an error instead of success/warning management state.",
);
assert.match(
  decisionCard,
  /CẢNH BÁO[\s\S]*?position\?\.count|position\?\.count[\s\S]*?CẢNH BÁO/,
  "UNMANAGED Web status must visibly include a warning and the broker position count.",
);
assert.match(
  decisionCard,
  /tone=\{unmanaged\s*\?\s*"error\.main"/,
  "UNMANAGED primary status card must use the error tone.",
);
assert.match(
  decisionCard,
  /Broker diagnostic/,
  "First-position values kept visible during UNMANAGED must be explicitly labeled as broker diagnostics, not canonical managed truth.",
);

console.log("PHASE7C_WEB_UNMANAGED_MULTI_POSITION_STATUS=PASS");
