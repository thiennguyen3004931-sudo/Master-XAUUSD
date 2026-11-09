import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require(path.resolve("apps/web/.ignored_node_modules/typescript"));

function collectTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      results.push(full);
    }
  }
  return results;
}

function rewriteRelativeImports(code, currentOutFile, ext = ".js") {
  const dir = path.dirname(currentOutFile);
  const resolveSpec = (spec) => {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
    if (/\.(?:[cm]?js|json|node)$/i.test(spec)) {
      if (ext === ".cjs" && spec.endsWith(".js")) {
        return spec.slice(0, -3) + ".cjs";
      }
      return spec;
    }
    const candidateFile = path.resolve(dir, spec + ext);
    const candidateIndex = path.resolve(dir, spec, "index" + ext);
    if (fs.existsSync(candidateFile)) return spec + ext;
    if (fs.existsSync(candidateIndex)) return spec.replace(/\/$/, "") + "/index" + ext;
    return spec + ext;
  };

  let out = code.replace(
    /(\b(?:from|import)\s*(?:\(\s*)?)(["'])(\.\.?\/[^"']+)\2/g,
    (m, prefix, q, spec) => `${prefix}${q}${resolveSpec(spec)}${q}`
  );
  if (ext === ".cjs") {
    out = out.replace(
      /(\brequire\s*\(\s*)(["'])(\.\.?\/[^"']+)\2(\s*\))/g,
      (m, prefix, q, spec, suffix) => `${prefix}${q}${resolveSpec(spec)}${q}${suffix}`
    );
  }
  return out;
}

function buildTarget(baseDir) {
  const srcDir = path.join(baseDir, "src");
  const distDir = path.join(baseDir, "dist");
  const files = collectTsFiles(srcDir);
  if (files.length === 0) return 0;

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const outJsFiles = [];
  const outCjsFiles = [];

  for (const file of files) {
    const rel = path.relative(srcDir, file);
    const outRelJs = rel.replace(/\.tsx?$/, ".js");
    const outRelCjs = rel.replace(/\.tsx?$/, ".cjs");
    const outJs = path.join(distDir, outRelJs);
    const outCjs = path.join(distDir, outRelCjs);
    const outDts = path.join(distDir, rel.replace(/\.tsx?$/, ".d.ts"));

    fs.mkdirSync(path.dirname(outJs), { recursive: true });
    const source = fs.readFileSync(file, "utf8");

    const esm = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
    });
    fs.writeFileSync(outJs, esm.outputText, "utf8");
    outJsFiles.push(outJs);

    const cjs = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
    });
    fs.writeFileSync(outCjs, cjs.outputText, "utf8");
    outCjsFiles.push(outCjs);

    fs.writeFileSync(outDts, "export {};\n", "utf8");
  }

  for (const f of outJsFiles) {
    const content = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, rewriteRelativeImports(content, f, ".js"), "utf8");
  }
  for (const f of outCjsFiles) {
    const content = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, rewriteRelativeImports(content, f, ".cjs"), "utf8");
  }

  return files.length;
}

const rootNodeModulesScope = path.resolve("node_modules/@xauusd");
fs.mkdirSync(rootNodeModulesScope, { recursive: true });

for (const pkgName of fs.readdirSync("packages")) {
  const pkgDir = path.join("packages", pkgName);
  if (!fs.statSync(pkgDir).isDirectory()) continue;
  const count = buildTarget(pkgDir);
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) continue;
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.name && pkgJson.name.startsWith("@xauusd/")) {
    const shortName = pkgJson.name.split("/")[1];
    const linkPath = path.join(rootNodeModulesScope, shortName);
    try { fs.unlinkSync(linkPath); } catch {}
    fs.symlinkSync(path.resolve(pkgDir), linkPath, "dir");
  }
  console.log(`OFFLINE_BUILD_PACKAGE=${pkgName}|FILES=${count}`);
}

const apiCount = buildTarget("apps/api");
console.log(`OFFLINE_BUILD_API=PASS|FILES=${apiCount}`);
