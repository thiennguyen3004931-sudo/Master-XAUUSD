import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Phase7CBotModeService } from "../apps/api/src/services/phase7c-bot-mode.service.ts";

function makeTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xauusd-${label}-`));
}

function auditPathFor(statePath: string): string {
  return path.join(path.dirname(statePath), "phase7c-bot-mode-audit.jsonl");
}

function readAudit(statePath: string) {
  const text = fs.readFileSync(auditPathFor(statePath), "utf8").trim();
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

{
  const root = makeTempRoot("bot-mode-audit");
  try {
    const statePath = path.join(root, "phase7c-bot-mode.json");
    const service = new Phase7CBotModeService(statePath);

    const auto = service.set("AUTO", "web-control-center");
    assert.equal(auto.mode, "AUTO");

    let events = readAudit(statePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "BOT_MODE_SET_ATTEMPT");
    assert.equal(events[0].fromMode, "PAUSE");
    assert.equal(events[0].toMode, "AUTO");
    assert.equal(events[0].updatedBy, "web-control-center");
    assert.equal(typeof events[0].pid, "number");
    assert.ok(Number.isInteger(events[0].pid) && events[0].pid > 0);
    assert.ok(Number.isFinite(Date.parse(events[0].updatedAt)));

    service.set("SIDEWAY", "telegram-control");
    events = readAudit(statePath);
    assert.equal(events.length, 2);
    assert.equal(events[0].toMode, "AUTO");
    assert.equal(events[1].fromMode, "AUTO");
    assert.equal(events[1].toMode, "SIDEWAY");
    assert.equal(events[1].updatedBy, "telegram-control");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = makeTempRoot("bot-mode-active-fail-closed");
  try {
    const statePath = path.join(root, "phase7c-bot-mode.json");
    fs.mkdirSync(auditPathFor(statePath));
    const service = new Phase7CBotModeService(statePath);

    assert.throws(
      () => service.set("TREND", "test-active-audit-failure"),
      /EISDIR|illegal operation|directory/i,
    );
    assert.equal(service.get().mode, "PAUSE");
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = makeTempRoot("bot-mode-pause-safety-first");
  try {
    const statePath = path.join(root, "phase7c-bot-mode.json");
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        mode: "AUTO",
        updatedAt: new Date().toISOString(),
        updatedBy: "seed",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.mkdirSync(auditPathFor(statePath));
    const service = new Phase7CBotModeService(statePath);

    const paused = service.set("PAUSE", "test-pause-audit-failure");
    assert.equal(paused.mode, "PAUSE");
    assert.equal(service.get().mode, "PAUSE");

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.mode, "PAUSE");
    assert.equal(persisted.updatedBy, "test-pause-audit-failure");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = makeTempRoot("bot-mode-web-only-auto");
  try {
    const statePath = path.join(root, "phase7c-bot-mode.json");
    const service = new Phase7CBotModeService(statePath);

    assert.throws(
      () => service.set("AUTO", "telegram"),
      /manual Web control center/i,
    );
    assert.equal(service.get().mode, "PAUSE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("PHASE7C_BOT_MODE_PROVENANCE_TEST=PASS");