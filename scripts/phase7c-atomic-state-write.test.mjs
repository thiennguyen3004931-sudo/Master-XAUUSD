import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeStateFileAtomicSync } from "./phase7c-atomic-state-write.mjs";

const controllerSource = fs.readFileSync(
  path.join(process.cwd(), "scripts", "run-phase7b-demo-controller.ts"),
  "utf8",
);

test("atomic state writer replaces an existing canonical state without deleting it first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7c-state-write-"));
  const target = path.join(dir, "phase7b-demo-state.json");
  try {
    fs.writeFileSync(target, "{\"version\":1}\n", "utf8");
    const result = writeStateFileAtomicSync(target, "{\"version\":2}\n");
    assert.equal(result.attempts, 1);
    assert.equal(result.recoveredFromTransientRename, false);
    assert.equal(fs.readFileSync(target, "utf8"), "{\"version\":2}\n");
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic state writer retries transient Windows rename errors and preserves canonical target", () => {
  const calls = [];
  let renameAttempt = 0;
  const fakeFs = {
    writeFileSync(file, content, encoding) {
      calls.push(["write", file, content, encoding]);
    },
    renameSync(from, to) {
      renameAttempt += 1;
      calls.push(["rename", from, to, renameAttempt]);
      if (renameAttempt <= 2) {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
    },
    unlinkSync(file) {
      calls.push(["unlink", file]);
      const error = new Error("already moved");
      error.code = "ENOENT";
      throw error;
    },
  };
  const sleeps = [];
  const target = "F:\\Project\\XAUUSD_AI_MASTER\\xauusd-ai-master\\.runtime\\phase7b-live-forward\\phase7b-demo-state.json";
  const result = writeStateFileAtomicSync(target, "{\"version\":2}\n", {
    fsImpl: fakeFs,
    maxAttempts: 6,
    retryDelayMs: 100,
    tempPathFactory: (file) => file + ".4321.unique.tmp",
    sleep: (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(result.attempts, 3);
  assert.equal(result.recoveredFromTransientRename, true);
  assert.deepEqual(sleeps, [100, 100]);
  assert.equal(calls.filter(([kind]) => kind === "rename").length, 3);
  assert.equal(
    calls.some(([kind, file]) => kind === "unlink" && file === target),
    false,
    "canonical state must never be deleted as part of rename recovery",
  );
});

test("atomic state writer fails closed after bounded retry exhaustion and only cleans temp", () => {
  const calls = [];
  const fakeFs = {
    writeFileSync(file) {
      calls.push(["write", file]);
    },
    renameSync(from, to) {
      calls.push(["rename", from, to]);
      const error = new Error("resource busy");
      error.code = "EBUSY";
      throw error;
    },
    unlinkSync(file) {
      calls.push(["unlink", file]);
    },
  };
  const target = "state.json";
  assert.throws(
    () =>
      writeStateFileAtomicSync(target, "{}", {
        fsImpl: fakeFs,
        maxAttempts: 3,
        retryDelayMs: 0,
        tempPathFactory: () => "state.json.123.tmp",
        sleep: () => {},
      }),
    (error) => error?.code === "EBUSY",
  );
  assert.equal(calls.filter(([kind]) => kind === "rename").length, 3);
  assert.deepEqual(calls.filter(([kind]) => kind === "unlink"), [["unlink", "state.json.123.tmp"]]);
  assert.equal(
    calls.some(([kind, file]) => kind === "unlink" && file === target),
    false,
  );
});

test("atomic state writer does not retry non-transient rename failures", () => {
  let attempts = 0;
  const fakeFs = {
    writeFileSync() {},
    renameSync() {
      attempts += 1;
      const error = new Error("bad path");
      error.code = "ENOENT";
      throw error;
    },
    unlinkSync() {},
  };

  assert.throws(
    () =>
      writeStateFileAtomicSync("state.json", "{}", {
        fsImpl: fakeFs,
        maxAttempts: 6,
        retryDelayMs: 0,
        tempPathFactory: () => "state.tmp",
        sleep: () => {},
      }),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(attempts, 1);
});


test("Trend/REVERSAL controller uses the atomic state writer instead of a fixed .tmp rename", () => {
  assert.match(
    controllerSource,
    /import\s*\{\s*writeStateFileAtomicSync\s*\}\s*from\s*["']\.\/phase7c-atomic-state-write\.mjs["']/,
  );
  assert.match(
    controllerSource,
    /function\s+saveState\(\):\s*void\s*\{[\s\S]*?writeStateFileAtomicSync\(statePath,\s*payload\)/,
  );
  assert.doesNotMatch(
    controllerSource,
    /const\s+temp\s*=\s*\`\$\{statePath\}\.tmp\`/,
    "fixed shared phase7b-demo-state.json.tmp path must not return",
  );
  assert.doesNotMatch(
    controllerSource,
    /fs\.renameSync\(temp,\s*statePath\)/,
    "controller must delegate Windows rename recovery to the atomic helper",
  );
});
