# BOT IP Protection P2 — License Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a strategy-independent server-side license model and action-sensitive authorization service that blocks unauthorized new exposure while still permitting the explicitly approved risk-reducing/reconciliation actions for existing matched positions.

**Architecture:** Add a new private workspace package, `@xauusd/license-service`, that depends only on `@xauusd/copy-protocol` for the bounded V1 action type. P2 is pure source logic with no persistence, device-key proof, replay state, networking, MT5 execution, or production runtime wiring; those remain P3/P4/P6/P9 responsibilities.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 10.18.0, tsup, Vitest, `@xauusd/copy-protocol` workspace dependency.

**Spec:** `docs/superpowers/specs/2026-09-14-bot-ip-protection-license-v1-design.md`

## Global Constraints

- `xauusd-ai-master` remains the private canonical Master/Core repository.
- P2 must not import or bundle strategy-engine, risk-engine, execution-engine, Trend/Sideway controllers, FastMove, M5, Performance Intelligence, MT5 bridge, or Phase7C lifecycle controls.
- Canonical license statuses are exactly `ACTIVE`, `SUSPENDED`, `EXPIRED`, `REVOKED`.
- Canonical V1 license fields are `licenseId`, `status`, `customerId`, `allowedMt5Logins[]`, `allowedBrokerServers[]`, `installationId`, `installationPublicKey`, `plan`, `maxAccounts`, `issuedAt`, `expiresAt`, `revokedAt`.
- No wildcard MT5 account or broker authorization is allowed.
- `ACTIVE` may authorize all V1 copy actions after license/installation/account/broker/time checks.
- `SUSPENDED`, `EXPIRED`, and `REVOKED` block `POSITION_OPEN` immediately.
- A non-active license may authorize only `STOP_LOSS_UPDATE` proven non-loosening, `PARTIAL_CLOSE`, `POSITION_CLOSE`, and `POSITION_SNAPSHOT`, and only for an existing matched follower position.
- `TAKE_PROFIT_UPDATE` is blocked while the license is non-active.
- An `ACTIVE` record whose `expiresAt <= now` is treated as effectively `EXPIRED` for authorization.
- P2 does not prove possession of `installationPublicKey`; P3 implements device-key enrollment/proof.
- P2 does not persist or compare command `sequence`/`commandId`; P4 implements replay/idempotency.
- P2 does not validate command signatures; P1 already provides crypto primitives and later integration composes them.
- P2 has no production runtime integration and no broker/network side effects.
- `PRODUCTION_MUTATION=NONE`, `BOT_RUNTIME_MUTATION=NONE`, `MT5_MUTATION=NONE`, `MODE_MUTATION=NONE`, `ARM_MUTATION=NONE`, `TASK_MUTATION=NONE`, `PROCESS_MUTATION=NONE`, `ORDER_MUTATION=NONE`, `POSITION_MUTATION=NONE`, `LIVE_TEST_ORDER=NONE`.

## File Structure

```text
packages/license-service/
  package.json
  tsconfig.json
  src/
    license.ts                    canonical license record + runtime assertion
    authorization.ts              action-sensitive license authorization
    license.test.ts               license model validation tests
    authorization.test.ts         identity/time/action matrix tests
    index.ts                      public exports only
scripts/
  test-bot-ip-protection-p2-boundary.mjs
.github/workflows/
  bot-ip-protection-p2-license-service-ci.yml
pnpm-lock.yaml
```

`@xauusd/license-service` may depend on `@xauusd/copy-protocol` only. It must remain free of strategy/runtime execution dependencies so the authorization boundary can later be placed before command signing without importing proprietary strategy internals into any follower-facing package.

---

### Task 1: Create the canonical license model

**Files:**
- Create: `packages/license-service/package.json`
- Create: `packages/license-service/tsconfig.json`
- Create: `packages/license-service/src/license.test.ts`
- Create: `packages/license-service/src/license.ts`
- Create: `packages/license-service/src/index.ts`
- Modify: `pnpm-lock.yaml` via `pnpm install`

**Interfaces:**
- Produces: `LICENSE_STATUSES`, `LicenseStatus`, `LicenseRecord`, `assertLicenseRecord(value: unknown): asserts value is LicenseRecord`, `effectiveLicenseStatus(license: LicenseRecord, now: number): LicenseStatus`.
- Consumes: no proprietary workspace package.

- [ ] **Step 1: Add package scaffold and failing license-model tests**

Create `packages/license-service/package.json`:

```json
{
  "name": "@xauusd/license-service",
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
  "dependencies": {
    "@xauusd/copy-protocol": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
```

Create `packages/license-service/tsconfig.json` with the same repo package compiler contract used by `copy-protocol`:

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

Create `src/license.test.ts` with a canonical valid record and tests that lock the exact status list and reject malformed records:

```ts
import { describe, expect, it } from "vitest";
import {
  LICENSE_STATUSES,
  assertLicenseRecord,
  effectiveLicenseStatus
} from "./license.js";

const validLicense = {
  licenseId: "lic-0001",
  status: "ACTIVE",
  customerId: "cust-0001",
  allowedMt5Logins: [12345678],
  allowedBrokerServers: ["Broker-Live"],
  installationId: "inst-0001",
  installationPublicKey: "device-public-key-placeholder",
  plan: "STANDARD",
  maxAccounts: 1,
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_791_592_000_000,
  revokedAt: null
} as const;

describe("license model", () => {
  it("locks exact V1 statuses", () => {
    expect(LICENSE_STATUSES).toEqual([
      "ACTIVE",
      "SUSPENDED",
      "EXPIRED",
      "REVOKED"
    ]);
  });

  it("accepts a canonical active license", () => {
    expect(() => assertLicenseRecord(validLicense)).not.toThrow();
  });

  it.each([
    [{ ...validLicense, allowedMt5Logins: [] }, "allowedMt5Logins"],
    [{ ...validLicense, allowedMt5Logins: [12345678, 12345678] }, "duplicate"],
    [{ ...validLicense, allowedBrokerServers: ["*"] }, "wildcard"],
    [{ ...validLicense, allowedBrokerServers: ["Broker-Live", "Broker-Live"] }, "duplicate"],
    [{ ...validLicense, maxAccounts: 0 }, "maxAccounts"],
    [{ ...validLicense, allowedMt5Logins: [1, 2], maxAccounts: 1 }, "maxAccounts"],
    [{ ...validLicense, expiresAt: validLicense.issuedAt }, "expiresAt"],
    [{ ...validLicense, status: "REVOKED", revokedAt: null }, "revokedAt"]
  ])("rejects invalid license record %#", (license, field) => {
    expect(() => assertLicenseRecord(license)).toThrow(field);
  });

  it("treats an elapsed ACTIVE license as effectively EXPIRED", () => {
    expect(effectiveLicenseStatus(validLicense, validLicense.expiresAt)).toBe(
      "EXPIRED"
    );
  });
});
```

- [ ] **Step 2: Install and run the license test to prove RED**

Run:

```bash
pnpm install
pnpm --filter @xauusd/license-service test -- license.test.ts
```

Expected: FAIL because `src/license.ts` does not exist.

- [ ] **Step 3: Implement the minimal strict license model**

Create `src/license.ts` with these public types:

```ts
export const LICENSE_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "REVOKED"
] as const;

export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export interface LicenseRecord {
  readonly licenseId: string;
  readonly status: LicenseStatus;
  readonly customerId: string;
  readonly allowedMt5Logins: readonly number[];
  readonly allowedBrokerServers: readonly string[];
  readonly installationId: string;
  readonly installationPublicKey: string;
  readonly plan: string;
  readonly maxAccounts: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}
```

`assertLicenseRecord` must fail closed and reject:

```text
unknown/missing fields
blank or surrounding-whitespace identifiers
unknown status
empty account/server allowlists
non-positive/non-safe MT5 logins
wildcard broker entries (`*`)
duplicate MT5 logins or broker servers
non-positive/non-safe maxAccounts
allowedMt5Logins.length > maxAccounts
non-safe issuedAt/expiresAt/revokedAt
expiresAt <= issuedAt
REVOKED with revokedAt=null
non-REVOKED with revokedAt!=null
revokedAt < issuedAt
```

Implement effective expiration exactly:

```ts
export function effectiveLicenseStatus(
  license: LicenseRecord,
  now: number
): LicenseStatus {
  if (!Number.isSafeInteger(now)) {
    throw new TypeError("now must be a safe integer");
  }
  if (license.status === "ACTIVE" && now >= license.expiresAt) {
    return "EXPIRED";
  }
  return license.status;
}
```

- [ ] **Step 4: Export and prove GREEN**

Create `src/index.ts`:

```ts
export * from "./license.js";
```

Run:

```bash
pnpm --filter @xauusd/license-service test -- license.test.ts
pnpm --filter @xauusd/license-service typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/license-service pnpm-lock.yaml
git commit -m "feat(license-service): add canonical license model"
```

---

### Task 2: Add active-license identity and time authorization

**Files:**
- Create: `packages/license-service/src/authorization.test.ts`
- Create: `packages/license-service/src/authorization.ts`
- Modify: `packages/license-service/src/index.ts`

**Interfaces:**
- Consumes: `CopyCommandAction` from `@xauusd/copy-protocol`; `LicenseRecord`, `LicenseStatus`, `assertLicenseRecord`, `effectiveLicenseStatus` from Task 1.
- Produces: `LicenseActionRequest`, `ExistingPositionContext`, `LicenseAuthorizationCode`, `LicenseAuthorizationDecision`, `authorizeLicenseAction(license, request)`.

Define the public request/context shapes exactly:

```ts
export type PositionSide = "BUY" | "SELL";

export interface ExistingPositionContext {
  readonly masterPositionRef: string;
  readonly side: PositionSide;
  readonly currentStopLoss: number | null;
  readonly requestedStopLoss?: number;
}

export interface LicenseActionRequest {
  readonly installationId: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly action: CopyCommandAction;
  readonly masterPositionRef: string;
  readonly now: number;
  readonly existingPosition?: ExistingPositionContext;
}
```

Use this bounded result contract:

```ts
export type LicenseAuthorizationCode =
  | "AUTHORIZED"
  | "INVALID_LICENSE_RECORD"
  | "INVALID_REQUEST"
  | "LICENSE_NOT_YET_VALID"
  | "INSTALLATION_MISMATCH"
  | "MT5_LOGIN_NOT_ALLOWED"
  | "BROKER_SERVER_NOT_ALLOWED"
  | "LICENSE_NOT_ACTIVE"
  | "ACTION_NOT_ALLOWED_FOR_LICENSE_STATE"
  | "EXISTING_POSITION_REQUIRED"
  | "POSITION_MISMATCH"
  | "STOP_LOSS_CONTEXT_REQUIRED"
  | "STOP_LOSS_NOT_RISK_REDUCING";

export type LicenseAuthorizationDecision =
  | {
      readonly ok: true;
      readonly code: "AUTHORIZED";
      readonly effectiveStatus: LicenseStatus;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<LicenseAuthorizationCode, "AUTHORIZED">;
      readonly effectiveStatus?: LicenseStatus;
    };
```

- [ ] **Step 1: Write RED tests for strict request validation and ACTIVE authorization**

Add tests using an ACTIVE license that prove:

```text
matching installation/account/broker + valid time + POSITION_OPEN => AUTHORIZED
wrong installationId => INSTALLATION_MISMATCH
MT5 login not in allowlist => MT5_LOGIN_NOT_ALLOWED
broker server not in allowlist => BROKER_SERVER_NOT_ALLOWED
now < issuedAt => LICENSE_NOT_YET_VALID
now >= expiresAt with stored ACTIVE => effective EXPIRED behavior, never new entry
unknown runtime action cast into request => INVALID_REQUEST
blank masterPositionRef => INVALID_REQUEST
```

Example core expectation:

```ts
expect(
  authorizeLicenseAction(validLicense, {
    installationId: "inst-0001",
    mt5Login: 12345678,
    brokerServer: "Broker-Live",
    action: "POSITION_OPEN",
    masterPositionRef: "master-pos-1",
    now: 1_789_000_010_000
  })
).toEqual({
  ok: true,
  code: "AUTHORIZED",
  effectiveStatus: "ACTIVE"
});
```

- [ ] **Step 2: Run authorization test to prove RED**

Run:

```bash
pnpm --filter @xauusd/license-service test -- authorization.test.ts
```

Expected: FAIL because `authorization.ts` does not exist.

- [ ] **Step 3: Implement fail-closed request validation and ACTIVE path**

Implement `authorizeLicenseAction` with this deterministic gate order:

```text
1. validate LicenseRecord -> INVALID_LICENSE_RECORD
2. validate request/action/time/context shape -> INVALID_REQUEST
3. now < issuedAt -> LICENSE_NOT_YET_VALID
4. installationId exact mismatch -> INSTALLATION_MISMATCH
5. MT5 login not explicitly allowlisted -> MT5_LOGIN_NOT_ALLOWED
6. broker server not explicitly allowlisted -> BROKER_SERVER_NOT_ALLOWED
7. compute effectiveLicenseStatus
8. if effective status ACTIVE -> AUTHORIZED
9. otherwise enter Task 3 non-active matrix
```

The function must return bounded decisions and must not throw for untrusted runtime request/license input.

- [ ] **Step 4: Export and prove GREEN for ACTIVE path**

Update `src/index.ts`:

```ts
export * from "./license.js";
export * from "./authorization.js";
```

Run:

```bash
pnpm --filter @xauusd/license-service test -- authorization.test.ts
pnpm --filter @xauusd/license-service typecheck
```

Expected: ACTIVE/identity/time tests PASS; Task 3 non-active tests do not exist yet.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/license-service/src
git commit -m "feat(license-service): authorize active license identity"
```

---

### Task 3: Lock the non-active action matrix and non-loosening SL proof

**Files:**
- Modify: `packages/license-service/src/authorization.test.ts`
- Modify: `packages/license-service/src/authorization.ts`

**Interfaces:**
- Consumes: Task 2 `LicenseActionRequest` and `ExistingPositionContext`.
- Produces: complete non-active authorization behavior required by spec section 4.8/6.2.

- [ ] **Step 1: Add RED matrix tests for SUSPENDED / EXPIRED / REVOKED**

For every non-active effective status, prove:

```text
POSITION_OPEN => LICENSE_NOT_ACTIVE
TAKE_PROFIT_UPDATE => ACTION_NOT_ALLOWED_FOR_LICENSE_STATE
PARTIAL_CLOSE without existingPosition => EXISTING_POSITION_REQUIRED
POSITION_CLOSE without existingPosition => EXISTING_POSITION_REQUIRED
POSITION_SNAPSHOT without existingPosition => EXISTING_POSITION_REQUIRED
existingPosition.masterPositionRef != request.masterPositionRef => POSITION_MISMATCH
matched PARTIAL_CLOSE => AUTHORIZED
matched POSITION_CLOSE => AUTHORIZED
matched POSITION_SNAPSHOT => AUTHORIZED
```

Also prove stored `ACTIVE` with `now >= expiresAt` follows the exact same `EXPIRED` matrix.

- [ ] **Step 2: Add RED BUY/SELL STOP_LOSS_UPDATE tests**

Lock non-loosening semantics independently of strategy logic:

```text
BUY current SL 4386 -> requested 4388 => AUTHORIZED
BUY current SL 4386 -> requested 4386 => AUTHORIZED
BUY current SL 4386 -> requested 4385 => STOP_LOSS_NOT_RISK_REDUCING
SELL current SL 4400 -> requested 4398 => AUTHORIZED
SELL current SL 4400 -> requested 4400 => AUTHORIZED
SELL current SL 4400 -> requested 4401 => STOP_LOSS_NOT_RISK_REDUCING
currentStopLoss=null + finite positive requested SL => AUTHORIZED
missing requestedStopLoss => STOP_LOSS_CONTEXT_REQUIRED
NaN/Infinity/non-positive stop values => INVALID_REQUEST
```

No market-price or broker-stop-distance rule belongs here; broker legality is a later follower/execution concern.

- [ ] **Step 3: Run tests to prove RED**

Run:

```bash
pnpm --filter @xauusd/license-service test -- authorization.test.ts
```

Expected: FAIL specifically on non-active matrix / SL risk-reduction cases while Task 2 ACTIVE tests remain green.

- [ ] **Step 4: Implement the exact non-active matrix**

After the identity/time gates from Task 2:

```ts
if (request.action === "POSITION_OPEN") {
  return { ok: false, code: "LICENSE_NOT_ACTIVE", effectiveStatus };
}

if (request.action === "TAKE_PROFIT_UPDATE") {
  return {
    ok: false,
    code: "ACTION_NOT_ALLOWED_FOR_LICENSE_STATE",
    effectiveStatus
  };
}
```

For `STOP_LOSS_UPDATE`, `PARTIAL_CLOSE`, `POSITION_CLOSE`, and `POSITION_SNAPSHOT`, require a matched `existingPosition`. Then use this pure SL rule:

```ts
function isNonLooseningStopUpdate(position: ExistingPositionContext): boolean {
  const next = position.requestedStopLoss;
  if (next === undefined || !Number.isFinite(next) || next <= 0) return false;
  if (position.currentStopLoss === null) return true;
  if (!Number.isFinite(position.currentStopLoss) || position.currentStopLoss <= 0) {
    return false;
  }
  return position.side === "BUY"
    ? next >= position.currentStopLoss
    : next <= position.currentStopLoss;
}
```

A missing `requestedStopLoss` returns `STOP_LOSS_CONTEXT_REQUIRED`; a syntactically valid but loosening stop returns `STOP_LOSS_NOT_RISK_REDUCING`.

- [ ] **Step 5: Prove GREEN for the complete P2 authorization service**

Run:

```bash
pnpm --filter @xauusd/license-service test
pnpm --filter @xauusd/license-service typecheck
pnpm --filter @xauusd/license-service build
```

Expected: all license + authorization tests PASS, typecheck PASS, build PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/license-service/src
git commit -m "feat(license-service): enforce non-active action matrix"
```

---

### Task 4: Add P2 IP boundary and dedicated CI

**Files:**
- Create: `scripts/test-bot-ip-protection-p2-boundary.mjs`
- Create: `.github/workflows/bot-ip-protection-p2-license-service-ci.yml`

**Interfaces:**
- Consumes: package structure from Tasks 1–3.
- Produces: automated proof that P2 stays source-only, strategy-independent, and fully tested.

- [ ] **Step 1: Write the boundary test RED**

Create `scripts/test-bot-ip-protection-p2-boundary.mjs` using `node:test` and assert:

```text
package name is @xauusd/license-service
runtime @xauusd dependencies are exactly [@xauusd/copy-protocol]
source contains no strategy/risk/execution/Phase7C controller imports
source contains no private-key marker
source contains no persistence/network/MT5 mutation code paths
P2 workflow exists and contains frozen install, test, typecheck, build, boundary, diff hygiene
```

Use exact forbidden dependency/marker checks including:

```js
const forbidden = [
  "@xauusd/strategy-engine",
  "@xauusd/risk-engine",
  "@xauusd/execution-engine",
  "@xauusd/mt5-broker",
  "run-phase7b",
  "run-phase7c",
  "BEGIN PRIVATE KEY"
];
```

- [ ] **Step 2: Run boundary test to prove RED**

Run:

```bash
node --test scripts/test-bot-ip-protection-p2-boundary.mjs
```

Expected: FAIL because the dedicated P2 workflow does not exist yet.

- [ ] **Step 3: Add dedicated P2 CI**

Create `.github/workflows/bot-ip-protection-p2-license-service-ci.yml`:

```yaml
name: BOT IP Protection P2 License Service CI

on:
  pull_request:
    branches: [main]
    paths:
      - "packages/license-service/**"
      - "packages/copy-protocol/**"
      - "scripts/test-bot-ip-protection-p2-boundary.mjs"
      - ".github/workflows/bot-ip-protection-p2-license-service-ci.yml"
      - "pnpm-lock.yaml"
  push:
    branches: [main]
    paths:
      - "packages/license-service/**"
      - "packages/copy-protocol/**"
      - "scripts/test-bot-ip-protection-p2-boundary.mjs"
      - ".github/workflows/bot-ip-protection-p2-license-service-ci.yml"
      - "pnpm-lock.yaml"

permissions:
  contents: read

jobs:
  license-service:
    name: license-service-contract
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.18.0
          run_install: false
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Install workspace dependencies
        run: pnpm install --frozen-lockfile
      - name: License service tests
        run: pnpm --filter @xauusd/license-service test
      - name: License service typecheck
        run: pnpm --filter @xauusd/license-service typecheck
      - name: License service build
        run: pnpm --filter @xauusd/license-service build
      - name: P2 IP boundary contract
        run: node --test scripts/test-bot-ip-protection-p2-boundary.mjs
      - name: Diff hygiene
        run: git diff --check
```

- [ ] **Step 4: Prove boundary GREEN**

Run:

```bash
node --test scripts/test-bot-ip-protection-p2-boundary.mjs
pnpm --filter @xauusd/license-service test
pnpm --filter @xauusd/license-service typecheck
pnpm --filter @xauusd/license-service build
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add scripts/test-bot-ip-protection-p2-boundary.mjs .github/workflows/bot-ip-protection-p2-license-service-ci.yml
git commit -m "ci(license-service): add P2 security boundary gate"
```

---

### Task 5: Exact-head acceptance and merge gate

**Files:** no new source files unless verification exposes a defect.

**Interfaces:** produces the merge evidence for P2; consumes Tasks 1–4.

- [ ] **Step 1: Run the complete local/source acceptance set**

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @xauusd/copy-protocol test
pnpm --filter @xauusd/copy-protocol typecheck
pnpm --filter @xauusd/copy-protocol build
pnpm --filter @xauusd/license-service test
pnpm --filter @xauusd/license-service typecheck
pnpm --filter @xauusd/license-service build
node --test scripts/test-bot-ip-protection-p1-boundary.mjs
node --test scripts/test-bot-ip-protection-p2-boundary.mjs
git diff --check
```

Expected: zero failures.

- [ ] **Step 2: Review the PR diff against the spec**

Verify every changed source file belongs to P2 and that the diff contains none of:

```text
production deployment/recovery mutation
MT5 order or position mutation
mode/ARM mutation
strategy thresholds/rules/reasons
private signing keys
device private keys
network listener/server rollout
replay/idempotency persistence
follower sizing/execution
```

- [ ] **Step 3: Require exact-head CI**

Before merge, require success on the same head SHA for:

```text
BOT IP Protection P2 License Service CI
BOT IP Protection P1 Copy Protocol CI when triggered
Phase7C Canonical PR Gate
Phase7C Web LIVE Arm + DEMO Auto CI
Phase7C LIVE Arm Orphan Reconciliation CI
```

Do not infer success from a previous head.

- [ ] **Step 4: Merge source only after all gates are green**

Merge through a PR with the expected head SHA guard. After merge, verify `main` points to the merge commit and confirm any P2 push CI/canonical push gate triggered by the merge succeeds.

No production rollout follows automatically.

## Self-Review

- Spec coverage: P2 covers the canonical license model, explicit account/broker/install binding, effective expiration, ACTIVE authorization, non-active new-entry block, non-active risk-reducing/reconciliation allowlist, and no-strategy dependency. Device proof-of-possession remains P3; replay/idempotency remains P4; copy-event sanitization/signing integration remains P5; follower execution/risk remains P6; reconnect/reconciliation orchestration remains P7.
- Placeholder scan: no TBD/TODO/"implement later" placeholders are used as implementation instructions.
- Type consistency: `LicenseRecord`, `LicenseStatus`, `LicenseActionRequest`, `ExistingPositionContext`, `LicenseAuthorizationDecision`, and result codes are defined once and reused consistently across tasks.
- Safety: all work is source/CI only; no Phase7C, MT5, mode, ARM, order, position, process, or task mutation is required.
