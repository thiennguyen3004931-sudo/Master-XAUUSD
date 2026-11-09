import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pagePath = "apps/web/src/pages/Phase7CMobileReadOnlyPage.tsx";
const routerPath = "apps/web/src/router.tsx";
const layoutPath = "apps/web/src/ui/DashboardLayout.tsx";

assert.ok(
  existsSync(pagePath),
  "M1 RED: dedicated Phase7C mobile page must exist.",
);

const page = readFileSync(pagePath, "utf8");
const router = readFileSync(routerPath, "utf8");
const layout = readFileSync(layoutPath, "utf8");

function requireText(source, text, message) {
  assert.ok(source.includes(text), message);
}

function forbidText(source, text, message) {
  assert.ok(!source.includes(text), message);
}

// M1 read-data semantics remain canonical even after the approved M4-A bounded control card is added.
requireText(page, "MOBILE_REMOTE_ACCESS_M4-A", "Mobile page must identify the current approved M4-A surface.");
requireText(page, "READ DATA CANONICAL", "Mobile page must make canonical read-data semantics explicit.");
requireText(page, "fetchPhase7CWebStatus", "Mobile page must reuse the canonical Phase7C semantic web-status reader.");
requireText(page, "Phase7COperatorStatusBar", "Mobile page must reuse the canonical operator status strip.");
requireText(page, "getTradeUiState", "Mobile page must use the canonical semantic UI-state derivation.");
requireText(page, "ui?.position", "Mobile page must display persisted canonical position data when managing.");
requireText(page, "ui?.setup", "Mobile page must display persisted canonical setup data when approved.");
requireText(page, "BOT ĐANG LÀM GÌ?", "Mobile page must lead with the current bot action/state.");
requireText(page, "LÝ DO HIỆN TẠI", "Mobile page must expose the current human-readable reason.");
requireText(page, "VỊ THẾ / KẾ HOẠCH", "Mobile page must expose the real position/setup summary.");
requireText(page, "xs:", "Mobile page must include explicit xs responsive behavior.");
requireText(page, "Phase7CMobileM4ControlCard", "Approved M4-A controls must be isolated in the bounded mobile control card.");

// The page component itself must remain a read-data composition layer. Mutations belong only to the bounded M4 client/card.
forbidText(page, 'method: "POST"', "Mobile page must not implement POST directly.");
forbidText(page, "method: 'POST'", "Mobile page must not implement POST directly.");
forbidText(page, 'method: "PUT"', "Mobile page must not implement PUT directly.");
forbidText(page, 'method: "PATCH"', "Mobile page must not implement PATCH directly.");
forbidText(page, 'method: "DELETE"', "Mobile page must not implement DELETE directly.");
forbidText(page, "setPhase7CBotMode", "Mobile page must not bypass the M4 broker with direct bot-mode mutation.");
forbidText(page, "armPhase7C", "Mobile page must not use a direct legacy ARM mutation.");
forbidText(page, "disarmPhase7C", "Mobile page must not use a direct legacy DISARM mutation.");
forbidText(page, "127.0.0.1:3711", "Mobile page must not expose direct localhost API access.");

requireText(router, "Phase7CMobileReadOnlyPage", "Router must lazy-load the mobile page.");
requireText(router, 'path: "phase7c-mobile"', "Router must expose /phase7c-mobile.");
requireText(layout, '["/phase7c-mobile", "Điện thoại"', "Navigation must expose the dedicated mobile page.");
requireText(layout, 'location.pathname.startsWith("/phase7c-mobile")', "Mobile route must have its own operator header.");

console.log("PHASE7C_MOBILE_READ_DATA_M1_COMPAT_CONTRACT=PASS");
