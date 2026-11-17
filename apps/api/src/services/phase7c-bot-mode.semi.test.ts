import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  Phase7CBotModeService,
  getPhase7CBotModeOptions,
  isPhase7CBotMode,
} from "./phase7c-bot-mode.service";

test("SEMI is a canonical Phase7C bot mode", () => {
  assert.equal(isPhase7CBotMode("SEMI"), true);
  assert.equal(getPhase7CBotModeOptions().includes("SEMI" as never), true);
});

test("SEMI persists its activation epoch through canonical bot-mode state", () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-semi-mode-"));
  const filePath = join(directory, "phase7c-bot-mode.json");
  const service = new Phase7CBotModeService(filePath);

  const state = (service as any).set("SEMI", "web-control-center");
  const reread = service.get();

  assert.equal(state.mode, "SEMI");
  assert.equal(reread.mode, "SEMI");
  assert.equal(reread.updatedBy, "web-control-center");
  assert.equal(Number.isNaN(Date.parse(reread.updatedAt)), false);
  assert.equal(Date.parse(reread.updatedAt) > 0, true);

  const stored = JSON.parse(readFileSync(filePath, "utf8")) as {
    mode: string;
    updatedAt: string;
  };
  assert.equal(stored.mode, "SEMI");
  assert.equal(stored.updatedAt, reread.updatedAt);
});

test("AUTO source restriction remains unchanged when SEMI is introduced", () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-semi-auto-guard-"));
  const service = new Phase7CBotModeService(join(directory, "mode.json"));

  assert.throws(
    () => service.set("AUTO", "telegram"),
    /AUTO activation is restricted/,
  );
});


test("PAUSE barrier waits for an in-flight execution lock to drain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-pause-barrier-"));
  const modePath = join(directory, "phase7c-bot-mode.json");
  const lockPath = join(directory, "phase7c-execution.lock");
  const service = new Phase7CBotModeService(modePath, lockPath);

  writeFileSync(lockPath, JSON.stringify({ owner: "TREND", createdAt: Date.now() }), "utf8");
  service.set("PAUSE", "web-control-center");

  setTimeout(() => unlinkSync(lockPath), 60);
  const barrier = await service.waitForPauseBarrierDrain(1_000, 10);

  assert.equal(barrier.drained, true);
  assert.equal(barrier.lockPath, lockPath);
  assert.ok(barrier.waitedMs >= 40);
  assert.equal(service.get().mode, "PAUSE");
});

test("PAUSE barrier reports timeout while preserving PAUSE when execution lock remains", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-pause-barrier-timeout-"));
  const modePath = join(directory, "phase7c-bot-mode.json");
  const lockPath = join(directory, "phase7c-execution.lock");
  const service = new Phase7CBotModeService(modePath, lockPath);

  writeFileSync(lockPath, JSON.stringify({ owner: "TREND", createdAt: Date.now() }), "utf8");
  service.set("PAUSE", "web-control-center");

  const barrier = await service.waitForPauseBarrierDrain(40, 10);

  assert.equal(barrier.drained, false);
  assert.equal(service.get().mode, "PAUSE");
  unlinkSync(lockPath);
});
