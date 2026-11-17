import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = "scripts/run-phase7c-telegram-mode-controller.mjs";
const source = fs.readFileSync(path.join(root, sourcePath), "utf8");

function requireText(needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

requireText('import dns from "node:dns";', "Telegram controller DNS import");
requireText('dns.setDefaultResultOrder("ipv4first");', "Telegram controller IPv4-first DNS order");

const dnsOrderIndex = source.indexOf('dns.setDefaultResultOrder("ipv4first");');
const firstFetchIndex = source.indexOf("fetch(");
if (firstFetchIndex < 0) throw new Error("Telegram controller fetch call not found");
if (dnsOrderIndex < 0 || dnsOrderIndex > firstFetchIndex) {
  throw new Error("Telegram controller must set ipv4first before its first fetch call");
}

console.log("PHASE7C_TELEGRAM_IPV4FIRST_SOURCE_TEST=PASS");
