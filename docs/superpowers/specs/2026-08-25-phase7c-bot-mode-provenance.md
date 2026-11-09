# Phase7C Bot Mode Provenance Spec

## Problem

`phase7c-bot-mode.json` stores only the latest `mode`, `updatedAt`, and `updatedBy`. Each subsequent change overwrites the previous provenance, so an unexpected transition such as `PAUSE -> AUTO` cannot be reconstructed after another mode write occurs.

## Required behavior

- Every call to `Phase7CBotModeService.set()` must produce an append-only JSONL provenance event.
- Each event records `event`, `fromMode`, `toMode`, `updatedAt`, `updatedBy`, and process `pid`.
- The default audit path is `.runtime/phase7c-bot-mode-audit.jsonl`, colocated with the canonical bot-mode state file.
- Active modes (`AUTO`, `TREND`, `SIDEWAY`) are fail-closed: provenance must append successfully before the canonical state file can change.
- `PAUSE` remains safety-first: canonical PAUSE state must still be written even if provenance append fails; audit is best-effort after the PAUSE state write.
- Audit events represent set attempts accepted by the service. An active-mode audit event can exist even if the later atomic state-file write fails; the current canonical state remains authoritative.

## Non-goals / invariants

- No change to mode selection rules, strategy, risk, SL/TP/BE/partial, executor topology, account switching, LIVE ARM, broker/order/position mutation, or MT5 panel permissions.
- No history API or UI is added in this PR.
- Existing `phase7c-bot-mode.json` schema remains unchanged.
