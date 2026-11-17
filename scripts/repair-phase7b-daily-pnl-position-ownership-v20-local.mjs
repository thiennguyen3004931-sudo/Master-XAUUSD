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

function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`${label} marker not found.`);
  return text.replace(from, to);
}

let controller = read(controllerPath);
const oldController = `  const botDeals = deals.filter((deal) => deal.side !== null && Number(deal.magic) === magicNumber);
  const positionsWithRealizedExit = new Set(
    botDeals
      .filter((deal) => deal.entry === "OUT" || deal.entry === "INOUT" || deal.entry === "OUT_BY")
      .map((deal) => String(deal.positionId)),
  );
  const realizedPnl = botDeals
    .filter((deal) => positionsWithRealizedExit.has(String(deal.positionId)))
    .reduce((sum, deal) => sum + (Number.isFinite(Number(deal.netPnl)) ? Number(deal.netPnl) : 0), 0);`;

const newController = `  // Position ownership is established by at least one deal carrying the bot magic.
  // Once a bot-owned position has a realized exit, include ALL deals for that position.
  // Broker/server SL exits may legitimately have magic=0, so filtering every deal by
  // magic before identifying the closed position would drop the actual SL loss.
  const botOwnedPositionIds = new Set(
    deals
      .filter((deal) => deal.side !== null && Number(deal.magic) === magicNumber)
      .map((deal) => String(deal.positionId)),
  );
  const positionsWithRealizedExit = new Set(
    deals
      .filter(
        (deal) =>
          botOwnedPositionIds.has(String(deal.positionId)) &&
          (deal.entry === "OUT" || deal.entry === "INOUT" || deal.entry === "OUT_BY"),
      )
      .map((deal) => String(deal.positionId)),
  );
  const realizedPnl = deals
    .filter((deal) => positionsWithRealizedExit.has(String(deal.positionId)))
    .reduce((sum, deal) => sum + (Number.isFinite(Number(deal.netPnl)) ? Number(deal.netPnl) : 0), 0);`;

controller = replaceOnce(controller, oldController, newController, "Controller daily PnL ownership");
write(controllerPath, controller);

let route = read(routePath);
const oldRoute = `  const botDeals = deals.filter((deal) => deal.side !== null && Number(deal.magic) === magic);
  const exitedPositions = new Set(
    botDeals
      .filter((deal) => deal.entry === "OUT" || deal.entry === "INOUT" || deal.entry === "OUT_BY")
      .map((deal) => String(deal.positionId)),
  );
  const realizedPnl = botDeals
    .filter((deal) => exitedPositions.has(String(deal.positionId)))
    .reduce((sum, deal) => sum + (Number.isFinite(Number(deal.netPnl)) ? Number(deal.netPnl) : 0), 0);`;

const newRoute = `  // Determine ownership at the POSITION level, not the individual deal level.
  // This preserves broker/server-generated SL exit deals whose magic may be zero.
  const botOwnedPositionIds = new Set(
    deals
      .filter((deal) => deal.side !== null && Number(deal.magic) === magic)
      .map((deal) => String(deal.positionId)),
  );
  const exitedPositions = new Set(
    deals
      .filter(
        (deal) =>
          botOwnedPositionIds.has(String(deal.positionId)) &&
          (deal.entry === "OUT" || deal.entry === "INOUT" || deal.entry === "OUT_BY"),
      )
      .map((deal) => String(deal.positionId)),
  );
  const realizedPnl = deals
    .filter((deal) => exitedPositions.has(String(deal.positionId)))
    .reduce((sum, deal) => sum + (Number.isFinite(Number(deal.netPnl)) ? Number(deal.netPnl) : 0), 0);`;

route = replaceOnce(route, oldRoute, newRoute, "API daily PnL ownership");
write(routePath, route);

if (!controller.includes("const botOwnedPositionIds = new Set(")) throw new Error("Controller ownership patch missing.");
if (!route.includes("const botOwnedPositionIds = new Set(")) throw new Error("API ownership patch missing.");
if (controller.includes("const botDeals = deals.filter((deal) => deal.side !== null && Number(deal.magic) === magicNumber);")) {
  throw new Error("Controller still filters all deals by magic before realized PnL.");
}
if (route.includes("const botDeals = deals.filter((deal) => deal.side !== null && Number(deal.magic) === magic);")) {
  throw new Error("API still filters all deals by magic before realized PnL.");
}

console.log("PHASE7B_V20_DAILY_PNL_OWNERSHIP=POSITION_LEVEL");
console.log("PHASE7B_V20_BROKER_SL_MAGIC_ZERO_INCLUDED=True");
console.log("PHASE7B_V20_CONTROLLER=PASS");
console.log("PHASE7B_V20_API=PASS");
console.log("PHASE7B_V20_BOT_RESTART_REQUIRED=True");
console.log("PHASE7B_V20_API_RESTART_REQUIRED=True");
console.log("PHASE7B_V20_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V20=PASS");
