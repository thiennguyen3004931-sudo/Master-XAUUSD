import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const controllerPath = path.join(root, "scripts", "run-phase7b-demo-controller.ts");
const routePath = path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function replaceRequired(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`${label} marker not found.`);
  return text.replace(from, to);
}

let controller = read(controllerPath);
if (!controller.includes("THREE_CANDLE_BODY_DOMINANCE")) throw new Error("Accumulated V6 three-candle controller missing.");
if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) throw new Error("Accumulated daily recovery controller missing.");
if (!controller.includes("const botOwnedPositionIds = new Set(")) throw new Error("V20 position-level PnL ownership missing.");
if (!controller.includes("ACCOUNT_SWITCH_BLOCK")) throw new Error("V26 account audit missing.");

const oldControllerClock = `  const now = Date.now();\n  const boundary = await get<TradingDayBoundary>(\`/v1/session/day-boundary/\${encodeURIComponent(symbol)}\`);\n  const deals = await get<DealHistory[]>(\n    \`/v1/history/deals?fromMs=\${boundary.currentStartTime}&toMs=\${now}&symbol=\${encodeURIComponent(symbol)}\`,\n  );`;

const newControllerClock = `  const boundary = await get<TradingDayBoundary>(\`/v1/session/day-boundary/\${encodeURIComponent(symbol)}\`);\n  const brokerQuote = await get<Quote>(\`/v1/quotes/\${encodeURIComponent(symbol)}\`);\n  const brokerTimestamp = Number(brokerQuote.timestamp);\n  if (!Number.isFinite(brokerTimestamp) || brokerTimestamp <= boundary.currentStartTime) {\n    throw new Error(\`Invalid MT5 broker clock for daily P&L: quote=\${brokerQuote.timestamp} dayStart=\${boundary.currentStartTime}\`);\n  }\n  // MT5 deal timestamps and D1 boundaries are expressed on the broker/server\n  // clock. Date.now() is the Windows/UTC clock and can lag broker time by hours,\n  // causing recent deals to be silently excluded. Use the live MT5 quote clock.\n  const historyToMs = Math.round(brokerTimestamp + 1_000);\n  const deals = await get<DealHistory[]>(\n    \`/v1/history/deals?fromMs=\${boundary.currentStartTime}&toMs=\${historyToMs}&symbol=\${encodeURIComponent(symbol)}\`,\n  );`;

controller = replaceRequired(controller, oldControllerClock, newControllerClock, "Controller broker-clock daily range");
write(controllerPath, controller);

let route = read(routePath);
if (!route.includes("const botOwnedPositionIds = new Set(")) throw new Error("API V20 position-level PnL ownership missing.");

const oldApiClock = `  const toMs = Date.now();\n  const dealsResponse = await fetch(\n    \`\${baseUrl}/v1/history/deals?fromMs=\${boundary.currentStartTime}&toMs=\${toMs}&symbol=XAUUSD\`,\n    { headers },\n  );`;

const newApiClock = `  const quoteResponse = await fetch(\`\${baseUrl}/v1/quotes/XAUUSD\`, { headers });\n  const quoteText = await quoteResponse.text();\n  if (!quoteResponse.ok) throw new Error(\`Daily broker clock failed \${quoteResponse.status}: \${quoteText}\`);\n  const brokerQuote = JSON.parse(quoteText) as { timestamp?: number };\n  const brokerTimestamp = Number(brokerQuote.timestamp);\n  if (!Number.isFinite(brokerTimestamp) || brokerTimestamp <= boundary.currentStartTime) {\n    throw new Error(\`Invalid MT5 broker clock for daily management: quote=\${brokerQuote.timestamp} dayStart=\${boundary.currentStartTime}\`);\n  }\n  // Use MT5's own quote clock so history includes deals stamped on broker/server time.\n  const toMs = Math.round(brokerTimestamp + 1_000);\n  const dealsResponse = await fetch(\n    \`\${baseUrl}/v1/history/deals?fromMs=\${boundary.currentStartTime}&toMs=\${toMs}&symbol=XAUUSD\`,\n    { headers },\n  );`;

route = replaceRequired(route, oldApiClock, newApiClock, "API broker-clock daily range");
write(routePath, route);

const finalController = read(controllerPath);
const finalRoute = read(routePath);
if (!finalController.includes("const historyToMs = Math.round(brokerTimestamp + 1_000);")) throw new Error("Controller broker clock patch missing.");
if (!finalRoute.includes("const toMs = Math.round(brokerTimestamp + 1_000);")) throw new Error("API broker clock patch missing.");
if (!finalController.includes("THREE_CANDLE_BODY_DOMINANCE")) throw new Error("Three-candle rule lost after patch.");
if (!finalController.includes('reason: "DAY_RECOVERY_6_TO_10"')) throw new Error("Recovery rule lost after patch.");
if (!finalController.includes("ACCOUNT_SWITCH_BLOCK")) throw new Error("Account audit lost after patch.");

console.log("PHASE7B_V27_ROOT_CAUSE=WINDOWS_CLOCK_VS_MT5_BROKER_CLOCK");
console.log("PHASE7B_V27_DAILY_HISTORY_END=MT5_QUOTE_TIMESTAMP");
console.log("PHASE7B_V27_POSITION_LEVEL_PNL_PRESERVED=True");
console.log("PHASE7B_V27_ACCUMULATED_CONTROLLER_PRESERVED=True");
console.log("PHASE7B_V27_API=PASS");
console.log("PHASE7B_V27_CONTROLLER=PASS");
console.log("PHASE7B_V27_EXPECTED_CURRENT_PNL_FROM_USER_MT5=-31.08");
console.log("PHASE7B_V27_API_RESTART_REQUIRED=True");
console.log("PHASE7B_V27_BOT_RESTART_REQUIRED=True");
console.log("PHASE7B_V27_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V27=PASS");
