import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = readFileSync(resolve(root, "scripts/xauusd-standalone-server.mjs"), "utf8");

test("manual V6 order requires an explicit BUY/SELL direction; never defaults to BUY", () => {
  assert.match(server, /requestedSide !== "BUY" && requestedSide !== "SELL"/);
  assert.match(server, /side: requestedSide/);
  assert.doesNotMatch(server, /side:\s*body\.side\s*\|\|\s*["']BUY["']/);
});

test("V6 close web API requires a positive safe integer ticket", () => {
  assert.match(server, /Number\.isSafeInteger\(ticket\)/);
  assert.match(server, /ticket <= 0/);
  assert.match(server, /action: "close", ticket/);
});
