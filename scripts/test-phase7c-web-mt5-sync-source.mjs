import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const forbidText = (source, needle, label) => {
  if (source.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};

const semantic = read("apps/api/src/services/phase7c-ui-contract.service.ts");
const web = read("apps/web/src/pages/Phase7BDemoPage.tsx");
const mt5 = read("mt5/XAUUSD_AI_Master_Decision_Panel.mq5");
const installer = read("scripts/install-phase7c-mt5-decision-panel-local.ps1");
const dualInstaller = read("scripts/install-phase7c-mt5-decision-panel-both-accounts-local.ps1");
const syncDeploy = read("scripts/deploy-phase7c-web-mt5-sync-local.ps1");
const e2e = read("scripts/run-phase7c-demo-e2e-local.ps1");

for (const key of ["auto", "trendWait", "sidewayWait", "entry", "hold", "stopMove", "partial", "exit"]) {
  requireText(semantic, `${key}:`, `semantic reason group ${key}`);
}

// Expected entry-gate rejections are decision state, not UI/system errors.
// Filter only the canonical Phase7C blocked codes; never suppress HTTP 423
// generically because an unknown 423 must remain observable.
for (const marker of [
  "isExpectedEntryBlockedReason",
  "PHASE7C_(?:TREND|SIDEWAY)_ENTRY_BLOCKED",
  "if (isExpectedEntryBlockedReason(raw)) return;",
]) {
  requireText(semantic, marker, `expected entry-blocked display filter ${marker}`);
}
forbidText(semantic, "status === 423", "generic HTTP 423 suppression");
forbidText(semantic, "status == 423", "generic HTTP 423 suppression");
requireText(web, "ui.reasons.trendWait", "Web Trend wait reasons must use semantic UI");
requireText(web, "ui.reasons.sidewayWait", "Web Sideway wait reasons must use semantic UI");

requireText(
  semantic,
  'upper === "CYCLE_ERROR"',
  "cycle error must be handled as a friendly wait reason",
);
requireText(
  semantic,
  "chưa lấy được dữ liệu trong chu kỳ gần nhất",
  "cycle error must not expose raw fetch failure text",
);
requireText(
  semantic,
  "ENTRY_SUBMIT|ENTRY_SUBMITTED",
  "entry submit lifecycle events must be excluded from wait reasons",
);
for (const key of [
  "accountMode",
  "autoReason1",
  "trendWaitReason1",
  "sidewayWaitReason1",
  "entryReason1",
  "holdReason1",
  "stopMoveReason1",
  "partialReason1",
  "exitReason1",
  "mt5OrderPermission",
]) {
  requireText(semantic, `["${key}"`, `MT5 formatter key ${key}`);
}
for (const marker of [
  "trendCheck${number}Status",
  "trendCheck${number}Label",
  "trendCheck${number}Actual",
  "sidewayCheck${number}Status",
  "sidewayCheck${number}Label",
  "sidewayCheck${number}Actual",
]) {
  requireText(semantic, marker, `MT5 structured entry-check formatter ${marker}`);
}

for (const title of [
  "AUTO / REGIME — LÝ DO CHỌN STRATEGY",
  "TREND — LÝ DO CHƯA VÀO LỆNH",
  "SIDEWAY — LÝ DO CHƯA VÀO LỆNH",
  "LÝ DO VÀO LỆNH",
  "LÝ DO GIỮ LỆNH",
  "LÝ DO DỜI STOP LOSS",
  "LÝ DO CHỐT 1/3",
  "LÝ DO ĐÓNG TOÀN BỘ",
]) {
  requireText(web, title, `Web semantic section ${title}`);
}

requireText(mt5, '#property version   "1.40"', "MT5 synchronized panel version");
requireText(mt5, "DEMO/LIVE", "MT5 account-aware safety marker");
requireText(mt5, "LocalAccountMode()", "MT5 local terminal account detection");
requireText(mt5, "RuntimeMatchesTerminal", "MT5 runtime/terminal mismatch guard");
requireText(mt5, 'Field(payload, "accountMode")', "MT5 runtime account label");
for (const key of [
  "autoReason1",
  "waitReason1",
  "entryReason1",
  "holdReason1",
  "stopMoveReason1",
  "partialReason1",
  "exitReason1",
]) {
  requireText(mt5, `Field(payload, "${key}")`, `MT5 semantic reason ${key}`);
}
for (const marker of [
  "FirstEntryBlocker",
  'prefix + "Check" + suffix + "Status"',
  'prefix + "Check" + suffix + "Label"',
  'prefix + "Check" + suffix + "Actual"',
  'DrawEntryCheckSummary(payload, width, 286)',
]) {
  requireText(mt5, marker, `MT5 structured entry-check binding ${marker}`);
}
for (const label of [
  "LÝ DO QUYẾT ĐỊNH",
  "ĐIỀU KIỆN CHẶN ENTRY",
  "AUTO/REGIME",
  "TREND",
  "SIDEWAY",
  "KẾT LUẬN",
  "VÀO LỆNH",
  "GIỮ LỆNH",
  "DỜI SL",
  "CHỐT 1/3",
  "ĐÓNG TOÀN BỘ",
]) {
  requireText(mt5, label, `MT5 compact semantic label ${label}`);
}
forbidText(mt5, '"DEMO · CHỈ ĐỌC"', "hard-coded MT5 DEMO label");
for (const forbidden of ["OrderSend", "CTrade", "PositionClose", "PositionModify"]) {
  forbidText(mt5, forbidden, "MT5 panel execution mutation");
}
requireText(mt5, "ORDER PERMISSION = NONE", "MT5 read-only order marker");

for (const marker of [
  "DEMO/LIVE",
  "RuntimeMatchesTerminal",
  "autoReason1",
  "trendWaitReason1",
  "sidewayWaitReason1",
  "stopMoveReason1",
  "partialReason1",
  "exitReason1",
  "SEMANTIC_UI_V2",
  "ORDER_PERMISSION=NONE",
]) {
  requireText(installer, marker, `single-account installer ${marker}`);
}
requireText(dualInstaller, ".env.phase7b-demo", "dual installer DEMO profile");
requireText(dualInstaller, ".env.phase7b-live", "dual installer LIVE profile");
requireText(dualInstaller, "PHASE7C_MT5_PANEL_SYNC_DEMO=PASS", "dual installer DEMO pass marker");
requireText(dualInstaller, "PHASE7C_MT5_PANEL_SYNC_LIVE=PASS", "dual installer LIVE pass marker");
requireText(dualInstaller, "PHASE7C_MT5_PANEL_SYNC_EXECUTION_MUTATION=False", "dual installer mutation boundary");

for (const marker of [
  "deploy-phase7c-web-ui-local.ps1",
  "install-phase7c-mt5-decision-panel-both-accounts-local.ps1",
  "PHASE7C_WEB_MT5_SYNC_RUNTIME_PRESERVED=PASS",
  "PHASE7C_WEB_MT5_SYNC_SEMANTIC_CONTRACT=PASS",
  "PHASE7C_WEB_MT5_SYNC_MT5_ORDER_PERMISSION=NONE",
  "PHASE7C_WEB_MT5_SYNC_STRATEGY_CHANGED=False",
  "PHASE7C_WEB_MT5_SYNC_RISK_CHANGED=False",
]) {
  requireText(syncDeploy, marker, `sync deploy ${marker}`);
}
for (const forbidden of ["phase7c-account-switch/execute", "arm-phase7c-live-local.ps1", "order_send", "/v1/orders"]) {
  forbidText(syncDeploy, forbidden, "sync deploy mutation boundary");
}

for (const marker of [
  "ConfirmDemoExecution",
  "phase7c-account-switch/preflight",
  "phase7c-account-switch/execute",
  "api/v1/phase7c-ui?symbol=XAUUSD",
  "api/v1/mt5/performance?days=90&symbol=XAUUSD",
  'ownership -eq "SYSTEM"',
  'Set-BotMode -Mode "AUTO"',
  'Set-BotMode -Mode "PAUSE"',
  "PHASE7C_DEMO_E2E=PASS",
  "PHASE7C_DEMO_E2E_FINAL_ACCOUNT=DEMO",
  "PHASE7C_DEMO_E2E_LIVE_EXECUTION=False",
  "PHASE7C_DEMO_E2E_MANUAL_ORDER_SEND=False",
]) {
  requireText(e2e, marker, `DEMO E2E ${marker}`);
}
for (const forbidden of ["order_send", "/v1/orders", "arm-phase7c-live-local.ps1", "-TargetMode LIVE"]) {
  forbidText(e2e, forbidden, "DEMO E2E direct/live mutation boundary");
}

console.log("PHASE7C_WEB_MT5_SYNC_SOURCE_TEST=PASS");
