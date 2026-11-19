#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist-v6-release");
fs.mkdirSync(outDir, { recursive: true });

const coreFiles = [
  "scripts/mt5-direct-probe.py",
  "scripts/xauusd_v6_trade_rules.py",
  "scripts/xauusd-standalone-server.mjs",
  "scripts/v6-api-input-guards.mjs",
  "scripts/test-v6-live-readiness-observer-source.mjs",
  "scripts/run-mt5-demo-integration.py",
  "scripts/verify-windows-mt5-readonly.py",
  "scripts/package-v6-release.mjs",
  "tests/test_v6_mandatory_t01_t20.py",
  "tests/test_v6_mt5_execution.py",
  "tests/test_v6_trade_rules.py",
  "tests/test_v6_server_source.mjs",
  ".github/workflows/v6-audit-regression-ci.yml",
  "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html",
];

let commitSha = "UNKNOWN";
try {
  commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {}

const entries = [];
const checksumLines = [];
for (const rel of coreFiles) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const buf = fs.readFileSync(full);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  entries.push({ path: rel, bytes: buf.length, sha256 });
  checksumLines.push(`${sha256}  ${rel}`);
}

const manifest = {
  product: "MASTER-XAUUSD-V6",
  releaseVersion: "v6.3.0-rc1",
  commitSha,
  generatedAtUtc: new Date().toISOString(),
  excludesRuntimeAndSecrets: true,
  files: entries,
};

fs.writeFileSync(path.join(outDir, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), checksumLines.join("\n") + "\n", "utf8");
console.log(JSON.stringify({ ok: true, outDir, fileCount: entries.length, commitSha }));
