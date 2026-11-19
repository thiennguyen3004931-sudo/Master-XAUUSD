import fs from "node:fs";
import path from "node:path";

const root = process.env.PHASE7B_PATTERN_V2_PATCH_ROOT
  ? path.resolve(process.env.PHASE7B_PATTERN_V2_PATCH_ROOT)
  : process.cwd();

const migrationPath = path.join(root, "scripts", "apply-phase7b-pattern-rule-v2-local.mjs");
const migration = fs.readFileSync(migrationPath, "utf8");

const targets = [
  {
    file: path.join(root, "packages", "risk-engine", "src", "services", "Phase7BDualPatternTrendRiderService.ts"),
    functionName: "detectPattern",
    replacement: extractTemplate("serviceDetect"),
  },
  {
    file: path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
    functionName: "detectEntryPattern",
    replacement: extractTemplate("controllerDetect"),
  },
  {
    file: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
    functionName: "detectEntryPattern",
    replacement: extractTemplate("apiDetect"),
  },
];

let changed = 0;
for (const target of targets) {
  if (!fs.existsSync(target.file)) throw new Error(`Required file not found: ${target.file}`);
  const source = fs.readFileSync(target.file, "utf8");
  const next = replaceFunction(source, target.functionName, target.replacement);
  if (next !== source) {
    fs.writeFileSync(target.file, next, "utf8");
    changed += 1;
  }
}

console.log("PHASE7B_PATTERN_V2_FINALIZE=PASS");
console.log(`PHASE7B_PATTERN_V2_FINALIZE_FILES_CHANGED=${changed}`);
console.log("PHASE7B_PATTERN_V2_TWO_CANDLE=B_LT_A_AND_B_PLUS_C_GT_A");
console.log("PHASE7B_PATTERN_V2_THREE_CANDLE=B_PLUS_C_LT_A_AND_B_PLUS_C_PLUS_D_GT_A");
console.log("PHASE7B_PATTERN_V2_PRIORITY=THREE_THEN_TWO_THEN_ENGULFING");

function extractTemplate(name) {
  const startMarker = `const ${name} = \``;
  const start = migration.indexOf(startMarker);
  if (start < 0) throw new Error(`Template ${name} not found in migration script.`);
  const contentStart = start + startMarker.length;
  const end = migration.indexOf("`;", contentStart);
  if (end < 0) throw new Error(`Template ${name} is unterminated.`);
  return migration.slice(contentStart, end);
}

function replaceFunction(source, functionName, replacement) {
  const marker = `function ${functionName}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Function ${functionName} not found.`);
  const tail = source.slice(start);
  const bodyMatch = /\|\s*null\s*\{/.exec(tail);
  if (!bodyMatch) throw new Error(`Function body for ${functionName} not found.`);
  const openBrace = start + bodyMatch.index + bodyMatch[0].lastIndexOf("{");
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`Closing brace for ${functionName} not found.`);
  const current = source.slice(start, end).replace(/\r\n/g, "\n").trim();
  const canonical = replacement.replace(/\r\n/g, "\n").trim();
  if (current === canonical) return source;
  return source.slice(0, start) + replacement + source.slice(end);
}
