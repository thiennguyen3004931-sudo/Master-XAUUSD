import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAuditSink, buildAuditEvent } = require("../audit.cjs");

test("audit event shape is bounded and action target is canonical", () => {
  const event = buildAuditEvent({
    timestamp: "2026-09-14T00:00:00.000Z",
    identity: "operator@example.com",
    action: "MODE_TREND",
    phase: "ATTEMPT",
    transactionId: null,
    preflightToken: "SECRET",
    canonicalToken: "SECRET2",
    authorization: "Bearer bad",
    cookie: "secret-cookie",
    headers: { authorization: "bad" },
  });

  assert.deepEqual(event, {
    version: 1,
    timestamp: "2026-09-14T00:00:00.000Z",
    identity: "operator@example.com",
    action: "MODE_TREND",
    phase: "ATTEMPT",
    transactionId: null,
    canonicalTarget: "PHASE7C_BOT_MODE",
  });
  const line = JSON.stringify(event);
  for (const secret of ["SECRET", "SECRET2", "preflightToken", "canonicalToken", "authorization", "cookie", "headers"]) {
    assert.equal(line.includes(secret), false, secret);
  }

  assert.equal(buildAuditEvent({
    timestamp: "2026-09-14T00:00:00.000Z",
    identity: "x",
    action: "MODE_AUTO",
    phase: "ATTEMPT",
  }).canonicalTarget, "PHASE7C_AUTO_ACTIVATION");
});

test("audit sink appends exactly one JSON line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m4-audit-"));
  const auditPath = path.join(dir, "nested", "m4-audit.jsonl");
  const sink = createAuditSink({ auditPath });

  sink.append(buildAuditEvent({
    timestamp: "2026-09-14T00:00:00.000Z",
    identity: "operator@example.com",
    action: "MODE_PAUSE",
    phase: "ATTEMPT",
  }));

  const raw = fs.readFileSync(auditPath, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(raw.trim().split("\n").length, 1);
  assert.equal(JSON.parse(raw).action, "MODE_PAUSE");
});
