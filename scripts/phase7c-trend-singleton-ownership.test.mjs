import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const controllerPath = path.join(root, "scripts", "run-phase7c-trend-controller.mjs");
const helperPath = path.join(root, "scripts", "phase7c-runtime-singleton-lock.mjs");
const controllerSource = fs.readFileSync(controllerPath, "utf8");

function sourceIndex(pattern, message) {
  const match = pattern.exec(controllerSource);
  assert.ok(match, message);
  return match.index;
}

test("Trend runtime acquires process-lifetime singleton ownership before heartbeat and legacy execution", () => {
  const importIndex = sourceIndex(
    /import\s*\{[^}]*acquireRuntimeSingleton[^}]*\}\s*from\s*["']\.\/phase7c-runtime-singleton-lock\.mjs["']\s*;/,
    "RED_TARGET: Trend runtime must import acquireRuntimeSingleton.",
  );
  const acquireIndex = sourceIndex(
    /acquireRuntimeSingleton\s*\(\s*\{[\s\S]*?owner\s*:\s*["']TREND["'][\s\S]*?\}\s*\)/,
    "RED_TARGET: Trend runtime must acquire TREND single-writer ownership.",
  );
  const heartbeatIndex = sourceIndex(
    /startTrendRuntimeHeartbeat\s*\(\s*\)\s*;/,
    "Trend runtime heartbeat anchor is missing.",
  );
  const legacyImportIndex = sourceIndex(
    /await\s+importLegacyTrendController\s*\(\s*\)\s*;/,
    "Trend legacy-controller import anchor is missing.",
  );
  const releaseIndex = sourceIndex(
    /process\.once\s*\(\s*["']exit["'][\s\S]*?\.release\s*\(\s*\)/,
    "RED_TARGET: Trend runtime ownership must be released only on process exit.",
  );

  assert.ok(importIndex < acquireIndex, "Singleton helper import must precede acquisition.");
  assert.ok(acquireIndex < heartbeatIndex, "RED_TARGET: single-writer ownership must be acquired before heartbeat starts.");
  assert.ok(acquireIndex < legacyImportIndex, "RED_TARGET: single-writer ownership must be acquired before legacy Trend execution.");
  assert.ok(releaseIndex > acquireIndex, "Ownership release hook must be registered after acquisition.");
});

test("runtime singleton lock rejects a live owner, recovers a dead owner, and releases by token", async () => {
  assert.equal(
    fs.existsSync(helperPath),
    true,
    "RED_TARGET: phase7c-runtime-singleton-lock.mjs must provide process-lifetime ownership.",
  );

  const moduleUrl = `${pathToFileURL(helperPath).href}?test=${Date.now()}`;
  const { acquireRuntimeSingleton } = await import(moduleUrl);
  assert.equal(typeof acquireRuntimeSingleton, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7c-trend-singleton-"));
  const file = path.join(dir, "trend-runtime.lock");

  try {
    const first = acquireRuntimeSingleton({ file, owner: "TREND" });
    assert.equal(first.acquired, true);

    const liveDuplicate = acquireRuntimeSingleton({ file, owner: "TREND" });
    assert.equal(liveDuplicate.acquired, false);
    assert.equal(liveDuplicate.reason, "LOCK_BUSY_LIVE_OWNER");

    first.release();
    assert.equal(fs.existsSync(file), false);

    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        owner: "TREND",
        pid: 2147483647,
        token: "dead-owner",
        createdAt: Date.now() - 60_000,
      }),
      "utf8",
    );

    const recovered = acquireRuntimeSingleton({ file, owner: "TREND" });
    assert.equal(recovered.acquired, true);
    assert.notEqual(recovered.token, "dead-owner");

    const replacement = {
      version: 1,
      owner: "TREND",
      pid: process.pid,
      token: "replacement-owner-token",
      createdAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(replacement), "utf8");
    recovered.release();
    assert.equal(fs.existsSync(file), true, "Release must not remove a lock whose token changed.");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, replacement.token);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
