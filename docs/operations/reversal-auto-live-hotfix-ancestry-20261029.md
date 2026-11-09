# REVERSAL AUTO LIVE — isolated hotfix ancestry bridge

**Date:** 2026-10-29. **Scope:** Git history / release provenance only.

The user asked to keep the live bot intentionally OFF while we prepare the
REVERSAL AUTO order-entry hard lock. No bot or MT5 connection is necessary to
perform code-only checks. The LIVE preflight is a separate manual action for
when the user explicitly brings the bot online.

## Immutable source references

- Production baseline observed before intentional OFF:
  `ff116b5e0c491163a11e33cb9e38fb6b503f0a1d`.
- Canonical `main` at preparation time:
  `3393c199dc3f6874b124b7fbbf9114c9d76af3fa`
  (merged PR #181, includes the hard lock and H1/H4 SHADOW analysis).
- Isolated hotfix branch:
  `hotfix/prod-auto-reversal-lock-20261029` (PR #182, review baseline).
- REVERSAL gate helper, test and Trend wrapper Git blob SHAs were verified
  byte-identical between canonical `main` and isolated hotfix.
- PR #183 was closed **unmerged** to avoid merging a divergent hotfix
  source tree directly into canonical `main`.

## Ancestry integration invariant

A dedicated two-parent Git commit intentionally has:
1. first parent: a documentation-only commit descended from canonical main;
2. second parent: the exact reviewed isolated production hotfix commit;
3. **tree exactly matching the first parent's tree**.

This is a merge strategy that **keeps main source files unchanged** while
recording that the hotfix is an ancestor of canonical main. Review the exact
parent SHAs and tree SHA, not only the displayed PR diff.

After the ancestry bridge is merged using a merge commit (NOT squash or
rebase), the canonical production rollout helper's ancestry conditions can
be satisfied for the isolated hotfix target. Do not directly fast-forward the
older LIVE checkout to all accumulated canonical main changes simply to lock
REVERSAL.

## Mandatory pre-cutover checks

- The hotfix exact-head unit and source tests must pass; no LIVE test order.
- Operator confirms bot/MT5 bridge was intentionally started; otherwise
  `OFFLINE_EXPECTED`, and LIVE preflight is **not run**.
- A fresh GET-only LIVE preflight must prove:
  `BOT_MODE=PAUSE`, LIVE account, healthy bridge, unchanged bridge session,
  zero XAUUSD positions and pending orders, clean expected production HEAD,
  runtime source attestation EXACT_MATCH and stable lifecycle.
- Use the existing guarded source-transition helper only when its exact
  remote-main pin, ancestry, helper blob, rollout/rollback and post-deploy
  attestation guards are satisfied; never bypass safeguards.
- Production cutover must be separately reviewed and accepted, and must
  **not** activate AUTO, open/modify/close MT5 positions, or send probes.
- If preflight fails, preserve production unchanged and investigate after
  the operator intentionally resumes the bot.

This file documents operational safety; it does **not** deploy the hotfix.
