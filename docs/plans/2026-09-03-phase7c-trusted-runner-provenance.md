# Phase7C Trusted Runner Provenance Implementation Plan

> Scope: source/CI only. No LIVE runtime mutation, task restart, bridge restart, ARM/AUTO change, deployment, or order mutation.

## Goal

Prevent the Phase7C SYSTEM Scheduled Task from executing stale or modified runner content merely because it still exists at the canonical runner path. Preserve safe ownership of legacy Phase7C tasks so the installer can require an explicit guarded repair without taking over foreign tasks.

## Evidence baseline

The stale-runner provenance regression already reproduces the exact detector tuple while task action ownership remains path-only `OWNED`: broker process alive, heartbeat fresh, status/heartbeat PID match, startup runner lock `MISSING`, and exact generation mismatch true. The startup-runner Windows matrix otherwise passes.

## Task 1 — Add fix-contract regression before production changes

Files:
- Create `scripts/test-phase7c-task-action-runner-hash-guard-local.ps1`.
- Update `.github/workflows/phase7c-startup-runner-lock-lifetime-ci.yml`.

Test contract:
1. A clean tracked canonical runner in a temporary Git repository yields a trusted SHA256.
2. A canonical guarded Scheduled Task action is classified `owned=true`, `canonical=true`, `repairRequired=false`.
3. A legacy exact `-File <canonical-runner>` action remains `owned=true` but is `canonical=false`, `repairRequired=true`.
4. A strict Phase7C guard containing an old hash remains `owned=true` but requires repair.
5. A malformed/foreign encoded command remains `owned=false`.
6. After the runner is modified, trusted Git-source verification fails closed.
7. A pinned guarded action run after that modification exits `86` before the runner can create its side-effect marker.

Place this Windows PowerShell 5.1 test before the existing stale-runner provenance test so its initial failure is observable as the TDD RED.

## Task 2 — Implement trusted source + guarded action helpers

File:
- Modify `scripts/lib/phase7c-scheduled-task-ownership.ps1`.

Add minimal helpers that:
- Prove the runner is tracked and unchanged from `HEAD` with Git before accepting its worktree hash.
- Calculate SHA256 only after that Git proof.
- Build a deterministic `-EncodedCommand` guard using UTF-16LE Base64.
- Recompute SHA256 immediately before runner invocation and `exit 86` on missing/hash mismatch/error.
- Strictly parse/reconstruct only the Phase7C-owned encoded-command template; never execute payloads while classifying ownership.
- Distinguish canonical guarded action, legacy owned action, old-hash owned action, and foreign action.

## Task 3 — Wire the installer fail-closed

File:
- Modify `scripts/register-phase7c-executor-task-local.ps1`.

Behavior:
- Resolve the trusted Git-backed runner SHA256 before task creation/repair/start.
- Create/repair using the guarded action only.
- Add action provenance drift when ownership is legacy or hash-drifted.
- Never treat a repair-required action as canonical/startable without explicit `-Repair`.
- Keep foreign-task mutation blocked.
- Verify repaired/created action is canonical and pinned to the trusted SHA256 before starting.
- Existing running-task repair guard remains unchanged.

## Task 4 — Verify RED → GREEN on Windows

1. Push test/workflow only and confirm the new hash-guard step is RED for the expected missing contract/behavior while prior steps remain healthy.
2. Push helper/installer implementation.
3. Confirm the full `phase7c-startup-runner-lock-lifetime-ci.yml` Windows matrix is GREEN, including:
   - finite lifetime PS5.1
   - persistent loop PS5.1
   - persistent SYSTEM task PS5.1
   - broker STOP failure PS5.1
   - generation mismatch PS5.1
   - ACL observer PS5.1
   - task action runner hash guard PS5.1
   - stale runner provenance PS5.1
   - PS7 regressions
4. No PR/merge or LIVE deployment in this scope.
