# FastMove 10/10 + M5 One-Way Handoff — Approved Addendum

Date: 2026-09-10
Status: Approved operator contract
Scope: Phase7C Trend, Sideway, SEMI inheritance, AUTO effective-strategy inheritance

This addendum supersedes any older FastMove or structural-trailing wording that conflicts with the contract below.

## Canonical contract

- BUY / SELL behavior is symmetric.
- FastMove activation is exactly +10 favorable XAUUSD price units.
- FastMove giveback is exactly 10 price units from the persisted best favorable peak.
- The favorable peak persists through pullback; a pullback never replaces the remembered best peak with a worse price.
- +6 remains break-even only. No one-third partial close occurs at +6.
- +10 performs the canonical one-third partial close, subject only to existing broker volume-step/minimum-volume legality.
- After a confirmed eligible M5 structure appears, FastMove hands stop ownership to M5 exactly once.
- The M5 handoff is durable. FastMove must never resume stop ownership after handoff.
- An M5 stop candidate that is worse than or equal to the current/tightest stop is rejected.
- An M5 stop candidate that is strictly more protective than the current/tightest stop may be accepted, subject to existing broker stop/freeze legality.
- Stop Loss is monotonic and must never be widened by FastMove, M5 structural trailing, SEMI adoption, or later management.
- SEMI inherits the canonical Trend post-entry management behavior.
- AUTO inherits the canonical behavior of its effective strategy; AUTO does not own a separate FastMove implementation.

## Canonical acceptance proof

The FastMove canonical source contract must report:

`P3=ACTIVATION_10_GIVEBACK_10`

This marker is emitted only after the source-contract assertions have verified canonical raw Trend/Sideway activation=10 and giveback=10, no legacy 6/4 giveback constant remains in canonical raw source, the adapter is not masking old constants, M5 handoff state exists, and the runtime compares M5 candidates against the current broker stop.

## Superseded wording

Where the earlier SEMI design document dated 2026-09-09 says FastMove giveback is 6 or describes post-FastMove structural trailing as M15 ownership, this approved addendum replaces that wording with giveback=10 and the durable one-way M5 handoff contract above.

## Safety scope

This change is source/test/documentation only. It does not change production mode, ARM state, lifecycle, orders, positions, or create a LIVE validation order.
