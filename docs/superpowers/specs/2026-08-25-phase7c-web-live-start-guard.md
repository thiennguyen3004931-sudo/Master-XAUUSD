# Phase7C Web LIVE Start Guard Spec

## Problem

`startPhase7CFromWeb()` currently allows the `current.ready` branch to call `phase7CBotModeService.set("AUTO", "web-control-center-start")` before the function reaches its later LIVE cold-start block. Therefore a selected LIVE runtime that is already ready can be moved from `PAUSE` to `AUTO` by the Web lifecycle endpoint even when LIVE execution is separately DISARMED by the broker arm guard.

## Required behavior

- Web lifecycle Start must never activate a LIVE runtime mode.
- When the selected account is LIVE, Web Start must force/keep `PAUSE` and reject the request before any `AUTO` write, regardless of whether the runtime is already ready.
- DEMO behavior must remain unchanged: a ready DEMO runtime may switch to `AUTO`, and a clean DEMO cold-start may switch to `AUTO` only after final preflight succeeds.
- Web Stop remains allowed to force `PAUSE`.
- No LIVE ARM, account switch, broker order/position mutation, executor start/stop, strategy, risk, SL/TP/BE/partial, or MT5 panel behavior is changed by this PR.

## Safety invariant

LIVE activation remains a separate operator-controlled flow. Web lifecycle controls may observe LIVE and may stop/pause it, but may not transition LIVE into an active bot mode.
