import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUTHORIZATION_CARD = "apps/web/src/ui/Phase7CExecutionAuthorizationCard.tsx";

async function readAuthorizationCard() {
  return readFile(AUTHORIZATION_CARD, "utf8");
}

test("AUTO success indicator follows canonical current mode instead of stale mutation history", async () => {
  const source = await readAuthorizationCard();

  assert.match(source, /const isAutoActive = botMode === "AUTO";/);
  assert.match(source, /const canAttemptAuto = !isAutoActive && !autoMutation\.isPending;/);
  assert.match(source, /\{autoMutation\.isSuccess && isAutoActive \? \(/);
  assert.doesNotMatch(source, /\{autoMutation\.isSuccess \? \(/);
});

test("AUTO action clearly identifies the canonical active state", async () => {
  const source = await readAuthorizationCard();

  assert.match(source, /isAutoActive\s*\?\s*"AUTO ĐANG BẬT"/s);
});
