# Phase7C SEMI production adoption runner plan

## Scope
Wire existing SEMI manual-adoption/protection contracts into the canonical Trend executor without giving apps/api broker mutation authority.

## Safety boundary
- Source/CI only in this change.
- No production rollout.
- No mode, ARM, task, process, order or position mutation during development.
- Broker mutations in the resulting runtime remain owned by the canonical Trend executor and use the existing shared Phase7C execution lock.
- apps/api remains broker read-only.

## Runtime design
1. Canonical supervisor continues to select/validate DEMO or LIVE EnvFile and passes it to the Trend launcher.
2. Trend account-mode wrapper continues to apply the existing fail-closed LIVE source adapter when AccountMode=LIVE.
3. Trend controller applies an additional fail-closed source adapter before transpiling the legacy Trend controller.
4. Only the legacy `UNMANAGED_POSITION_PRESENT` branch may attempt SEMI adoption, and only when exactly one XAUUSD broker position exists.
5. The SEMI runtime reuses the already-built canonical API service modules for manual-provenance evaluation, durable SQLite adoption state and exact-ticket protection execution.
6. It rechecks canonical bot mode and broker/account/LIVE-arm state while holding the same execution lock used by Trend/Sideway entries.
7. A valid manual position is persisted as PENDING, protected to canonical SL=6 (preserving tighter SL) plus optional Trend Fixed TP, broker-reread confirmed as PROTECTED, then converted into the legacy Trend ManagedState.
8. Existing legacy Trend management then owns +6 BE, +10 one-third partial, Fixed TP, FastMove and structural/reversal management.
9. Manual close tombstones an existing SEMI adoption; system-owned Trend positions remain unaffected.

## TDD
- RED first: `scripts/phase7c-semi-trend-production-wiring.test.mjs` imports the missing runtime/source-adapter and locks behavioral + wiring requirements.
- GREEN: add only the runtime/source-adapter and the minimal Trend-wrapper call.
- Verify existing SEMI contracts, API dependency build, Decision Monitor regression, execution-engine typecheck, Web build, canonical PR gate and diff hygiene before merge.
