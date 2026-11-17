import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = "scripts/run-phase7c-telegram-mode-controller.mjs";
const source = fs.readFileSync(path.join(root, sourcePath), "utf8");

function requireText(needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

requireText('import dns from "node:dns";', "Telegram controller DNS import");
requireText('import net from "node:net";', "Telegram controller net import");
requireText('dns.setDefaultResultOrder("ipv4first");', "Telegram controller IPv4-first DNS order");
requireText('net.setDefaultAutoSelectFamily(false);', "Telegram controller disabled network family auto-selection");

const dnsOrderIndex = source.indexOf('dns.setDefaultResultOrder("ipv4first");');
const autoSelectIndex = source.indexOf('net.setDefaultAutoSelectFamily(false);');
const firstFetchIndex = source.indexOf("fetch(");
if (firstFetchIndex < 0) throw new Error("Telegram controller fetch call not found");
if (dnsOrderIndex < 0 || dnsOrderIndex > firstFetchIndex) {
  throw new Error("Telegram controller must set ipv4first before its first fetch call");
}
if (autoSelectIndex < 0 || autoSelectIndex > firstFetchIndex) {
  throw new Error("Telegram controller must disable network family auto-selection before its first fetch call");
}

console.log("PHASE7C_TELEGRAM_DISABLE_AUTOSELECT_SOURCE_TEST=PASS");
