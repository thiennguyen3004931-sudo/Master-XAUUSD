import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

function forbidText(source, needle, label) {
  if (source.includes(needle)) throw new Error(`${label}: forbidden legacy text ${needle}`);
}

const performance = read("apps/api/src/services/mt5-performance.service.ts");
requireText(performance, 'source: "MT5_ACCOUNT_READ_ONLY"', "performance source");
requireText(performance, 'accountMode: "DEMO" | "LIVE"', "performance account mode");
requireText(performance, "readOnly: true", "performance safety");
forbidText(performance, "MT5 performance analytics is DEMO-only.", "performance LIVE support");
forbidText(performance, "/v1/orders", "performance mutation boundary");
forbidText(performance, "order_send", "performance mutation boundary");

const telemetry = read("apps/api/src/services/mt5.service.ts");
requireText(telemetry, "MT5 LIVE/real connected", "LIVE telemetry message");
forbidText(telemetry, "Phase 7B DEMO must not execute on this account", "legacy REAL warning");

const semantic = read("apps/api/src/services/phase7c-ui-contract.service.ts");
for (const key of ["auto", "trendWait", "sidewayWait", "stopMove", "partial", "exit"]) {
  requireText(semantic, `${key}:`, `semantic reasons ${key}`);
}
requireText(semantic, "AUTO: regime", "AUTO selector reason");
requireText(semantic, "Trend: chưa xuất hiện một trong 3 mẫu nến M15 hợp lệ", "Trend wait reason");
requireText(semantic, "Sideway: chưa có xác nhận M5 hợp lệ", "Sideway wait reason");
requireText(semantic, "entryChecks:", "structured entry-check contract");
requireText(semantic, '"THREE_CANDLE_BODY_DOMINANCE"', "Trend three-candle check");
requireText(semantic, '"TWO_CANDLE_BODY_DOMINANCE"', "Trend two-candle check");
requireText(semantic, '"ENGULFING"', "Trend engulfing check");
requireText(semantic, "TREND_SUPERTREND_M15", "Trend M15 Supertrend check");
requireText(semantic, "TREND_SUPERTREND_M5", "Trend M5 Supertrend check");
requireText(semantic, "SIDEWAY_M5_CONFIRMATION", "Sideway M5 check");
requireText(semantic, "SIDEWAY_FINAL_GATE", "Sideway final gate check");

const decisionMonitor = read("apps/api/src/services/phase7c-decision-monitor.service.ts");
requireText(decisionMonitor, "entryDiagnostics:", "decision diagnostics exposure");
requireText(decisionMonitor, "supplyDemandRange: input.regime.supplyDemandRange", "Sideway range exposure");

const signalPage = read("apps/web/src/pages/Phase7BPatternCheckPage.tsx");
requireText(signalPage, "SIGNAL UI V3", "Signal UI V3 contract");
requireText(signalPage, "ĐANG CHỜ ĐIỀU KIỆN NÀO?", "active entry pipeline");
requireText(signalPage, "EntryPipeline", "active entry pipeline renderer");
requireText(signalPage, "ui?.entryChecks?.trend", "Trend canonical entry diagnostics");
requireText(signalPage, "ui?.entryChecks?.sideway", "Sideway canonical entry diagnostics");
requireText(signalPage, "TREND DIAGNOSTICS", "Trend technical diagnostics");
requireText(signalPage, "SIDEWAY DIAGNOSTICS", "Sideway technical diagnostics");

const mt5Panel = read("mt5/XAUUSD_AI_Master_Decision_Panel.mq5");
requireText(mt5Panel, "ĐIỀU KIỆN CHẶN ENTRY", "MT5 compact entry blocker");
requireText(mt5Panel, "FirstEntryBlocker", "MT5 blocker selection");
requireText(mt5Panel, '"trend"', "MT5 Trend checklist source");
requireText(mt5Panel, '"sideway"', "MT5 Sideway checklist source");

const shell = read("apps/web/src/ui/DashboardLayout.tsx");
requireText(shell, "Vận hành {runtime}", "runtime-aware sidebar");
requireText(shell, "Web không có quyền đặt lệnh.", "read-only order boundary");
requireText(shell, "Guarded Account Switch", "guarded account-switch guidance");
requireText(shell, "LIVE ARM vẫn là thao tác riêng", "separate LIVE ARM boundary");
forbidText(shell, "Web không có quyền đặt lệnh hoặc chuyển tài khoản", "obsolete account-switch boundary");
forbidText(shell, "Bảng điều khiển vận hành DEMO", "hard-coded dashboard mode");
forbidText(shell, "Chỉ tài khoản DEMO", "hard-coded dashboard mode");

const dashboard = read("apps/web/src/pages/Phase7BDemoPage.tsx");
requireText(dashboard, "AUTO / REGIME — LÝ DO CHỌN STRATEGY", "AUTO reason section");
requireText(dashboard, "TREND — LÝ DO CHƯA VÀO LỆNH", "Trend reason section");
requireText(dashboard, "SIDEWAY — LÝ DO CHƯA VÀO LỆNH", "Sideway reason section");
requireText(dashboard, "LÝ DO DỜI STOP LOSS", "stop move section");
requireText(dashboard, "LÝ DO CHỐT 1/3", "partial section");
requireText(dashboard, "LÝ DO ĐÓNG TOÀN BỘ", "exit section");
forbidText(dashboard, "DEMO ONLY", "hard-coded dashboard runtime");

const accountRiskPage = read("apps/web/src/pages/Phase7BOpsPage.tsx");
requireText(accountRiskPage, 'accountModeKey === "real" || accountModeKey === "live"', "LIVE account normalization");
requireText(accountRiskPage, 'label={`Tài khoản ${accountMode}`}', "runtime-aware account chip");
requireText(accountRiskPage, 'subtitle={`Tài khoản ${accountMode} đang kết nối với MT5.`}', "runtime-aware account subtitle");
requireText(accountRiskPage, 'subtitle={`Các khóa an toàn bắt buộc cho runtime ${accountMode}.`}', "runtime-aware safety subtitle");
requireText(accountRiskPage, 'label="Runtime account" valueText={accountMode}', "runtime account safety row");
requireText(accountRiskPage, 'label="LIVE execution capability"', "LIVE capability safety row");
forbidText(accountRiskPage, "Tài khoản demo đang kết nối với MT5.", "hard-coded account subtitle");
forbidText(accountRiskPage, "Các khóa an toàn bắt buộc của DEMO.", "hard-coded safety subtitle");
forbidText(accountRiskPage, 'label="Demo only"', "hard-coded DEMO safety row");

const accountSwitchCard = read("apps/web/src/ui/Phase7CAccountSwitchCard.tsx");
forbidText(accountSwitchCard, "ARM FILE CÓ", "account-risk ARM chip");
forbidText(accountSwitchCard, "ARM FILE KHÔNG", "account-risk ARM chip");
forbidText(accountSwitchCard, "LIVE arm file", "account-risk final ARM status");
forbidText(accountSwitchCard, "Không ARM LIVE", "account-risk ARM guidance");
forbidText(accountSwitchCard, "ARM ở bước riêng", "account-risk ARM guidance");
requireText(accountSwitchCard, "Account switch không cấp quyền AUTO và không gửi order.", "account-risk neutral switch boundary");

const executionAuthorization = read("apps/web/src/ui/Phase7CExecutionAuthorizationCard.tsx");
forbidText(executionAuthorization, "DEMO · ARM KHÔNG YÊU CẦU", "DEMO ARM UI");
requireText(executionAuthorization, "KIỂM TRA ĐIỀU KIỆN ARM LIVE", "single LIVE ARM preflight button");
requireText(executionAuthorization, 'createPhase7CLiveArmPreflight("ARM_LIVE")', "LIVE ARM explicit preflight");
requireText(executionAuthorization, "armPreflight?.approved", "ARM button preflight gate");
requireText(executionAuthorization, 'accountMode === "LIVE" ? (', "LIVE-only ARM rendering");
requireText(executionAuthorization, "DEMO chỉ dùng AUTO safety guard", "DEMO authorization copy without ARM");

const performancePage = read("apps/web/src/pages/PerformancePage.tsx");
requireText(performancePage, "MT5 {accountMode} · CHỈ ĐỌC", "performance runtime label");
requireText(performancePage, "Trang hiệu suất chỉ đọc lịch sử của tài khoản {accountMode} hiện tại", "performance read-only boundary");
forbidText(performancePage, "MT5 DEMO · CHỈ ĐỌC", "hard-coded performance mode");

console.log("PHASE7C_WEB_ACCOUNT_SEMANTIC_SOURCE_TEST=PASS");
