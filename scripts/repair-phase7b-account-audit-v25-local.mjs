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
function replaceRequired(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`${label} marker not found.`);
  return text.replace(from, to);
}

let controller = read(controllerPath);

if (!controller.includes("idempotentReplay?: boolean;")) {
  controller = replaceRequired(
    controller,
    "  retcode?: number;\n};\n\ntype CommandResponse",
    "  retcode?: number;\n  idempotentReplay?: boolean;\n};\n\ntype CommandResponse",
    "OrderResponse replay field",
  );
}

if (!controller.includes("ACCOUNT_SWITCH_BLOCK")) {
  const guardAnchor = `  if (\n    health.accountMode !== "demo" ||\n    !health.connected ||\n    !health.tradingEnabled ||\n    !health.terminalTradeAllowed ||\n    !health.expertTradeAllowed ||\n    !allowedLogins.has(Number(health.accountLogin))\n  ) {`;
  if (!controller.includes(guardAnchor)) throw new Error("Cycle guard anchor not found.");
  const guardReplacement = `  if (state.accountLogin !== null && Number(health.accountLogin) !== state.accountLogin) {\n    journal("ACCOUNT_SWITCH_BLOCK", {\n      stateAccountLogin: state.accountLogin,\n      currentAccountLogin: health.accountLogin,\n      accountMode: health.accountMode,\n      server: health.server,\n    });\n    return;\n  }\n\n${guardAnchor}`;
  controller = controller.replace(guardAnchor, guardReplacement);
}

if (!controller.includes("accountLogin: health.accountLogin,\n    accountMode: health.accountMode,\n    server: health.server,\n    signalId: signal.id,")) {
  controller = replaceRequired(
    controller,
    `  journal("ENTRY_SUBMIT", {\n    signalId: signal.id,`,
    `  journal("ENTRY_SUBMIT", {\n    accountLogin: health.accountLogin,\n    accountMode: health.accountMode,\n    server: health.server,\n    signalId: signal.id,`,
    "ENTRY_SUBMIT account audit",
  );
}

if (!controller.includes('journal("ENTRY_ORDER_IDEMPOTENT_REPLAY"')) {
  const acceptedAnchor = `  if (!order.accepted) {\n    journal("ENTRY_REJECTED", { signalId: signal.id, message: order.message, retcode: order.retcode });\n    return;\n  }\n\n  let opened = order.position ?? null;`;
  if (!controller.includes(acceptedAnchor)) throw new Error("Order accepted anchor not found.");
  controller = controller.replace(
    acceptedAnchor,
    `  if (!order.accepted) {\n    journal("ENTRY_REJECTED", { signalId: signal.id, message: order.message, retcode: order.retcode });\n    return;\n  }\n\n  if (order.idempotentReplay === true) {\n    journal("ENTRY_ORDER_IDEMPOTENT_REPLAY", {\n      accountLogin: health.accountLogin,\n      accountMode: health.accountMode,\n      server: health.server,\n      signalId: signal.id,\n      orderTicket: order.ticket ?? null,\n    });\n  }\n\n  let opened = order.position ?? null;`,
  );
}

if (!controller.includes('journal("ENTRY_POSITION_VERIFICATION_FAILED"')) {
  const resolveAnchor = `  if (!opened) {\n    journal("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED", { signalId: signal.id, ticket: order.ticket, fillPrice: order.fillPrice });\n    return;\n  }\n\n  state.managed = {`;
  if (!controller.includes(resolveAnchor)) throw new Error("Opened position anchor not found.");
  const verifyBlock = `  if (!opened) {\n    journal("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED", { signalId: signal.id, ticket: order.ticket, fillPrice: order.fillPrice });\n    return;\n  }\n\n  const liveAfterFill = await get<Position[]>(\`/v1/positions?symbol=\${encodeURIComponent(symbol)}\`);\n  const verifiedOpened = liveAfterFill.find((position) => position.ticket === opened!.ticket) ?? null;\n  const expectedOpenedSide = signal.side === "BUY" ? "LONG" : "SHORT";\n  const volumeTolerance = Math.max(1e-9, spec.volumeStep / 2);\n  if (\n    !verifiedOpened ||\n    verifiedOpened.side !== expectedOpenedSide ||\n    Math.abs(verifiedOpened.volume - fixedVolume) > volumeTolerance\n  ) {\n    journal("ENTRY_POSITION_VERIFICATION_FAILED", {\n      accountLogin: health.accountLogin,\n      accountMode: health.accountMode,\n      server: health.server,\n      signalId: signal.id,\n      expectedTicket: opened.ticket,\n      expectedSide: expectedOpenedSide,\n      expectedVolume: fixedVolume,\n      livePositions: liveAfterFill.map((position) => ({\n        ticket: position.ticket,\n        side: position.side,\n        volume: position.volume,\n        entry: position.entry,\n      })),\n      idempotentReplay: order.idempotentReplay === true,\n    });\n    return;\n  }\n  opened = verifiedOpened;\n\n  state.managed = {`;
  controller = controller.replace(resolveAnchor, verifyBlock);
}

if (!controller.includes("accountLogin: health.accountLogin,\n    accountMode: health.accountMode,\n    server: health.server,\n    signalId: signal.id,\n    position: opened,")) {
  controller = replaceRequired(
    controller,
    `  journal("ENTRY_FILLED", {\n    signalId: signal.id,\n    position: opened,`,
    `  journal("ENTRY_FILLED", {\n    accountLogin: health.accountLogin,\n    accountMode: health.accountMode,\n    server: health.server,\n    signalId: signal.id,\n    position: opened,`,
    "ENTRY_FILLED account audit",
  );
}

if (!controller.includes('journal("MANAGED_POSITION_CLOSED", { accountLogin: health.accountLogin')) {
  controller = replaceRequired(
    controller,
    `      journal("MANAGED_POSITION_CLOSED", { ticket: state.managed.ticket, lastKnownState: state.managed });`,
    `      journal("MANAGED_POSITION_CLOSED", { accountLogin: health.accountLogin, accountMode: health.accountMode, server: health.server, ticket: state.managed.ticket, lastKnownState: state.managed });`,
    "MANAGED_POSITION_CLOSED account audit",
  );
}

write(controllerPath, controller);

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
if (!finalController.includes("ACCOUNT_SWITCH_BLOCK")) throw new Error("Account switch block missing.");
if (!finalController.includes("ENTRY_POSITION_VERIFICATION_FAILED")) throw new Error("Fill verification missing.");
if (!finalController.includes("ENTRY_ORDER_IDEMPOTENT_REPLAY")) throw new Error("Idempotent replay audit missing.");
if (!finalController.includes("accountLogin: health.accountLogin")) throw new Error("Account audit fields missing.");
if (!finalRunner.includes('$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "false"')) throw new Error("Closed-candle runner gate missing.");

console.log("PHASE7B_V25_ACCOUNT_SWITCH_GUARD=PASS");
console.log("PHASE7B_V25_ENTRY_ACCOUNT_AUDIT=PASS");
console.log("PHASE7B_V25_ENTRY_LIVE_POSITION_VERIFY=PASS");
console.log("PHASE7B_V25_IDEMPOTENT_REPLAY_AUDIT=PASS");
console.log("PHASE7B_V25_ENTRY_CANDLE=CLOSED_M15_ONLY");
console.log("PHASE7B_V25_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V25_BOT_RESTART_REQUIRED=True");
console.log("PHASE7B_V25=PASS");
