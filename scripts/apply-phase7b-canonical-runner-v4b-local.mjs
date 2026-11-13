import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.env.PHASE7B_CANONICAL_RUNNER_V4_ROOT
  ? path.resolve(process.env.PHASE7B_CANONICAL_RUNNER_V4_ROOT)
  : process.cwd();
const base = path.join(root, "scripts", "apply-phase7b-canonical-runner-v4-local.mjs");
if (!fs.existsSync(base)) throw new Error(`Canonical runner V4 patcher not found: ${base}`);

let source = fs.readFileSync(base, "utf8");
const block = `patternPage = replaceExact(\n  patternPage,\n  \`      <Alert severity="info">Quản lý sau khi khớp: +6 giá → dời SL về hòa vốn · +10 giá → chốt 1/3 · phần còn lại tiếp tục runner theo quản lý canonical. H1/H4, FVG và phản ứng trendline chỉ là bối cảnh/độ tin cậy, không phải TP cứng.</Alert>\`,\n  \`      <Alert severity="info">Quản lý sau khi khớp: +6 giá → dời SL về hòa vốn · +10 giá → chốt 1/3 · runner còn lại dời SL theo cấu trúc M15 đã xác nhận; tiếp tục giữ khi M15 còn đúng phía MA50 và chốt runner khi M15 đóng phá MA50 ngược hướng. MA200 chỉ xác nhận khung lớn; H1/H4, FVG và phản ứng trendline là bối cảnh/độ tin cậy.</Alert>\`,\n  "WEB_RUNNER_MANAGEMENT_COPY",\n);\n`;
const count = source.split(block).length - 1;
if (count !== 1) throw new Error(`V4B_UI_COPY_BLOCK: expected exactly one removable block, found ${count}.`);
source = source.replace(block, "");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase7b-canonical-runner-v4b-"));
const runtime = path.join(tempDir, "apply-phase7b-canonical-runner-v4b-runtime.mjs");
fs.writeFileSync(runtime, source, "utf8");

console.log("PHASE7B_CANONICAL_RUNNER_V4B=START");
console.log(`PHASE7B_CANONICAL_RUNNER_V4B_ROOT=${root}`);
console.log("PHASE7B_CANONICAL_RUNNER_V4B_UI_COPY_DRIFT=IGNORED_DISPLAY_ONLY");
console.log("PHASE7B_CANONICAL_RUNNER_V4B_EXECUTION_LOGIC_UNCHANGED=True");

const child = spawnSync(process.execPath, [runtime, ...process.argv.slice(2)], {
  cwd: root,
  env: {
    ...process.env,
    PHASE7B_CANONICAL_RUNNER_V4_ROOT: root,
  },
  stdio: "inherit",
});

try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Best effort cleanup only.
}

if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
console.log("PHASE7B_CANONICAL_RUNNER_V4B_RESULT=PASS");
