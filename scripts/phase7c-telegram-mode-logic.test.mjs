import test from "node:test";
import assert from "node:assert/strict";
import {
  isExpiredTelegramCallbackError,
  nextTelegramUpdateOffset,
  persistedTelegramUpdateOffset,
} from "./phase7c-telegram-mode-logic.mjs";

test("Telegram update offset only moves forward", () => {
  assert.equal(nextTelegramUpdateOffset(100, 105), 106);
  assert.equal(nextTelegramUpdateOffset(106, 99), 106);
  assert.equal(nextTelegramUpdateOffset(106, undefined), 106);
});

test("persisted offset accepts only positive integers", () => {
  assert.equal(persistedTelegramUpdateOffset({ updateOffset: 42 }), 42);
  assert.equal(persistedTelegramUpdateOffset({ updateOffset: 0 }), 0);
  assert.equal(persistedTelegramUpdateOffset({ updateOffset: 1.5 }), 0);
});

test("expired callback errors are non-fatal", () => {
  assert.equal(isExpiredTelegramCallbackError(new Error("Bad Request: query is too old")), true);
  assert.equal(isExpiredTelegramCallbackError(new Error("query ID is invalid")), true);
  assert.equal(isExpiredTelegramCallbackError(new Error("Unauthorized")), false);
});
