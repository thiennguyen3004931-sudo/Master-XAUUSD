import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const packageDir = path.join(root, "packages", "copy-protocol");
const sourceDir = path.join(packageDir, "src");
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "bot-ip-protection-p1-copy-protocol-ci.yml"
);

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

test("copy protocol package has no proprietary workspace runtime dependency", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8")
  );
  assert.equal(packageJson.name, "@xauusd/copy-protocol");

  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  assert.deepEqual(
    runtimeDependencies.filter((name) => name.startsWith("@xauusd/")),
    []
  );
});

test("copy protocol source contains no strategy, controller, or private-key material", async () => {
  const files = await listFilesRecursively(sourceDir);
  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "run-phase7b",
    "run-phase7c",
    "BEGIN PRIVATE KEY"
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(
        content.includes(marker),
        false,
        `${path.relative(root, file)} contains forbidden marker: ${marker}`
      );
    }
  }
});

test("dedicated P1 workflow locks the complete security gate", async () => {
  assert.equal((await stat(workflowPath)).isFile(), true);
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /push:\s*\n\s*branches:/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm --filter @xauusd\/copy-protocol test/);
  assert.match(workflow, /pnpm --filter @xauusd\/copy-protocol typecheck/);
  assert.match(workflow, /pnpm --filter @xauusd\/copy-protocol build/);
  assert.match(workflow, /node --test scripts\/test-bot-ip-protection-p1-boundary\.mjs/);
  assert.match(workflow, /git diff --check/);
});
