import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(here, "../dist");

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...collectJsFiles(full));
    else if (stat.isFile() && full.endsWith(".js")) files.push(full);
  }
  return files;
}

function resolveSpecifier(file, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;
  if (/\.(?:[cm]?js|json|node)$/i.test(specifier)) return specifier;

  const target = resolve(dirname(file), specifier);
  if (existsSync(`${target}.js`)) return `${specifier}.js`;
  if (existsSync(join(target, "index.js"))) return `${specifier.replace(/\/$/, "")}/index.js`;

  throw new Error(`Unresolved relative ESM import in ${file}: ${specifier}`);
}

if (!existsSync(distRoot)) {
  throw new Error(`API dist directory not found: ${distRoot}`);
}

const importPattern = /(\b(?:from|import)\s*(?:\(\s*)?)(["'])(\.\.?\/[^"']+)\2/g;
let rewritten = 0;

for (const file of collectJsFiles(distRoot)) {
  const source = readFileSync(file, "utf8");
  const output = source.replace(importPattern, (match, prefix, quote, specifier) => {
    const resolved = resolveSpecifier(file, specifier);
    if (resolved !== specifier) rewritten += 1;
    return `${prefix}${quote}${resolved}${quote}`;
  });

  if (output !== source) {
    writeFileSync(file, output, "utf8");
  }
}

console.log(`API_ESM_RELATIVE_IMPORT_REWRITES=${rewritten}`);
