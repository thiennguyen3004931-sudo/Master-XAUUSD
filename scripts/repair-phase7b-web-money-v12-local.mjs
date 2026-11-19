import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const demoPath = path.join(root, "apps", "web", "src", "pages", "Phase7BDemoPage.tsx");
const gatePath = path.join(root, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function replaceRequired(text, from, to, label) {
  if (!text.includes(from) && !text.includes(to)) {
    throw new Error(`${label} marker not found.`);
  }
  return text.includes(from) ? text.replace(from, to) : text;
}

let demo = read(demoPath);
demo = replaceRequired(
  demo,
  'value={money(accountEquity, currency)} detail={`Số dư đã chốt ${money(accountBalance, currency)}`}',
  'value={accountEquity === null ? "—" : money(accountEquity, currency)} detail={`Số dư đã chốt ${accountBalance === null ? "—" : money(accountBalance, currency)}`}',
  "Demo Equity/Balance null-safe",
);
write(demoPath, demo);
console.log("PHASE7B_WEB_MONEY_V12_MONITOR_NULL_SAFE=PASS");

let gate = read(gatePath);
gate = replaceRequired(
  gate,
  '{money(accountEquity, currency)}',
  '{accountEquity === null ? "—" : money(accountEquity, currency)}',
  "Gate Equity null-safe",
);
gate = replaceRequired(
  gate,
  'Số dư đã chốt {money(accountBalance, currency)} · Lệnh mở {money(accountFloating, currency)}',
  'Số dư đã chốt {accountBalance === null ? "—" : money(accountBalance, currency)} · Lệnh mở {money(accountFloating, currency)}',
  "Gate Balance null-safe",
);
write(gatePath, gate);
console.log("PHASE7B_WEB_MONEY_V12_GATE_NULL_SAFE=PASS");

console.log("PHASE7B_WEB_MONEY_V12_BUILD_REQUIRED=pnpm --filter @xauusd/web build");
console.log("PHASE7B_WEB_MONEY_V12=PASS");
