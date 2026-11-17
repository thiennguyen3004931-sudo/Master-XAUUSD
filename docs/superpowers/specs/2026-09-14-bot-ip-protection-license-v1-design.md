# BOT IP PROTECTION & LICENSE V1 — Design

Date: 2026-09-14
Status: DESIGN REVIEW
Repository: `thiennguyen3004931-sudo/xauusd-ai-master`

## 1. Objective

Protect XAUUSD AI MASTER intellectual property so customer/follower installations cannot obtain or reuse the proprietary Trend, Sideway, AUTO/SEMI management, FastMove, M5 structure, risk, decision, or Performance Intelligence logic.

The primary control is architectural: proprietary strategy logic never runs on the customer machine. Client hardening is defense-in-depth only.

## 2. Non-goals

V1 does not change trading behavior, strategy thresholds, entry/exit rules, lot sizing, SL/TP semantics, FastMove/M5 behavior, mode semantics, ARM semantics, or production lifecycle behavior.

V1 does not attempt to make a distributed binary impossible to reverse engineer. Instead, the distributed binary must not contain the proprietary strategy logic that needs protection.

V1 does not rewrite Git history or attempt to revoke copies that may have been cloned while the repository was public.

## 3. Current protection boundary

`xauusd-ai-master` is the canonical private Master/Core repository.

The following remain private and server-side:

- strategy-engine classifiers, rules, pipeline, services, and strategies;
- Trend and Sideway controllers;
- entry/exit decision logic;
- +6 / +10 management logic;
- FastMove and M5 structural management logic;
- AUTO recommendation/effective-strategy logic;
- SEMI adoption and Trend-management internals;
- risk/lot decision logic;
- Performance Intelligence and proprietary effectiveness logic;
- Master Copy Trading event generation;
- command signing private keys;
- license administration data.

No customer/follower package may import or bundle these modules.

## 4. Chosen architecture

### 4.1 Master/Core

The existing private repository remains canonical for strategy and production execution. This preserves current Git provenance, CI, runtime-source attestation, deployment/recovery tooling, and Phase7C safety contracts.

A new copy-distribution boundary is added after a Master trade lifecycle event has already been decided. The copy layer consumes normalized lifecycle facts, never strategy internals.

### 4.2 Copy Event Sanitizer

The sanitizer converts an already-approved Master lifecycle event into a minimal follower command.

Allowed command actions in V1:

- `POSITION_OPEN`
- `STOP_LOSS_UPDATE`
- `TAKE_PROFIT_UPDATE`
- `PARTIAL_CLOSE`
- `POSITION_CLOSE`
- `POSITION_SNAPSHOT`

The follower payload must not include:

- entry rule names or rule scores;
- regime internals;
- FastMove activation/peak/giveback state;
- M5 structure details;
- proprietary hold/exit reasoning;
- strategy parameters not required for execution;
- Performance Intelligence calculations.

UI-facing customer reason text, if later required, must use sanitized generic labels such as `MASTER_ENTRY`, `MASTER_MANAGEMENT`, and `MASTER_EXIT`.

### 4.3 License/Auth Gateway

Each follower installation is authorized by a server-side license record.

Canonical V1 license fields:

```text
licenseId
status: ACTIVE | SUSPENDED | EXPIRED | REVOKED
customerId
allowedMt5Logins[]
allowedBrokerServers[]
installationId
installationPublicKey
plan
maxAccounts
issuedAt
expiresAt
revokedAt
```

A license may authorize one or more explicitly configured MT5 accounts according to plan. No wildcard account authorization is allowed in V1.

### 4.4 Installation identity

On first enrollment, the follower creates a unique asymmetric device key pair.

The device private key stays on that installation and should be protected using Windows DPAPI or an equivalent OS-protected secret store. The server stores only the installation public key and installation identifier.

Enrollment and reconnect authentication require proof of possession of the device private key. A bearer installation identifier alone is never sufficient.

Hardware fingerprinting may be used as an anomaly signal but is not the primary license root because hardware identifiers are brittle and create support/recovery problems.

Reinstallation requires an explicit re-enrollment/transfer operation; copying files alone must not reproduce the device identity.

### 4.5 Transport boundary

Production follower transport must use HTTPS/TLS. The copy transport exposes only the bounded copy/license protocol; it must not expose the internal Phase7C API, MT5 bridge, generic API proxy, lifecycle controls, or arbitrary order endpoints.

Device-authenticated requests use proof of possession of the enrolled installation key or a short-lived session credential obtained through such proof. Long-lived global bearer secrets are forbidden in the follower.

The protocol implementation may be tested with an in-memory/local transport before any network rollout.

### 4.6 Command signing

Master commands are signed with Ed25519.

The server holds the Ed25519 private signing key. The follower contains only trusted public verification keys identified by `keyId`.

Canonical signed command envelope:

```text
version
commandId
sequence
licenseId
installationId
mt5Login
brokerServer
symbol
action
payload
masterPositionRef
issuedAt
expiresAt
keyId
signature
```

The signature covers a deterministic canonical UTF-8 serialization of every security-relevant field. No security-relevant field may exist outside the signed body. The implementation plan must choose one canonical serialization and lock it with golden-vector tests before network integration.

### 4.7 Replay and ordering protection

Each `(licenseId, installationId, mt5Login, brokerServer)` command stream has a monotonically increasing `sequence`.

Follower acceptance requires:

```text
INSTALLATION_MATCH
MT5_LOGIN_MATCH
BROKER_SERVER_MATCH
SIGNATURE_VALID
KEY_ID_TRUSTED
NOT_EXPIRED
SEQUENCE_GT_LAST_ACCEPTED
COMMAND_ID_NOT_PREVIOUSLY_APPLIED
ACTION_ALLOWLISTED
PAYLOAD_VALID
LICENSE_ACTION_ALLOWED
```

The follower persists the highest accepted sequence and an idempotency record for recently applied command IDs. Duplicate delivery is safe; old/replayed commands are rejected.

Clock skew tolerance must be bounded and explicit. Sequence validation remains authoritative even when clock skew is tolerated.

### 4.8 License/action authorization matrix

License state is action-sensitive so revocation cannot accidentally strand an existing position.

`ACTIVE` may execute all allowlisted actions subject to account, device, signature, sequence, payload, and follower-risk gates.

`SUSPENDED`, `EXPIRED`, and `REVOKED` must block `POSITION_OPEN` immediately.

For an already-existing matched follower position, non-active license states may accept only signed risk-reducing/reconciliation actions:

- a `STOP_LOSS_UPDATE` that is proven to tighten or preserve protection;
- `PARTIAL_CLOSE`;
- `POSITION_CLOSE`;
- `POSITION_SNAPSHOT`.

`TAKE_PROFIT_UPDATE` is blocked while the license is non-active because a generic TP mutation is not guaranteed to be risk-reducing.

## 5. Follower Agent boundary

The Follower Agent is a separate distributable component and must remain thin.

It may contain only:

- enrollment/license client;
- trusted Master public signing key(s);
- command envelope validation;
- device identity handling;
- sequence/replay/idempotency store;
- per-follower risk configuration and hard protections;
- MT5 execution adapter;
- reconciliation/snapshot handling;
- health/ack reporting;
- secure updater/integrity metadata if later added.

It must not contain any source or compiled copy of Master strategy logic.

The approved follower sizing modes are:

```text
EQUITY_RATIO
LOT_MULTIPLIER
FIXED_LOT
```

Follower sizing is independent of Master strategy logic and never feeds back into Master decisions. Every mode remains bounded by follower hard protections such as maximum lot, maximum open trades, maximum daily loss, account/license authorization, and broker legality. A risk gate may reject or reduce a requested follower exposure when a hard protection would be violated.

## 6. Failure semantics

### 6.1 New exposure

License/auth/signature/connectivity uncertainty is fail-closed for new exposure.

No valid fresh command means no new follower entry.

### 6.2 Existing positions

Existing positions are fail-safe, not abandoned.

The follower retains broker-side SL/TP already applied. Under a non-active license it may execute only the risk-reducing/reconciliation actions defined in the license/action matrix. On reconnect it performs snapshot reconciliation before accepting new exposure.

A license becoming suspended, expired, or revoked blocks new entries immediately. It does not remove an existing broker SL/TP and does not prevent an authenticated signed full/partial close or strictly non-loosening SL update for an existing matched position.

### 6.3 Reconciliation

After disconnect/restart, follower sends its execution state and requests a canonical `POSITION_SNAPSHOT`/reconciliation result. Any divergence is resolved before new exposure is allowed.

## 7. Key management

- Master command-signing private key never enters repository source, follower package, logs, or browser UI.
- Runtime obtains private signing material from a restricted server secret store/environment with OS ACL protection.
- Public verification keys are versioned by `keyId`.
- Command-key rotation uses an overlap window where a follower release trusts both old and new public keys before the old command key is disabled.
- Adding a new trusted command key requires an authenticated follower release/update path; V1 does not allow an arbitrary command message to add trust roots.
- No global symmetric secret is embedded in the follower.

## 8. Logging and privacy

Security audit logs record license ID, installation ID, MT5 account, command ID, sequence, action, verification result, timestamps, and error code.

Logs must not contain strategy calculations, private signing keys, device private keys, bridge API keys, auth tokens, or raw secret values.

Customer-facing telemetry must not reveal proprietary strategy internals.

## 9. Repository and release boundary

The current repository remains private and canonical for Master/Core.

Follower source should be isolated behind a separate package/repository/release boundary before any customer distribution. Customer delivery must use a built artifact, not access to `xauusd-ai-master`.

The historical fact that this repository was previously public is treated as an exposure baseline. Future proprietary improvements are protected by keeping the repository private; V1 does not claim to retract historical clones.

Current-history secret scanning is an acceptance requirement before customer distribution. Any discovered credential must be rotated; deleting a file from the current tree alone is not considered remediation for a secret that entered Git history.

## 10. Compatibility with approved Master Copy Trading model

The Master bot remains the sole source of trading logic.

The Copy Engine mirrors the lifecycle after the Master decision:

```text
Master strategy decision
  -> Master broker/lifecycle event
  -> Copy Event Sanitizer
  -> License/Auth Gate
  -> Command Signer
  -> Transport
  -> Follower verification
  -> Follower sizing/risk protection
  -> MT5 execution
  -> ACK/reconciliation
```

Entry, SL, TP, partial close, full close, and FastMove/M5-driven management changes may be mirrored as execution facts. The reason those changes occurred remains private on the Master.

## 11. Security acceptance contracts

V1 is not accepted until automated tests prove at least the following:

1. valid license + valid device + valid account + valid signature executes exactly once;
2. wrong MT5 account is rejected;
3. wrong broker server is rejected;
4. copied installation without the enrolled device key is rejected;
5. expired/suspended/revoked license blocks new entry;
6. non-active license permits only the explicitly allowed risk-reducing/reconciliation actions for an existing matched position;
7. modified action/payload fails signature verification;
8. unknown `keyId` is rejected;
9. expired command is rejected;
10. replayed sequence is rejected;
11. duplicate command ID is idempotent and never double-executes;
12. out-of-order sequence is rejected;
13. sequence state is isolated by license + installation + MT5 login + broker server;
14. reconnect requires reconciliation before new exposure;
15. transport/server loss blocks new exposure;
16. an existing position keeps its broker-side protection during auth/server loss;
17. follower package has no import/dependency on strategy-engine, Trend/Sideway controller, FastMove, M5, or proprietary decision modules;
18. network payload and follower logs contain no proprietary strategy internals;
19. private signing keys and device private keys are absent from repository and follower artifacts;
20. `EQUITY_RATIO`, `LOT_MULTIPLIER`, and `FIXED_LOT` sizing all obey configured hard protections;
21. BUY/SELL copied execution semantics are symmetric where applicable;
22. security layer performs no direct mutation of Master strategy behavior;
23. current repository/history is scanned for committed secrets before distribution, and discovered credentials are rotated.

## 12. Production safety boundary

The implementation phase is source/CI first.

Until a separate rollout is explicitly approved:

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

No security test may create a LIVE order merely to prove the protocol.

## 13. Implementation decomposition

V1 should be implemented in bounded phases so each can be proven independently:

- P1: protocol types + canonical serialization + Ed25519 sign/verify;
- P2: license model + action-sensitive server-side validation service;
- P3: installation enrollment/device-key proof of possession;
- P4: sequence/idempotency/replay protection;
- P5: sanitized copy-event adapter and command generation;
- P6: thin follower verifier + three sizing modes + hard protections + simulated broker adapter first;
- P7: reconciliation and failure semantics;
- P8: packaging/integrity/no-strategy-dependency + secret-history acceptance;
- P9: staged non-production integration, then separate production rollout decision.

Every phase follows TDD RED -> minimal source fix -> GREEN -> CI -> diff review -> PR/merge only when exact-head gates pass.

## 14. Alternatives considered

### A. Recommended: current private repo as Master/Core + separate thin follower distribution boundary

Pros: preserves existing Phase7C provenance, CI and production attestation; lowest migration risk; strong IP boundary because strategy never ships to customers.

Cons: historical public exposure cannot be undone; repo privacy and collaborator hygiene remain critical.

### B. New clean-history private Core repository immediately

Pros: clean security history and strongest administrative separation.

Cons: high migration risk to current production provenance, deployment scripts, CI, runtime-source attestation, and recovery flows. Not justified for V1 while the current repository is now private.

### C. Compile/obfuscate the existing bot and distribute it

Rejected as the primary design. Obfuscation raises reverse-engineering cost but still places proprietary logic on the customer machine.

## 15. Design decision

Adopt Alternative A for V1.

Keep `xauusd-ai-master` private as canonical Master/Core. Build the security boundary after Master decisions, and distribute only a thin follower component that executes signed, sanitized lifecycle commands.
