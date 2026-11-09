import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workArg = process.argv[2];
if (!workArg) {
  console.error("Usage: node scripts/freeze-phase4-replay-dataset.mjs <work-dir>");
  process.exit(1);
}

const work = path.resolve(workArg);
const inputs = [
  ["m15", "phase4-m15.json"],
  ["m5", "phase4-m5.json"],
  ["meta", "phase4-meta.json"],
];

for (const [, name] of inputs) {
  const source = path.join(work, name);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing replay input: ${source}`);
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const frozenDir = path.join(work, `frozen-${stamp}`);
fs.mkdirSync(frozenDir, { recursive: false });

const manifest = {
  createdAtUtc: new Date().toISOString(),
  sourceWorkDir: work,
  files: {},
};

for (const [key, name] of inputs) {
  const source = path.join(work, name);
  const destination = path.join(frozenDir, name);
  const bytes = fs.readFileSync(source);
  fs.writeFileSync(destination, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  let jsonCount = null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    jsonCount = Array.isArray(parsed) ? parsed.length : null;
  } catch {
    jsonCount = null;
  }

  manifest.files[key] = {
    name,
    bytes: bytes.length,
    sha256,
    jsonCount,
  };
}

const manifestPath = path.join(frozenDir, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`PHASE4_DATASET_FREEZE_DIR=${frozenDir}`);
for (const [key] of inputs) {
  const item = manifest.files[key];
  console.log(`PHASE4_DATASET_${key.toUpperCase()}_SHA256=${item.sha256}`);
  if (item.jsonCount !== null) {
    console.log(`PHASE4_DATASET_${key.toUpperCase()}_COUNT=${item.jsonCount}`);
  }
}
console.log("PHASE4_DATASET_FREEZE_STATUS=PASS");
console.log(`POWERSHELL_ZIQ_M15=$env:ZIQ_M15_JSON=\"${path.join(frozenDir, "phase4-m15.json")}\"`);
console.log(`POWERSHELL_ZIQ_M5=$env:ZIQ_M5_JSON=\"${path.join(frozenDir, "phase4-m5.json")}\"`);
console.log(`POWERSHELL_ZIQ_META=$env:ZIQ_META_JSON=\"${path.join(frozenDir, "phase4-meta.json")}\"`);
