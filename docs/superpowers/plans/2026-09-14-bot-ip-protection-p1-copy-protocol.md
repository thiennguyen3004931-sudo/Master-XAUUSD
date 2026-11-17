# BOT IP Protection P1 — Copy Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a strategy-independent copy-command protocol package with deterministic serialization and Ed25519 signing/verification, proven by TDD and dedicated CI.

**Architecture:** Add a new workspace package, `@xauusd/copy-protocol`, that contains only transport/security contracts shared by Master and future Follower Agent. P1 does not perform license-state checks, device enrollment, replay persistence, follower execution, or MT5 mutations; it only defines the signed command body, deterministic canonical bytes, and cryptographic sign/verify primitives.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 10.18.0, tsup, Vitest, built-in `node:crypto` Ed25519.

**Spec:** `docs/superpowers/specs/2026-09-14-bot-ip-protection-license-v1-design.md`

## Global Constraints

- `xauusd-ai-master` remains the private canonical Master/Core repository.
- Proprietary strategy logic never becomes a dependency of `@xauusd/copy-protocol`.
- Allowed V1 command actions are exactly `POSITION_OPEN`, `STOP_LOSS_UPDATE`, `TAKE_PROFIT_UPDATE`, `PARTIAL_CLOSE`, `POSITION_CLOSE`, `POSITION_SNAPSHOT`.
- Command signatures use Ed25519.
- The Ed25519 private signing key must never be committed to source, tests, fixtures, logs, browser code, or follower artifacts.
- `keyId` is part of the signed body.
- Every security-relevant command field is inside the signed body; only `signature` is outside it.
- P1 uses integer UTC epoch milliseconds for `issuedAt` and `expiresAt`.
- `sequence` is a positive JavaScript safe integer; stream persistence/replay state is implemented in P4, not P1.
- P1 has no production runtime integration and no broker/network side effects.
- `PRODUCTION_MUTATION=NONE`, `BOT_RUNTIME_MUTATION=NONE`, `MODE_MUTATION=NONE`, `ARM_MUTATION=NONE`, `TASK_MUTATION=NONE`, `PROCESS_MUTATION=NONE`, `ORDER_MUTATION=NONE`, `POSITION_MUTATION=NONE`, `LIVE_TEST_ORDER=NONE`.

## File Structure

Create a new package with one responsibility per file:

```text
packages/copy-protocol/
  package.json                     package/build/test contract; zero workspace runtime deps
  tsconfig.json                    standard repo TypeScript config
  src/
    command.ts                     command action/types + runtime body assertion
    canonical-json.ts              deterministic JSON serialization
    ed25519.ts                     sign/verify only
    index.ts                       public exports
    command.test.ts                command-body validation tests
    canonical-json.test.ts         deterministic byte-contract tests
    ed25519.test.ts                Ed25519/tamper/key-id tests
scripts/
  test-bot-ip-protection-p1-boundary.mjs   no-strategy-dependency/private-key boundary contract
.github/workflows/
  bot-ip-protection-p1-copy-protocol-ci.yml dedicated Linux CI
```

`@xauusd/copy-protocol` must have no runtime dependency on any other `@xauusd/*` workspace package. This keeps the protocol portable for the future Follower Agent and prevents accidental strategy bundling.

---

### Task 1: Create the copy-command contract package

**Files:**
- Create: `packages/copy-protocol/package.json`
- Create: `packages/copy-protocol/tsconfig.json`
- Create: `packages/copy-protocol/src/command.test.ts`
- Create: `packages/copy-protocol/src/command.ts`
- Create: `packages/copy-protocol/src/index.ts`
- Modify: `pnpm-lock.yaml` via `pnpm install`

**Interfaces:**
- Produces: `COPY_COMMAND_ACTIONS`, `CopyCommandAction`, `JsonValue`, `JsonObject`, `CopyCommandBody`, `SignedCopyCommand`, `assertCopyCommandBody(value: unknown): asserts value is CopyCommandBody`.
- Consumes: no proprietary workspace package.

- [ ] **Step 1: Add package scaffold and the failing command contract test**

Create `packages/copy-protocol/package.json`:

```json
{
  "name": "@xauusd/copy-protocol",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
```

Create `packages/copy-protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Create `packages/copy-protocol/src/command.test.ts` importing `./command.js` and asserting:

```ts
import { describe, expect, it } from "vitest";
import { COPY_COMMAND_ACTIONS, assertCopyCommandBody } from "./command.js";

const validBody = {
  version: 1,
  commandId: "cmd-0001",
  sequence: 1,
  licenseId: "lic-0001",
  installationId: "inst-0001",
  mt5Login: 12345678,
  brokerServer: "Broker-Live",
  symbol: "XAUUSD",
  action: "POSITION_OPEN",
  payload: { side: "BUY", volume: 0.03 },
  masterPositionRef: "master-pos-1",
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_789_000_030_000,
  keyId: "master-ed25519-2026-01"
} as const;

describe("copy command contract", () => {
  it("locks the exact V1 action allowlist", () => {
    expect(COPY_COMMAND_ACTIONS).toEqual([
      "POSITION_OPEN",
      "STOP_LOSS_UPDATE",
      "TAKE_PROFIT_UPDATE",
      "PARTIAL_CLOSE",
      "POSITION_CLOSE",
      "POSITION_SNAPSHOT"
    ]);
  });

  it("accepts a valid command body", () => {
    expect(() => assertCopyCommandBody(validBody)).not.toThrow();
  });

  it.each([
    [{ ...validBody, sequence: 0 }, "sequence"],
    [{ ...validBody, expiresAt: validBody.issuedAt }, "expiresAt"],
    [{ ...validBody, action: "RUN_STRATEGY" }, "action"],
    [{ ...validBody, payload: { bad: Number.NaN } }, "payload"]
  ])("rejects invalid security body %#", (body, field) => {
    expect(() => assertCopyCommandBody(body)).toThrow(field);
  });
});
```

- [ ] **Step 2: Install and run the test to prove RED**

Run:

```bash
pnpm install
pnpm --filter @xauusd/copy-protocol test -- command.test.ts
```

Expected: FAIL because `src/command.ts` does not exist.

- [ ] **Step 3: Implement the minimal command contract**

Create `src/command.ts` with these exact public shapes:

```ts
export const COPY_COMMAND_ACTIONS = [
  "POSITION_OPEN",
  "STOP_LOSS_UPDATE",
  "TAKE_PROFIT_UPDATE",
  "PARTIAL_CLOSE",
  "POSITION_CLOSE",
  "POSITION_SNAPSHOT"
] as const;

export type CopyCommandAction = (typeof COPY_COMMAND_ACTIONS)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export interface CopyCommandBody {
  readonly version: 1;
  readonly commandId: string;
  readonly sequence: number;
  readonly licenseId: string;
  readonly installationId: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly symbol: string;
  readonly action: CopyCommandAction;
  readonly payload: JsonObject;
  readonly masterPositionRef: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyId: string;
}

export interface SignedCopyCommand extends CopyCommandBody {
  readonly signature: string;
}
```

Implement `assertCopyCommandBody(value)` so it rejects non-object input, unknown `version`, blank identifiers/server/symbol/keyId, non-positive/non-safe `sequence` or `mt5Login`, non-safe timestamp integers, `expiresAt <= issuedAt`, non-allowlisted action, and any payload containing `undefined`, function, symbol, bigint, non-finite number, sparse array, or non-plain object.

- [ ] **Step 4: Export and prove GREEN**

Create `src/index.ts`:

```ts
export * from "./command.js";
```

Run:

```bash
pnpm --filter @xauusd/copy-protocol test -- command.test.ts
pnpm --filter @xauusd/copy-protocol typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/copy-protocol pnpm-lock.yaml
git commit -m "feat(copy-protocol): add signed command contract"
```

---

### Task 2: Add deterministic canonical command serialization

**Files:**
- Create: `packages/copy-protocol/src/canonical-json.test.ts`
- Create: `packages/copy-protocol/src/canonical-json.ts`
- Modify: `packages/copy-protocol/src/index.ts`

**Interfaces:**
- Consumes: `JsonValue`, `CopyCommandBody`, `assertCopyCommandBody`.
- Produces: `canonicalizeJson(value: JsonValue): string`, `canonicalizeCopyCommandBody(body: CopyCommandBody): string`, `copyCommandSigningBytes(body: CopyCommandBody): Uint8Array`.

- [ ] **Step 1: Write deterministic serialization RED tests**

Create tests that prove equal objects with different insertion order produce identical output and a locked golden command string:

```ts
expect(canonicalizeJson({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');
expect(canonicalizeJson({ a: 1, b: 2 })).toBe(canonicalizeJson({ b: 2, a: 1 }));
```

For the Task 1 `validBody`, assert the exact canonical output begins with keys in lexical order and contains every signed field, including `keyId`, while never containing `signature`.

Also assert arrays preserve element order and unsupported/non-finite runtime values throw instead of silently serializing.

- [ ] **Step 2: Run serializer test to prove RED**

Run:

```bash
pnpm --filter @xauusd/copy-protocol test -- canonical-json.test.ts
```

Expected: FAIL because `canonical-json.ts` does not exist.

- [ ] **Step 3: Implement canonical serialization**

Implement recursively with these rules:

```ts
export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON number must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key]!)}`).join(",")}}`;
}
```

`canonicalizeCopyCommandBody` must first call `assertCopyCommandBody(body)`. `copyCommandSigningBytes` returns UTF-8 bytes using `TextEncoder` over that exact canonical string.

- [ ] **Step 4: Export and prove GREEN**

Update `src/index.ts`:

```ts
export * from "./command.js";
export * from "./canonical-json.js";
```

Run:

```bash
pnpm --filter @xauusd/copy-protocol test -- canonical-json.test.ts
pnpm --filter @xauusd/copy-protocol typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/copy-protocol/src
git commit -m "feat(copy-protocol): add deterministic command serialization"
```

---

### Task 3: Add Ed25519 signing and verification

**Files:**
- Create: `packages/copy-protocol/src/ed25519.test.ts`
- Create: `packages/copy-protocol/src/ed25519.ts`
- Modify: `packages/copy-protocol/src/index.ts`

**Interfaces:**
- Consumes: `CopyCommandBody`, `SignedCopyCommand`, `copyCommandSigningBytes`.
- Produces: `signCopyCommand(body: CopyCommandBody, privateKeyPem: string): SignedCopyCommand`, `verifyCopyCommandSignature(command: SignedCopyCommand, trustedPublicKeys: ReadonlyMap<string, string>): CopyCommandSignatureVerification`.
- `CopyCommandSignatureVerification` is `{ ok: true } | { ok: false; code: "UNKNOWN_KEY_ID" | "MALFORMED_SIGNATURE" | "INVALID_SIGNATURE" }`.

- [ ] **Step 1: Write Ed25519 RED tests with ephemeral keys**

Generate test-only keys at runtime, never from fixtures:

```ts
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
```

Tests must prove:

```text
valid body + matching key => ok=true
modified payload after signing => INVALID_SIGNATURE
modified action after signing => INVALID_SIGNATURE
unknown keyId => UNKNOWN_KEY_ID
invalid base64url signature => MALFORMED_SIGNATURE
non-Ed25519 private/public keys => rejected
```

- [ ] **Step 2: Run signer test to prove RED**

Run:

```bash
pnpm --filter @xauusd/copy-protocol test -- ed25519.test.ts
```

Expected: FAIL because `ed25519.ts` does not exist.

- [ ] **Step 3: Implement minimal Ed25519 primitives**

Use only built-in `node:crypto`:

```ts
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const key = createPrivateKey(privateKeyPem);
if (key.asymmetricKeyType !== "ed25519") throw new TypeError("private key must be Ed25519");
const signature = sign(null, copyCommandSigningBytes(body), key).toString("base64url");
return { ...body, signature };
```

Verification must:

1. look up the PEM by the command's signed `keyId`;
2. reject unknown `keyId` before crypto verification;
3. ensure the public key is Ed25519;
4. decode base64url signature and require exactly 64 bytes;
5. reconstruct a `CopyCommandBody` by explicitly copying every signed field except `signature`;
6. call `verify(null, copyCommandSigningBytes(body), publicKey, signatureBytes)`;
7. return only the bounded result codes above and never log key material.

- [ ] **Step 4: Export and prove GREEN**

Update `src/index.ts` to export `./ed25519.js` and run:

```bash
pnpm --filter @xauusd/copy-protocol test
pnpm --filter @xauusd/copy-protocol typecheck
pnpm --filter @xauusd/copy-protocol build
```

Expected: all PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/copy-protocol/src
git commit -m "feat(copy-protocol): add Ed25519 command signing"
```

---

### Task 4: Lock the IP boundary and dedicated CI gate

**Files:**
- Create: `scripts/test-bot-ip-protection-p1-boundary.mjs`
- Create: `.github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml`

**Interfaces:**
- Consumes: package/source tree created by Tasks 1-3.
- Produces: a source contract and CI gate proving the protocol package stays strategy-independent and contains no committed private key material.

- [ ] **Step 1: Write the boundary contract first and prove RED on missing CI**

The Node test must recursively inspect `packages/copy-protocol` and assert:

```text
package name == @xauusd/copy-protocol
dependencies has zero @xauusd/* entries
source contains no import/reference to @xauusd/strategy-engine
source contains no import/reference to @xauusd/risk-engine
source contains no import/reference to @xauusd/execution-engine
source contains no import/reference to run-phase7b/run-phase7c controllers
source contains no literal "BEGIN PRIVATE KEY"
workflow file exists
workflow permissions are contents: read
workflow runs package test, typecheck, build, boundary contract, and git diff --check
```

Run before creating the workflow:

```bash
node --test scripts/test-bot-ip-protection-p1-boundary.mjs
```

Expected: FAIL specifically because `.github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml` is absent.

- [ ] **Step 2: Add dedicated CI workflow**

Create `.github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml` with:

```yaml
name: BOT IP Protection P1 Copy Protocol CI

on:
  pull_request:
    branches: [main]
    paths:
      - "packages/copy-protocol/**"
      - "scripts/test-bot-ip-protection-p1-boundary.mjs"
      - ".github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml"
      - "pnpm-lock.yaml"
  push:
    branches: [main]
    paths:
      - "packages/copy-protocol/**"
      - "scripts/test-bot-ip-protection-p1-boundary.mjs"
      - ".github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml"
      - "pnpm-lock.yaml"

permissions:
  contents: read

jobs:
  copy-protocol:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.18.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @xauusd/copy-protocol test
      - run: pnpm --filter @xauusd/copy-protocol typecheck
      - run: pnpm --filter @xauusd/copy-protocol build
      - run: node --test scripts/test-bot-ip-protection-p1-boundary.mjs
      - run: git diff --check
```

- [ ] **Step 3: Prove local GREEN**

Run:

```bash
node --test scripts/test-bot-ip-protection-p1-boundary.mjs
pnpm --filter @xauusd/copy-protocol test
pnpm --filter @xauusd/copy-protocol typecheck
pnpm --filter @xauusd/copy-protocol build
git diff --check
```

Expected: all PASS.

- [ ] **Step 4: Commit Task 4**

```bash
git add scripts/test-bot-ip-protection-p1-boundary.mjs .github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml
git commit -m "ci(copy-protocol): lock BOT IP Protection P1 boundary"
```

---

### Task 5: Exact-head review and PR gate

**Files:**
- No new implementation files unless review finds a defect.

**Interfaces:**
- Consumes: complete P1 branch.
- Produces: review evidence suitable for PR/merge; no production rollout.

- [ ] **Step 1: Run the complete P1 verification suite on the exact branch head**

```bash
pnpm install --frozen-lockfile
pnpm --filter @xauusd/copy-protocol test
pnpm --filter @xauusd/copy-protocol typecheck
pnpm --filter @xauusd/copy-protocol build
node --test scripts/test-bot-ip-protection-p1-boundary.mjs
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Review the final diff for security scope**

The diff must contain only:

```text
packages/copy-protocol/**
scripts/test-bot-ip-protection-p1-boundary.mjs
.github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml
pnpm-lock.yaml
```

Reject the PR if it changes Trend, Sideway, SEMI, AUTO, FastMove, M5, ARM, lifecycle, MT5 bridge, order, or position runtime code.

- [ ] **Step 3: Open PR and require exact-head CI success**

PR body must state:

```text
P1_SCOPE=PROTOCOL_CRYPTO_ONLY
PRODUCTION_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
PRIVATE_KEY_IN_REPO=NONE
STRATEGY_DEPENDENCY=NONE
```

Do not merge until the dedicated P1 CI and existing applicable repository gates are green on the exact PR head.

- [ ] **Step 4: Stop at the source merge boundary**

After merge, do not deploy or wire the protocol into production. P2 (license model/server validation) is a separate plan and a separate TDD cycle.
