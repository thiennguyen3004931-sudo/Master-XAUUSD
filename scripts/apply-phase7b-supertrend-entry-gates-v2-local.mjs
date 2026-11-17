import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.env.PHASE7B_SUPERTREND_GATE_PATCH_ROOT
  ? path.resolve(process.env.PHASE7B_SUPERTREND_GATE_PATCH_ROOT)
  : process.cwd();
const basePatcher = path.join(root, "scripts", "apply-phase7b-supertrend-entry-gates-local.mjs");
if (!fs.existsSync(basePatcher)) throw new Error(`Base Supertrend patcher not found: ${basePatcher}`);

let source = fs.readFileSync(basePatcher, "utf8");
const ambiguous = `  patch(\n    files.controller,\n    "CONTROLLER_SIGNAL_CALL",\n    \`  const signal = latestSignal(m15, spec);\`,\n    \`  const signal = latestSignal(m15, m5, spec);\`,\n  ),`;
const precise = `  patch(\n    files.controller,\n    "CONTROLLER_SIGNAL_CALL",\n    \`  const signal = latestSignal(m15, spec);\\n  if (!signal || signal.signalTimestamp !== latest.closeTime) {\\n    journal("M15_NO_ENTRY_SIGNAL", {\`,\n    \`  const signal = latestSignal(m15, m5, spec);\\n  if (!signal || signal.signalTimestamp !== latest.closeTime) {\\n    journal("M15_NO_ENTRY_SIGNAL", {\`,\n  ),`;

const count = source.split(ambiguous).length - 1;
if (count !== 1) {
  throw new Error(`SUPER_TREND_V2_CONTROLLER_SIGNAL_ANCHOR: expected one base patcher anchor, found ${count}.`);
}
source = source.replace(ambiguous, precise);

// Keep the generated controller/API source compatible with the workspace's
// ES2022 TypeScript lib while preserving the same no-lookahead lookup rule.
source = source.replace(
  `const m5SignalIndex = m5.findLastIndex((bar) => bar.closeTime <= current.closeTime);`,
  `let m5SignalIndex = m5.length - 1;\\n  while (m5SignalIndex >= 0 && m5[m5SignalIndex]!.closeTime > current.closeTime) m5SignalIndex -= 1;`,
);
source = source.replace(
  `const m5SignalIndex = m5Bars.findLastIndex((bar) => bar.closeTime <= current.closeTime);`,
  `let m5SignalIndex = m5Bars.length - 1;\\n  while (m5SignalIndex >= 0 && m5Bars[m5SignalIndex]!.closeTime > current.closeTime) m5SignalIndex -= 1;`,
);

// The base patcher contains template-literal snippets that belong to the target
// API source. Escape only identifiers that do not exist in the patcher itself,
// so Node does not try to interpolate them while constructing patch plans.
source = source.replaceAll("${baseUrl}", "\\${baseUrl}");
source = source.replaceAll("${pattern.side}", "\\${pattern.side}");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase7b-supertrend-v2-"));
const tempPatcher = path.join(tempDir, "apply-phase7b-supertrend-entry-gates-v2-runtime.mjs");
fs.writeFileSync(tempPatcher, source, "utf8");

console.log("PHASE7B_SUPERTREND_GATE_V2=START");
console.log(`PHASE7B_SUPERTREND_GATE_V2_ROOT=${root}`);
console.log("PHASE7B_SUPERTREND_GATE_V2_BASE_PATCHER_MUTATION=False");
console.log("PHASE7B_SUPERTREND_GATE_V2_CONTROLLER_SIGNAL_ANCHOR=DISAMBIGUATED");
console.log("PHASE7B_SUPERTREND_GATE_V2_M5_LOOKUP=ES2022_COMPATIBLE_NO_LOOKAHEAD");
console.log("PHASE7B_SUPERTREND_GATE_V2_TARGET_INTERPOLATIONS=ESCAPED");

const child = spawnSync(process.execPath, [tempPatcher, ...process.argv.slice(2)], {
  cwd: root,
  env: {
    ...process.env,
    PHASE7B_SUPERTREND_GATE_PATCH_ROOT: root,
  },
  stdio: "inherit",
});

try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Best-effort cleanup only.
}

if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
console.log("PHASE7B_SUPERTREND_GATE_V2_RESULT=PASS");
