import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const shell = read("apps/web/src/pages/Phase7CControlCenterShellPage.tsx");
const accountRisk = read("apps/web/src/pages/Phase7CAccountRiskPage.tsx");
const execution = read("apps/web/src/ui/Phase7CExecutionAuthorizationCard.tsx");
const compact = read("apps/web/src/ui/Phase7CControlCenterCompactSection.tsx");
const status = read("apps/web/src/ui/Phase7COperatorStatusBar.tsx");
const intelligence = read("apps/web/src/ui/Phase7CIntelligenceSummaryCard.tsx");

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

function forbidText(source, needle, label) {
  if (source.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
}

// Shell: account switching belongs only to Account & Risk; Control Center focuses on trading operations.
requireText(shell, "Phase7COperatorStatusBar", "operator status import");
requireText(shell, "<Phase7COperatorStatusBar />", "operator status render");
requireText(shell, "<Phase7CExecutionAuthorizationCard />", "execution authorization preserved");
forbidText(shell, "Phase7CAccountSwitchCard", "duplicate account switch removed from Control Center");
requireText(accountRisk, "Phase7CAccountSwitchCard", "account switch remains in Account & Risk");
requireText(accountRisk, "<Phase7CAccountSwitchCard />", "account switch remains rendered in Account & Risk");
requireText(shell, "<Phase7CControlCenterCompactSection", "compact decision/control surface render");
requireText(shell, "<Phase7CIntelligenceSummaryCard />", "intelligence compact summary render");
requireText(shell, "const [showOperationalDetails, setShowOperationalDetails] = useState(false);", "operational details collapsed by default");
requireText(shell, "showOperationalDetails ? <Phase7CControlCenterPage /> : null", "legacy operational control visibility gate");
requireText(shell, "const [showIntelligenceDetails, setShowIntelligenceDetails] = useState(false);", "intelligence collapsed by default");
requireText(shell, "showIntelligenceDetails ? (", "intelligence detail visibility gate");
requireText(shell, "<Phase7CPerformanceIntelligenceCard />", "performance intelligence detail preserved");
requireText(shell, "<Phase7CPerformanceEffectivenessCard />", "performance effectiveness detail preserved");
requireText(shell, "<Phase7CCounterfactualIntelligenceCard />", "counterfactual detail preserved");
requireText(shell, "<Phase7CRecommendationIntelligenceCard />", "recommendation detail preserved");
requireText(shell, "Mở Intelligence chi tiết", "intelligence expand action");
requireText(shell, "Ẩn Intelligence chi tiết", "intelligence collapse action");

// Operator bar: one glance status for account/runtime/trading/source.
requireText(status, 'label={`ACCOUNT ${accountMode}`}', "account status");
requireText(status, 'label={`BOT ${botMode}`}', "bot mode status");
requireText(status, 'label={armed ? "ARMED" : "DISARMED"}', "arm status");
requireText(status, 'label={`POSITIONS ${positions}`}', "position status");
requireText(status, 'label={`SOURCE ${sourceVerdict}`}', "runtime source status");
requireText(status, "accountLogin", "account login summary");

// Execution authorization: ARM diagnostics collapsed without changing canonical ARM/AUTO safety flow.
requireText(execution, "const [armDetailsOpen, setArmDetailsOpen] = useState(false);", "ARM details collapsed by default");
requireText(execution, "armDetailsOpen ? (", "ARM detail visibility gate");
requireText(execution, "Xem chi tiết", "execution detail expand action");
requireText(execution, "Ẩn chi tiết", "execution detail collapse action");
requireText(execution, "Lý do:", "execution first blocker summary");
requireText(execution, "const showAutoActivationDiagnostics = !isAutoActive;", "AUTO active diagnostics safety gate preserved");

// Primary Control Center surface: decision summary plus directly usable canonical Bot and Fixed TP controls.
requireText(compact, "Quyết định hiện tại", "decision promoted to compact surface");
requireText(compact, "Điều khiển Bot", "bot control card visible");
requireText(compact, "BẬT BOT", "start bot action visible");
requireText(compact, "TẠM DỪNG", "pause bot action visible");
requireText(compact, "TẮT BOT", "stop bot action visible");
requireText(compact, 'lifecycleAction.mutate("start")', "canonical lifecycle start path reused");
requireText(compact, 'lifecycleAction.mutate("stop")', "canonical lifecycle stop path reused");
requireText(compact, 'setPhase7CBotMode("PAUSE")', "canonical PAUSE path reused");
requireText(compact, "Lot / Fixed TP", "lot and fixed TP card visible");
requireText(compact, "Trend Fixed TP", "trend Fixed TP editor visible");
requireText(compact, "Sideway Fixed TP", "sideway Fixed TP editor visible");
requireText(compact, "Lưu cấu hình Fixed TP", "Fixed TP save action visible");
requireText(compact, "setPhase7CLotSettings", "canonical lot settings path reused");
requireText(compact, "const canChangeFixedTp =", "Fixed TP safety gate preserved");
requireText(compact, "mode === \"PAUSE\"", "Fixed TP requires PAUSE");
requireText(compact, "openXauusdPositions", "position safety checks preserved");
forbidText(compact, "chỉnh sửa vẫn nằm trong Điều khiển chi tiết", "Fixed TP no longer summary-only");
forbidText(compact, "Start/Stop/Pause đầy đủ nằm trong Điều khiển chi tiết", "bot controls no longer summary-only");
requireText(compact, "Mở điều khiển chi tiết", "legacy detail expand action retained");
requireText(compact, "Ẩn điều khiển chi tiết", "legacy detail collapse action retained");
requireText(compact, "detailsOpen", "compact detail state supplied by shell");
requireText(compact, "onToggleDetails", "compact detail action supplied by shell");

// Intelligence on Control Center remains summary-first with navigation to the dedicated performance page.
requireText(intelligence, "Intelligence & hiệu suất", "intelligence summary title");
requireText(intelligence, 'to="/performance"', "performance navigation");
requireText(intelligence, "Mở Hiệu suất", "performance action");

console.log("PHASE7C_CONTROL_CENTER_V2_COMPACT_UI_SOURCE_TEST=PASS");
