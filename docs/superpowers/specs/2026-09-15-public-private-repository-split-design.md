# Public / Private Repository Split Design

> **PUBLIC-SAFE DESIGN DOCUMENT.** This document intentionally contains no proprietary trading thresholds, strategy formulas, scoring rules, or secret material.

## 1. Status and purpose

This design replaces the repository-topology assumption in the earlier BOT IP Protection V1 design. The current `xauusd-ai-master` repository is public by operator choice. Therefore repository visibility can no longer be used as a secrecy boundary for Master trading logic.

Design base:

- public repository: `thiennguyen3004931-sudo/xauusd-ai-master`
- base main commit: `c869d63c54dbc18eb9f7a05c1d2c8fd8ae4c6323`
- P1 copy protocol: already merged
- P2 generic license authorization: already merged
- P3 installation-identity/proof work: currently has overlapping open implementations and must be canonicalized before merge

The objective is to make a **private Master/Core repository the only canonical home for proprietary trading logic**, while the existing public repository becomes the public distribution/protocol/follower repository.

This migration is source/CI architecture work only. It must not change production trading behavior or mutate production runtime while the split is being built and verified.

## 2. Security premise

The existing repository has been public. Any code or credential that has ever been committed to its public history must be treated as potentially copied.

Consequences:

1. Deleting a file from public `main` does not make its historical contents secret again.
2. A history rewrite does not revoke clones, forks, caches, downloads, or screenshots already made.
3. The security value of this split is to prevent **future proprietary logic, future improvements, private signing material, and private operational data** from entering the public repository.
4. Historical credential exposure, if discovered, is remediated by credential rotation rather than by deletion alone.
5. No claim may be made that previously public strategy code has become secret merely because it is moved to a private repository.

## 3. Chosen target topology

### 3.1 Public repository

The existing `xauusd-ai-master` repository remains public and becomes the **Distribution / Protocol / Follower** repository.

It may contain only components that are safe to publish, including:

- copy protocol and canonical serialization;
- public cryptographic verification contracts and public keys;
- installation identity / proof-of-possession client-side primitives;
- public license contracts and generic authorization primitives that contain no administrative secrets or proprietary trading behavior;
- follower/client agent;
- generic transport and reconciliation contracts;
- generic MT5 execution adapter required by the follower, provided it contains no Master decision logic;
- public UI for follower/distribution functions;
- public-safe types, schemas, test fixtures, documentation, and CI.

The public repository must not contain a dependency that requires proprietary Master source to build or test the public distribution artifact.

### 3.2 Private Master/Core repository

A new repository, proposed canonical name `xauusd-ai-master-core`, is created **private from its first commit** and becomes the canonical development repository for proprietary Master behavior.

It owns:

- strategy selection and strategy implementation;
- proprietary signal/decision logic;
- proprietary trade-management logic;
- Master-specific risk decisions;
- proprietary analytics and Performance Intelligence;
- Master orchestration/controllers;
- Master Copy Event generation before sanitization;
- private command-signing service implementation and secret-store integration;
- license administration, private persistence, customer administration, and server-side secret-store integration;
- private deployment/recovery scripts and runtime-source attestation that expose Master internals;
- any internal documentation or test vectors that reveal proprietary behavior.

**No private signing key, device private key, API credential, customer secret, or other long-lived secret is committed to the private repository.** Private key material is injected at runtime/CI from an access-controlled secret store and remains outside Git history.

The private repository may consume public protocol artifacts. The public repository must never consume the private repository or private source packages.

### 3.3 Dependency direction

The allowed dependency direction is one-way:

```text
PUBLIC protocol/contracts
        ↓
PRIVATE Master/Core
        ↓
Sanitized signed lifecycle commands
        ↓
PUBLIC follower/distribution
```

Forbidden:

```text
PUBLIC repo -> PRIVATE source package
PUBLIC build -> PRIVATE repository checkout
PUBLIC CI -> PRIVATE signing secret
Follower artifact -> Master strategy module
```

No cross-repository dependency cycle is permitted.

## 4. Classification model

Migration classification is performed at **file/module responsibility level**, not by package name alone.

Every tracked source file is assigned exactly one state:

- `SAFE_PUBLIC` — safe to remain in the public distribution repository;
- `PRIVATE_REQUIRED` — must move to private Master/Core before the public head is considered distribution-safe;
- `REVIEW_REQUIRED` — mixed/uncertain responsibility; cannot ship to customers until resolved.

### 4.1 Initial `SAFE_PUBLIC` candidates

The current `copy-protocol` package is the clearest public-safe candidate because it defines generic signed execution-command contracts rather than strategy decisions.

P3 installation identity/proof primitives are public-safe only when they contain public cryptographic protocol/client behavior and no private keys, private enrollment database, administrative secrets, or Master logic.

The current P2 license package may remain public only to the extent it is a generic contract/authorization library. Private customer administration, persistence, secret retrieval, and privileged operational controls belong in Master/Core.

### 4.2 Initial `PRIVATE_REQUIRED` candidates

At minimum, the proprietary implementation portions of the following responsibilities are private-required:

- strategy engine and strategy implementations;
- Master entry/exit/management controllers;
- Master decision pipeline and proprietary scoring/rules;
- proprietary risk decision logic;
- Performance Intelligence and internal effectiveness calculations;
- Master-only Copy Event generation;
- private signing service and secret-store bindings;
- private license administration and data;
- Master deployment/runtime tooling that exposes proprietary internals.

### 4.3 `REVIEW_REQUIRED` areas

Current packages and areas whose names alone are insufficient to classify include AI/analysis/backtest, execution, indicators, market-data, MT5 broker, risk, signal, shared/types, API/Web applications, scripts, operational documentation, and CI.

These areas must be inspected for actual responsibility and dependency direction. A package may be split when it mixes public execution contracts with private decision logic.

## 5. Current P1 / P2 / P3 treatment

### P1

`copy-protocol` remains public-safe subject to continued boundary tests. Private signing keys are not part of this package.

### P2

Generic license model and action-sensitive authorization contracts may remain public. Any future license administration service, credential store, customer database, privileged operator endpoint, or secret material is private-only.

### P3

The current public repository has overlapping P3 work:

- one documentation-only plan;
- an `installation-proof` implementation path;
- an `installation-identity` implementation path.

The migration must not merge both implementation paths as parallel canonical systems. Before continuing P3, one public-safe canonical package/contract is selected and the competing implementation is closed or superseded. Production private-key storage remains blocked until an OS-protected implementation exists and is separately accepted.

## 6. Migration sequence

### M0 — Freeze the secrecy boundary

Until the split is complete:

- no new proprietary strategy behavior is added to the public repository;
- no private signing key or long-lived secret is committed or placed in public CI;
- public security work is limited to protocol/client/follower-safe components;
- proprietary trading fixes are developed only after a private canonical workspace exists.

This is a source governance boundary, not a production runtime mutation.

### M1 — Inventory and exposure audit

Create a machine-readable inventory of tracked files and dependencies and classify them as `SAFE_PUBLIC`, `PRIVATE_REQUIRED`, or `REVIEW_REQUIRED`.

Run secret scanning against both current tree and reachable Git history. For every credible secret finding:

- identify the owning system;
- rotate/revoke the credential;
- document remediation without printing the secret value.

The scan must also detect public source references to private-only package paths and proprietary modules.

### M2 — Bootstrap private Master/Core

Create the private repository with access restricted to authorized maintainers.

Seed it from a verified source checkpoint so production provenance is retained. The migration record captures:

- source public commit;
- source tree hash;
- private bootstrap commit/tree;
- mapping or import method;
- timestamp and operator.

No production deployment points to the private repository at this stage.

### M3 — Establish private CI and equivalence

Before removing anything from the public head, the private repository must prove that the Master system builds and its canonical test suites pass from the private tree.

Required evidence includes:

- dependency install/build/test;
- Master strategy/regression suites;
- runtime-source/deployment attestation where applicable;
- no missing source caused by the split;
- no dependency from private build back to proprietary files left only in the public repository.

The private source checkpoint must be demonstrably equivalent to the accepted source checkpoint before production cutover is considered.

### M4 — Sanitize the public head

Remove `PRIVATE_REQUIRED` source from the public repository's current head and split mixed packages where needed.

This step is **not** represented as historical erasure. Its purpose is to ensure new clones of current public `main` obtain only the public distribution surface by default and that future development cannot accidentally continue against public Master internals.

Public workspace/build/test configuration is updated so public artifacts build without private source.

### M5 — Lock the cross-repository interface

Private Master/Core consumes a pinned version of public protocol/contracts through an explicit release/tag/commit or package artifact.

The interface boundary contains execution facts only. It must not transmit proprietary rule names, internal strategy state, scoring details, or private analytics.

Public follower code verifies signed commands and applies public follower protections; it does not recompute Master strategy decisions.

### M6 — Release and secret separation

Private CI is the only CI allowed to request access to:

- signing private keys;
- private deployment credentials;
- private customer/license administration secrets;
- Master operational secrets.

Those secrets remain in an access-controlled secret store (for example an OS/CI secret facility) and are injected only into authorized jobs/runtime. **They are not tracked files in the private repository.**

Public CI owns no private signing material and can build/test public components without access to the private repository.

Release automation must verify that distributed artifacts contain no private source, private source maps, private keys, or forbidden private dependencies.

### M7 — Security and behavior acceptance

Before any production cutover, automated acceptance must prove at least:

1. public build succeeds with zero private repository access;
2. public dependency graph contains no private package/source dependency;
3. follower artifact contains no proprietary strategy modules;
4. private Master build succeeds independently;
5. public/private protocol vectors are compatible;
6. private signing key is absent from public repository, private repository Git history, public CI, and follower artifact;
7. secret scan has been run over public current tree and reachable history and credible findings have been rotated;
8. sanitized command payload/log tests contain no proprietary internals;
9. repository split does not modify canonical trading behavior;
10. accepted Master regression/equivalence suites pass on the private source checkpoint;
11. public P3 has one canonical implementation, not two competing identity/proof systems;
12. production remains untouched until a separate rollout decision is approved.

### M8 — Production cutover as a separate decision

Source migration completion does not authorize production migration.

Production cutover requires a separate exact-head plan and approval. It must prove:

- private runtime source equals the accepted private commit/tree;
- deployment/recovery scripts reference the private canonical source;
- public follower/distribution release references only public-safe artifacts;
- rollback is defined;
- no test order is required merely to prove repository security.

## 7. Public-history handling

V1 does not perform destructive public history rewriting.

Reasoning:

- rewriting Git history cannot revoke copies already made;
- a large destructive rewrite would complicate provenance and recovery while providing no guarantee of secrecy;
- the immediate security priority is to stop future proprietary development in public and rotate any exposed credentials.

After the private canonical system is stable, a separate optional decision may create a clean-history public distribution repository or replace/archive the current public repository. That decision is independent of the private-core security boundary and must not be used to claim prior public exposure was undone.

## 8. CI governance after the split

### Public repository CI

Public CI must include negative security contracts that fail if:

- forbidden private module/path imports are introduced;
- private repository checkout is attempted;
- private signing key material appears;
- known secret patterns or private credential files are tracked;
- a follower/distribution artifact includes a private-only module;
- package boundaries become cyclic across public/private responsibilities.

### Private repository CI

Private CI additionally proves:

- Master regression behavior;
- private-to-public protocol compatibility;
- sanitized Copy Event output;
- signing service correctness;
- runtime-source attestation;
- no accidental publication of private artifacts.

## 9. Operational guardrails

During M0–M7:

```text
PRODUCTION_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
TASK_MUTATION=NONE
PROCESS_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```

Repository migration may create branches, repositories, CI, tests, and documentation. It may not alter the running bot or create live trades without a later explicit rollout approval.

## 10. Completion definition

The Public/Private split is source-complete only when all of the following are true:

- private Master/Core exists and is the canonical source for proprietary behavior;
- private exact-head build/regression evidence is green;
- current public `main` builds without private source access;
- every tracked public file is classified and no `PRIVATE_REQUIRED` file remains in the public current tree;
- secret-history audit is complete and any discovered credential is rotated;
- no private key/credential is tracked in either public or private Git history;
- public/private dependency direction is one-way and enforced by CI;
- one canonical P3 identity/proof implementation is selected;
- follower/distribution artifacts contain only public-safe responsibilities;
- production has not been cut over implicitly.

Only after those conditions are met may a separate production rollout plan be proposed.
