# Customer release candidate evidence — 2026-10-25 (UTC)

Scope: **source and CI evidence only**. This record does not attest a customer machine, DEMO broker execution, or LIVE authorization. Historical snapshot; refresh on any subsequent accepted `main` commit.

| Evidence | Observed result |
| --- | --- |
| Private Core repository | `thiennguyen3004931-sudo/xauusd-ai-master-core` (private) |
| Accepted main SHA at assessment | `197803efee5ab2c718c65076d1a9dcb16fe1319f` |
| Public distribution SHA pinned by core | `bdf6dd163afed23d3e5d2079ab5fc94132b2c0bd` |
| Canonical PR Gate on main | [PASS / 40199166805](https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core/actions/runs/40199166805) |
| Customer Final Production Acceptance on main | [PASS / 40199166825](https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core/actions/runs/40199166825) |
| Customer Deployment + Follower Execution Acceptance on main | [PASS / 40199166792](https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core/actions/runs/40199166792) |
| Private Master Core CI | [PASS on PR #157 head `b8da4dcb4ea60cfe80cf81601803bf9e962d4f6c` / 40192112004](https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core/actions/runs/40192112004); **not a run attesting final main SHA** |
| Release artifact | [`xauusd-customer-agent-v1`, ID 12601917570](https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core/actions/runs/40199166792/artifacts/12601917570) |
| GitHub artifact archive SHA-256 | `c389c3d55bfa5012b89747d712755afb2a15fcd298cdac5c40a4f8ae3ecaf918` — independently recomputed after download on 2026-10-26; matches GitHub digest |
| Package internal manifest | 21 entries checked in workflow and independently rehashed after artifact download; all 21 match |
| Artifact retention expiry | 2026-11-24 14:13 UTC (per GitHub metadata) |
| Official GitHub Release | **Not found as of review** |
| Inner customer ZIP digest | `801a2e8bf4885c92ca7932a5b3fda627cc95953caa52bbb8c869724986f6ddc7` — independently computed from `customer-agent-v1.zip` inside artifact archive (44,250 bytes) |
| Customer machine verification / sign-off | **NOT DONE** |
| Real follower MT5 bridge and DEMO order acceptance | **NOT DONE** (`REAL_CUSTOMER_MT5_BRIDGE_BINDING=NONE`, `MT5_LIVE_EXECUTION=NONE` in workflow) |

## Required release decisions

1. Before shipment, obtain and verify the exact final-main Private Master Core CI evidence; PR-head PASS is not a substitute for an exact-SHA run.
2. **Completed for this historical artifact only (2026-10-26):** independent outer digest match, inner ZIP hash, all 21 manifest entries, extra-file rejection and forbidden-path boundary. Re-run these steps for any newly produced artifact or candidate SHA. Avoid recording any tokens/keys.
3. Publish an immutable, signed versioned customer release only after owner approval. Document version, rollback target, digest, expiry and support scope.
4. Use `customer-release/acceptance-record.template.md` per installation. Package CI `PASS` is not a customer installation sign-off.
5. Each later change invalidates this snapshot as a current candidate. Never copy evidence onto a new SHA without verifying again.

## Safety

`BOT_MODE_MUTATION=NONE`; `ARM_MUTATION=NONE`; `MT5_MUTATION=NONE`; `ORDER_MUTATION=NONE`; `POSITION_MUTATION=NONE`; `LIVE_TEST_ORDER=NONE`.

## Independent ZIP audit note (2026-10-26)

The downloaded GitHub Actions artifact was inspected without running packaged scripts or accessing MT5. The outer archive contains exactly one inner customer ZIP. The inner ZIP contains 21 verified manifest-listed files, the manifest itself and one Windows-style directory record. Paths are stored with Windows backslashes; comparison normalized separators and asserted no path traversal, duplicate canonical paths, symlinks or forbidden private-bot/source/key paths. This package is Windows-oriented; cross-platform extraction is **not** independently accepted. Both checksums above are specific to artifact ID `12601917570`, **not** future builds or PR #165. This audit does not prove Ed25519 publisher signature, Windows key-at-rest protection, customer host activation or MT5 DEMO execution.
