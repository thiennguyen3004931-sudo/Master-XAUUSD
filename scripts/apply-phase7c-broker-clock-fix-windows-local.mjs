import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const root = process.cwd();
const scriptsDir = path.join(root, "scripts");
const patcherPath = path.join(scriptsDir, "apply-phase7c-broker-clock-fix-local.mjs");
const targets = [
  "run-phase7c-sideway-controller.mjs",
  "run-phase7b-demo-controller.ts",
];

if (!fs.existsSync(patcherPath)) throw new Error(`Base patcher not found: ${patcherPath}`);
for (const name of targets) {
  const target = path.join(scriptsDir, name);
  if (!fs.existsSync(target)) throw new Error(`Controller not found: ${target}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-clock-"));
const tempScripts = path.join(tempRoot, "scripts");
fs.mkdirSync(tempScripts, { recursive: true });

const metadata = new Map();
try {
  for (const name of targets) {
    const sourcePath = path.join(scriptsDir, name);
    const raw = fs.readFileSync(sourcePath, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const normalized = raw.replace(/\r\n/g, "\n");
    metadata.set(name, { sourcePath, raw, eol });
    fs.writeFileSync(path.join(tempScripts, name), normalized, "utf8");
  }

  console.log("PHASE7C_WINDOWS_CLOCK_WRAPPER=START");
  console.log(`PHASE7C_WINDOWS_CLOCK_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);

  const args = [patcherPath];
  if (apply) args.push("--apply");
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, PHASE7C_BROKER_CLOCK_PATCH_ROOT: tempRoot },
    encoding: "utf8",
  });

  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.status !== 0) {
    throw new Error(`Base broker-clock patcher failed in isolated temp copy with exit code ${child.status}. Original controllers were not modified.`);
  }

  if (!apply) {
    console.log("PHASE7C_WINDOWS_CLOCK_CHECK=PASS");
    console.log("PHASE7C_WINDOWS_CLOCK_ORIGINAL_MUTATION=False");
    console.log("PHASE7C_WINDOWS_CLOCK_NEXT=node scripts/apply-phase7c-broker-clock-fix-windows-local.mjs --apply");
    process.exit(0);
  }

  const patchedSideway = fs.readFileSync(path.join(tempScripts, "run-phase7c-sideway-controller.mjs"), "utf8");
  const patchedTrend = fs.readFileSync(path.join(tempScripts, "run-phase7b-demo-controller.ts"), "utf8");
  const requiredSideway = [
    "inferBrokerClockOffset",
    "normalizeBrokerTimestamp",
    "brokerClockOffsetMs",
    "clockOffsetMs: brokerClockOffsetMs",
  ];
  const requiredTrend = [
    "const now = Number(quote.timestamp);",
    "managed.partialActivatedAt = Number(quote.timestamp);",
  ];
  for (const marker of requiredSideway) {
    if (!patchedSideway.includes(marker)) throw new Error(`Patched Sideway validation failed: missing ${marker}`);
  }
  for (const marker of requiredTrend) {
    if (!patchedTrend.includes(marker)) throw new Error(`Patched Trend validation failed: missing ${marker}`);
  }

  const patchedByName = new Map([
    ["run-phase7c-sideway-controller.mjs", patchedSideway],
    ["run-phase7b-demo-controller.ts", patchedTrend],
  ]);

  for (const name of targets) {
    const info = metadata.get(name);
    const backup = `${info.sourcePath}.broker-clock.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, info.raw, "utf8");
    const normalizedPatched = patchedByName.get(name).replace(/\r\n/g, "\n");
    const output = info.eol === "\r\n" ? normalizedPatched.replace(/\n/g, "\r\n") : normalizedPatched;
    fs.writeFileSync(info.sourcePath, output, "utf8");
    console.log(`PHASE7C_WINDOWS_CLOCK_FILE_UPDATED=${info.sourcePath}`);
    console.log(`PHASE7C_WINDOWS_CLOCK_BACKUP=${backup}`);
  }

  console.log("PHASE7C_WINDOWS_CLOCK_APPLY=PASS");
  console.log("PHASE7C_WINDOWS_CLOCK_LINE_ENDINGS=PRESERVED");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
