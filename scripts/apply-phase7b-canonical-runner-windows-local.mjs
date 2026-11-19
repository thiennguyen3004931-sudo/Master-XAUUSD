import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_CANONICAL_RUNNER_WINDOWS_ROOT
  ? path.resolve(process.env.PHASE7B_CANONICAL_RUNNER_WINDOWS_ROOT)
  : process.cwd();

const targetRel = [
  "scripts/run-phase7b-demo-controller.ts",
  "apps/api/src/routes/phase7b-demo.route.ts",
  "apps/web/src/ui/DashboardLayout.tsx",
  "apps/web/src/pages/Phase7BPatternCheckPage.tsx",
];
const patcherRel = [
  "scripts/apply-phase7b-supertrend-entry-gates-local.mjs",
  "scripts/apply-phase7b-supertrend-entry-gates-v2-local.mjs",
  "scripts/apply-phase7b-canonical-entry-v3-local.mjs",
  "scripts/apply-phase7b-canonical-runner-v4-local.mjs",
  "scripts/apply-phase7b-canonical-runner-v4b-local.mjs",
];
const allRel = [...targetRel, ...patcherRel];

for (const rel of allRel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const originals = new Map();
const eols = new Map();
for (const rel of targetRel) {
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  originals.set(rel, source);
  eols.set(rel, source.includes("\r\n") ? "\r\n" : "\n");
}

preflightOriginals();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase7b-canonical-runner-windows-"));
try {
  for (const rel of allRel) {
    const src = path.join(root, rel);
    const dst = path.join(tempRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const normalized = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
    fs.writeFileSync(dst, normalized, "utf8");
  }

  console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS=START");
  console.log(`PHASE7B_CANONICAL_RUNNER_WINDOWS_ROOT=${root}`);
  console.log(`PHASE7B_CANONICAL_RUNNER_WINDOWS_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
  console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_TEMP_EOL=LF");
  console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_NESTED_PATCHERS_NORMALIZED=True");
  console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_REAL_ACCOUNT_ALLOWED=False");

  let alreadyCanonical = false;
  try {
    validateTempResult();
    alreadyCanonical = true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`PHASE7B_CANONICAL_RUNNER_WINDOWS_CURRENT_CANONICAL=False|${detail}`);
    alreadyCanonical = false;
  }

  if (alreadyCanonical) {
    console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_CURRENT_CANONICAL=True");
    console.log("PHASE7B_CANONICAL_RUNNER_V4_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING");
    console.log("PHASE7B_CANONICAL_RUNNER_V4_RUNNER_EXIT=M15_CLOSE_BREAKS_MA50_AFTER_PLUS10_PARTIAL_ONLY");
    console.log("PHASE7B_CANONICAL_RUNNER_V4_MA200=MACRO_CONTEXT_ONLY_NOT_ENTRY_OR_EXIT_GATE");
  } else {
    const runner = path.join(tempRoot, "scripts", "apply-phase7b-canonical-runner-v4b-local.mjs");
    const child = spawnSync(process.execPath, [runner, "--apply"], {
      cwd: tempRoot,
      env: {
        ...process.env,
        PHASE7B_CANONICAL_RUNNER_V4_ROOT: tempRoot,
        PHASE7B_CANONICAL_ENTRY_V3_ROOT: tempRoot,
        PHASE7B_SUPERTREND_GATE_PATCH_ROOT: tempRoot,
      },
      encoding: "utf8",
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Temporary canonical runner patch failed with exit code ${child.status}.`);
  }

  validateTempResult();
  console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_TEMP_VALIDATION=PASS");

  if (!apply) {
    for (const rel of targetRel) {
      if (fs.readFileSync(path.join(root, rel), "utf8") !== originals.get(rel)) {
        throw new Error(`CHECK_ONLY mutated original target: ${rel}`);
      }
    }
    console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_ORIGINAL_MUTATION=False");
    console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_CHECK=PASS");
    process.exitCode = 0;
  } else {
    for (const rel of targetRel) {
      const actual = path.join(root, rel);
      const backup = `${actual}.canonical-runner-windows.bak`;
      if (!fs.existsSync(backup)) fs.copyFileSync(actual, backup);
    }
    for (const rel of targetRel) {
      const actual = path.join(root, rel);
      let output = fs.readFileSync(path.join(tempRoot, rel), "utf8").replace(/\r\n/g, "\n");
      if (eols.get(rel) === "\r\n") output = output.replace(/\n/g, "\r\n");
      fs.writeFileSync(actual, output, "utf8");
      console.log(`PHASE7B_CANONICAL_RUNNER_WINDOWS_FILE_UPDATED=${actual}`);
      console.log(`PHASE7B_CANONICAL_RUNNER_WINDOWS_BACKUP=${actual}.canonical-runner-windows.bak`);
    }
    console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_APPLY=PASS");
    console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_LINE_ENDINGS=PRESERVED");
    console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_DEMO_ONLY=True");
  }
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
  }
}

function preflightOriginals() {
  const controller = originals.get("scripts/run-phase7b-demo-controller.ts");
  const api = originals.get("apps/api/src/routes/phase7b-demo.route.ts");
  const required = [
    [controller, "THREE_CANDLE_BODY_DOMINANCE", "three-candle pattern prerequisite"],
    [controller, "const now = Number(quote.timestamp)", "broker-clock prerequisite"],
    [api, "inferBrokerClockOffset", "UI broker-clock prerequisite"],
  ];
  for (const [source, marker, label] of required) {
    if (!source.includes(marker)) throw new Error(`Missing ${label}: ${marker}`);
  }
  console.log("PHASE7B_CANONICAL_RUNNER_WINDOWS_PREFLIGHT=PASS");
}

function validateTempResult() {
  const controller = fs.readFileSync(path.join(tempRoot, "scripts/run-phase7b-demo-controller.ts"), "utf8");
  const api = fs.readFileSync(path.join(tempRoot, "apps/api/src/routes/phase7b-demo.route.ts"), "utf8");
  const layout = fs.readFileSync(path.join(tempRoot, "apps/web/src/ui/DashboardLayout.tsx"), "utf8");
  const page = fs.readFileSync(path.join(tempRoot, "apps/web/src/pages/Phase7BPatternCheckPage.tsx"), "utf8");

  const controllerRequired = [
    "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE",
    "PHASE7B_DEMO_MA20_MA50=CONFIDENCE_ONLY_NOT_ENTRY_GATE",
    "PHASE7B_DEMO_MA50=RUNNER_HOLD_EXIT_AFTER_PLUS10_PARTIAL_ONLY",
    "PHASE7B_DEMO_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING",
    "PHASE7B_DEMO_MA200=MACRO_CONTEXT_ONLY_NOT_ENTRY_OR_EXIT_GATE",
    "latestConfirmedStructureStop",
    "STRUCTURAL_SL_TIGHTEN",
    "runnerTrendBroken = managed.partialApplied && !ma50TrendIntact",
    "RUNNER_TREND_MA50",
    "THREE_CANDLE_BODY_DOMINANCE",
    "const now = Number(quote.timestamp)",
  ];
  for (const marker of controllerRequired) {
    if (!controller.includes(marker)) throw new Error(`Temporary controller validation missing: ${marker}`);
  }
  const controllerForbidden = [
    'closeAll(position, "TREND_MA20"',
    'closeAll(position, "TREND_MA200"',
    "if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) return null;",
  ];
  for (const marker of controllerForbidden) {
    if (controller.includes(marker)) throw new Error(`Temporary controller forbidden marker remains: ${marker}`);
  }
  if (!api.includes("&& supertrendAligned") || !api.includes("&& structuralStopDistance <= 10")) {
    throw new Error("Temporary API is missing the Supertrend and maximum structural-stop entry gates.");
  }
  if (!api.includes("inferBrokerClockOffset")) throw new Error("Temporary API lost broker-clock normalization.");

  const semanticUiV2 = page.includes("SEMANTIC UI v2") && page.includes("fetchPhase7CWebStatus");
  const layoutRoleValid = layout.includes("SL cấu trúc 6–10; >10 chờ hồi") || semanticUiV2;
  if (!layoutRoleValid) throw new Error("Temporary layout canonical stop-rule / Semantic UI v2 marker missing.");

  const pageRoleValid = page.includes("Chỉ xác nhận xu hướng khung lớn") || semanticUiV2;
  if (!pageRoleValid) throw new Error("Temporary page canonical role / Semantic UI v2 marker missing.");
}
