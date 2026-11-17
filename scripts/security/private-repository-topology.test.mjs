import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, ".github", "workflows");

const publicOnlyWorkflows = [
  "public-private-boundary-ci.yml",
  "public-distribution-ci.yml",
];

test("private Master/Core repository does not retain public-only CI workflows", () => {
  const retained = publicOnlyWorkflows.filter((workflow) =>
    fs.existsSync(path.join(workflowsDir, workflow)),
  );

  assert.deepEqual(
    retained,
    [],
    `RED_TARGET: public-only workflows retained in private Master/Core: ${retained.join(", ")}`,
  );
});
