import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireExecutionLock, readExecutionLock } from "./phase7c-execution-lock.mjs";

test("only one executor owns the shared order lock at a time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7c-lock-"));
  const file = path.join(dir, "order.lock");
  try {
    const trend = acquireExecutionLock({ file, owner: "TREND" });
    assert.equal(trend.acquired, true);
    assert.equal(readExecutionLock(file)?.owner, "TREND");

    const sideway = acquireExecutionLock({ file, owner: "SIDEWAY" });
    assert.equal(sideway.acquired, false);
    assert.equal(sideway.reason, "LOCK_BUSY");

    trend.release();
    const sidewayAfter = acquireExecutionLock({ file, owner: "SIDEWAY" });
    assert.equal(sidewayAfter.acquired, true);
    sidewayAfter.release();
    assert.equal(readExecutionLock(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale lock can be recovered but fresh lock cannot be stolen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7c-lock-stale-"));
  const file = path.join(dir, "order.lock");
  try {
    fs.writeFileSync(file, JSON.stringify({ owner: "DEAD", pid: 999999, createdAt: Date.now() - 60_000, token: "old" }));
    const recovered = acquireExecutionLock({ file, owner: "TREND", staleAfterMs: 1_000 });
    assert.equal(recovered.acquired, true);
    assert.equal(readExecutionLock(file)?.owner, "TREND");
    recovered.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
