import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readOptional = (relative) => {
  const target = path.join(root, relative);
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
};

const page = read("apps/web/src/pages/Phase7CAccountRiskPage.tsx");
const riskCard = readOptional("apps/web/src/ui/Phase7CAccountRiskLotCard.tsx");
const advanced = readOptional("apps/web/src/ui/Phase7CAccountRiskAdvancedPanel.tsx");

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}
function forbidText(source, needle, label) {
  if (source.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
}

requireText(page, "ACCOUNT & RISK V2", "page title");
requireText(page, "<Phase7COperatorStatusBar />", "operator status reused");
requireText(page, "AN TOÀN ĐỂ ĐỔI TÀI KHOẢN", "safe assessment");
requireText(page, "CHƯA THỂ ĐỔI TÀI KHOẢN", "blocked assessment");
requireText(page, "ĐỔI TÀI KHOẢN", "account switch action");
requireText(page, "accountSwitchOpen", "account switch progressive disclosure");
requireText(page, "riskEditorOpen", "risk editor progressive disclosure");
requireText(page, "strategyOpen", "strategy details collapsed by default");
requireText(page, "advancedOpen", "advanced diagnostics collapsed by default");
requireText(page, "CHẨN ĐOÁN / NÂNG CAO", "advanced diagnostics title");
forbidText(page, "<Phase7BOpsPage />", "legacy full ops page removed from primary layout");

requireText(riskCard, "CẤU HÌNH RỦI RO", "risk card");
requireText(riskCard, "Chỉnh cấu hình", "risk editor action");
requireText(riskCard, "Fixed TP: xem tại Trung tâm điều khiển", "fixed TP not duplicated");
requireText(riskCard, "canonicalFixedTp", "Fixed TP preserved on risk save");
forbidText(riskCard, "Trend Fixed TP", "Fixed TP editor not duplicated");
forbidText(riskCard, "Sideway Fixed TP", "Fixed TP editor not duplicated");

requireText(advanced, "Runtime & Bridge", "advanced runtime diagnostics");
requireText(advanced, "Executors", "advanced executor diagnostics");
requireText(advanced, "Broker / Safety", "advanced broker diagnostics");

console.log("PHASE7C_ACCOUNT_RISK_V2_UI_SOURCE_TEST=PASS");
