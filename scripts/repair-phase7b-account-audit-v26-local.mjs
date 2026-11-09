import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const controllerPath = path.join(root, "scripts", "run-phase7b-demo-controller.ts");
const runnerPath = path.join(root, "scripts", "run-phase7b-demo-local.ps1");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}
function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}
function insertAfter(text, marker, block, label) {
  if (text.includes(block.trim())) return text;
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`${label} marker not found.`);
  const at = index + marker.length;
  return text.slice(0, at) + block + text.slice(at);
}
function insertBefore(text, marker, block, label) {
  if (text.includes(block.trim())) return text;
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`${label} marker not found.`);
  return text.slice(0, index) + block + text.slice(index);
}

let controller = read(controllerPath);

// OrderResponse must expose bridge idempotent replay metadata when present.
if (!controller.includes("idempotentReplay?: boolean;")) {
  const orderTypeStart = controller.indexOf("type OrderResponse = {");
  const orderTypeEnd = controller.indexOf("};", orderTypeStart);
  if (orderTypeStart < 0 || orderTypeEnd < 0) throw new Error("OrderResponse type not found.");
  controller = controller.slice(0, orderTypeEnd) + "  idempotentReplay?: boolean;\n" + controller.slice(orderTypeEnd);
}

// Guard account switches during an armed runtime, not only at preflight.
if (!controller.includes('journal("ACCOUNT_SWITCH_BLOCK"')) {
  const cycleHead = `async function cycle(): Promise<void> {\n  const health = await get<Health>("/health");\n`;
  const guard = `  if (state.accountLogin !== null && Number(health.accountLogin) !== state.accountLogin) {\n    journal("ACCOUNT_SWITCH_BLOCK", {\n      stateAccountLogin: state.accountLogin,\n      currentAccountLogin: health.accountLogin,\n      accountMode: health.accountMode,\n      server: health.server,\n    });\n    return;\n  }\n\n`;
  controller = insertAfter(controller, cycleHead, guard, "Cycle account guard");
}

// Add account identity to ENTRY_SUBMIT without depending on surrounding fields.
if (!/journal\("ENTRY_SUBMIT", \{\n\s*accountLogin: health\.accountLogin,/.test(controller)) {
  controller = controller.replace(
    '  journal("ENTRY_SUBMIT", {\n',
    '  journal("ENTRY_SUBMIT", {\n    accountLogin: health.accountLogin,\n    accountMode: health.accountMode,\n    server: health.server,\n',
  );
}

// Record bridge idempotent replays before resolving the live position.
if (!controller.includes('journal("ENTRY_ORDER_IDEMPOTENT_REPLAY"')) {
  const openedMarker = "  let opened = order.position ?? null;";
  const replayBlock = `  if (order.idempotentReplay === true) {\n    journal("ENTRY_ORDER_IDEMPOTENT_REPLAY", {\n      accountLogin: health.accountLogin,\n      accountMode: health.accountMode,\n      server: health.server,\n      signalId: signal.id,\n      orderTicket: order.ticket ?? null,\n    });\n  }\n\n`;
  controller = insertBefore(controller, openedMarker, replayBlock, "Opened position declaration");
}

// Verify the position against a fresh MT5 positions read before any recovery
// calculation/state/journal can treat the order as a filled managed position.
if (!controller.includes('journal("ENTRY_POSITION_VERIFICATION_FAILED"')) {
  let verifyMarker = "  let entryDailyManagement: DailyManagementSnapshot | null = null;";
  if (!controller.includes(verifyMarker)) verifyMarker = "  state.managed = {";
  const verifyBlock = `  let verifiedOpened: Position | null = null;\n  let liveAfterFill: Position[] = [];\n  const expectedOpenedSide = signal.side === "BUY" ? "LONG" : "SHORT";\n  const volumeTolerance = Math.max(1e-9, spec.volumeStep / 2);\n  for (let attempt = 0; attempt < 8; attempt += 1) {\n    liveAfterFill = await get<Position[]>(\`/v1/positions?symbol=\${encodeURIComponent(symbol)}\`);\n    verifiedOpened = liveAfterFill.find((position) => position.ticket === opened!.ticket) ?? null;\n    if (\n      verifiedOpened &&\n      verifiedOpened.side === expectedOpenedSide &&\n      Math.abs(verifiedOpened.volume - fixedVolume) <= volumeTolerance\n    ) {\n      break;\n    }\n    if (attempt < 7) await sleep(250);\n  }\n  if (\n    !verifiedOpened ||\n    verifiedOpened.side !== expectedOpenedSide ||\n    Math.abs(verifiedOpened.volume - fixedVolume) > volumeTolerance\n  ) {\n    journal("ENTRY_POSITION_VERIFICATION_FAILED", {\n      accountLogin: health.accountLogin,\n      accountMode: health.accountMode,\n      server: health.server,\n      signalId: signal.id,\n      expectedTicket: opened.ticket,\n      expectedSide: expectedOpenedSide,\n      expectedVolume: fixedVolume,\n      livePositions: liveAfterFill.map((position) => ({\n        ticket: position.ticket,\n        side: position.side,\n        volume: position.volume,\n        entry: position.entry,\n      })),\n      idempotentReplay: order.idempotentReplay === true,\n    });\n    return;\n  }\n  opened = verifiedOpened;\n\n`;
  controller = insertBefore(controller, verifyMarker, verifyBlock, "Entry live verification");
}

// Add account identity to ENTRY_FILLED regardless of V10 recovery fields order.
if (!/journal\("ENTRY_FILLED", \{\n\s*accountLogin: health\.accountLogin,/.test(controller)) {
  controller = controller.replace(
    '  journal("ENTRY_FILLED", {\n',
    '  journal("ENTRY_FILLED", {\n    accountLogin: health.accountLogin,\n    accountMode: health.accountMode,\n    server: health.server,\n',
  );
}

// Add account identity to broker-observed managed close.
if (!controller.includes('journal("MANAGED_POSITION_CLOSED", { accountLogin: health.accountLogin')) {
  const closeRegex = /journal\("MANAGED_POSITION_CLOSED", \{\s*ticket: state\.managed\.ticket,\s*lastKnownState: state\.managed\s*\}\);/;
  if (!closeRegex.test(controller)) throw new Error("MANAGED_POSITION_CLOSED marker not found.");
  controller = controller.replace(
    closeRegex,
    'journal("MANAGED_POSITION_CLOSED", { accountLogin: health.accountLogin, accountMode: health.accountMode, server: health.server, ticket: state.managed.ticket, lastKnownState: state.managed });',
  );
}

write(controllerPath, controller);

// The current canonical lane is closed M15/M5 only. Keep the preload hook in
// place but disable its forming-candle override at runtime.
let runner = read(runnerPath);
runner = runner.replace(
  '$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "true"',
  '$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "false"',
);
runner = runner.replace(
  'Write-Host "PHASE7B_DEMO_PRE_CLOSE_ENTRY=ENABLED"',
  'Write-Host "PHASE7B_DEMO_PRE_CLOSE_ENTRY=DISABLED_CLOSED_M15_ONLY"',
);
runner = runner.replace(
  'Write-Host "PHASE7B_DEMO_PRE_CLOSE_CANDLE=FORMING_M15_PROVISIONAL"',
  'Write-Host "PHASE7B_DEMO_ENTRY_CANDLE=CLOSED_M15_ONLY"',
);
write(runnerPath, runner);

const finalController = read(controllerPath);
const finalRunner = read(runnerPath);
const required = [
  'journal("ACCOUNT_SWITCH_BLOCK"',
  'journal("ENTRY_ORDER_IDEMPOTENT_REPLAY"',
  'journal("ENTRY_POSITION_VERIFICATION_FAILED"',
  'journal("ENTRY_SUBMIT", {\n    accountLogin: health.accountLogin,',
  'journal("ENTRY_FILLED", {\n    accountLogin: health.accountLogin,',
  'journal("MANAGED_POSITION_CLOSED", { accountLogin: health.accountLogin',
];
for (const marker of required) {
  if (!finalController.includes(marker)) throw new Error(`V26 post-assertion missing: ${marker}`);
}
if (!finalRunner.includes('$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "false"')) {
  throw new Error("V26 closed-M15 runner gate missing.");
}
if (!finalController.includes('reason: "DAY_RECOVERY_6_TO_10"')) {
  throw new Error("V26 refuses to proceed because accumulated daily recovery logic is missing.");
}
if (!finalController.includes("THREE_CANDLE_BODY_DOMINANCE")) {
  throw new Error("V26 refuses to proceed because accumulated three-candle logic is missing.");
}

console.log("PHASE7B_V26_ACCUMULATED_CONTROLLER_PRESERVED=True");
console.log("PHASE7B_V26_ACCOUNT_SWITCH_GUARD=PASS");
console.log("PHASE7B_V26_ENTRY_ACCOUNT_AUDIT=PASS");
console.log("PHASE7B_V26_ENTRY_LIVE_POSITION_VERIFY=PASS");
console.log("PHASE7B_V26_IDEMPOTENT_REPLAY_AUDIT=PASS");
console.log("PHASE7B_V26_ENTRY_CANDLE=CLOSED_M15_ONLY");
console.log("PHASE7B_V26_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V26_BOT_RESTART_REQUIRED=True");
console.log("PHASE7B_V26=PASS");
