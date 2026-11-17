"use strict";

const crypto = require("node:crypto");

function normalizeIdentity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function createTransactionStore({ now = Date.now, randomUUID = crypto.randomUUID } = {}) {
  const records = new Map();

  function requireRecord(transactionId) {
    const id = String(transactionId ?? "").trim();
    const record = records.get(id);
    if (!record) throw new Error("TRANSACTION_NOT_FOUND");
    return record;
  }

  function assertBound(record, identity, action) {
    if (record.identity !== normalizeIdentity(identity)) throw new Error("TRANSACTION_IDENTITY_MISMATCH");
    if (action && record.action !== action) throw new Error("TRANSACTION_ACTION_MISMATCH");
    if (now() >= record.expiresAt) throw new Error("TRANSACTION_EXPIRED");
  }

  function create({ identity, action, canonicalToken, expiresAt, preflight }) {
    const id = randomUUID();
    const current = now();
    const canonicalExpiry = Number(expiresAt);
    const effectiveExpiry = Number.isFinite(canonicalExpiry)
      ? Math.min(canonicalExpiry, current + 45_000)
      : current + 45_000;
    if (effectiveExpiry <= current) throw new Error("TRANSACTION_EXPIRED");
    const record = {
      id,
      identity: normalizeIdentity(identity),
      action,
      canonicalToken,
      expiresAt: effectiveExpiry,
      consumed: false,
      requestId: null,
      canonicalStatus: null,
      preflight: preflight ?? null,
    };
    records.set(id, record);
    return id;
  }

  function getForExecute(identity, action, transactionId) {
    const record = requireRecord(transactionId);
    assertBound(record, identity, action);
    if (record.consumed) throw new Error("TRANSACTION_ALREADY_CONSUMED");
    if (!record.canonicalToken) throw new Error("TRANSACTION_TOKEN_MISSING");
    return { ...record };
  }

  function markExecuting(transactionId) {
    const record = requireRecord(transactionId);
    if (record.consumed) throw new Error("TRANSACTION_ALREADY_CONSUMED");
    record.consumed = true;
    record.canonicalToken = null;
    return { ...record };
  }

  function setRequestId(transactionId, requestId) {
    const record = requireRecord(transactionId);
    record.requestId = String(requestId ?? "").trim() || null;
  }

  function updateCanonicalStatus(transactionId, status) {
    const record = requireRecord(transactionId);
    record.canonicalStatus = status ? { ...status } : null;
  }

  function readStatus(identity, transactionId) {
    const record = requireRecord(transactionId);
    if (record.identity !== normalizeIdentity(identity)) throw new Error("TRANSACTION_IDENTITY_MISMATCH");
    return {
      transactionId: record.id,
      action: record.action,
      expiresAt: record.expiresAt,
      consumed: record.consumed,
      requestId: record.requestId,
      canonicalStatus: record.canonicalStatus ? { ...record.canonicalStatus } : null,
    };
  }

  function deleteExpired() {
    const current = now();
    for (const [id, record] of records.entries()) {
      if (current >= record.expiresAt && !record.requestId) records.delete(id);
    }
  }

  function _unsafePeekForTest(transactionId) {
    const record = requireRecord(transactionId);
    return { ...record };
  }

  return Object.freeze({
    create,
    getForExecute,
    markExecuting,
    setRequestId,
    updateCanonicalStatus,
    readStatus,
    deleteExpired,
    _unsafePeekForTest,
  });
}

module.exports = { createTransactionStore };
