# Phase 4D — Shadow Management Sweep

## Why

Phase 4C produced 163/163 filled shadow min-lot trades with 61.35% win rate, but net PnL -53.12, profit factor 0.9027, expectancy -0.3259 USD/trade, and average R -0.0483. This means entry feasibility is no longer the main question; payoff and management need controlled research.

## Scope

Phase 4D replays the exact same shadow trade cases produced by Phase 4C. It does not change canonical M15 signal, compressed entry selection, structural SL, canonical TP, min-lot 0.01, or production execution.

The only variables swept are:

- break-even trigger: 6, 8, 10 price units
- break-even offset: 0.1, 1, 2 price units
- trailing trigger: 10, 12, 15 price units
- trailing distance: 3, 4, 6 price units

Only combinations with trailing trigger >= break-even trigger are evaluated.

## Ranking

Every variant reports filled trades, win rate, net PnL, profit factor, expectancy, and average R. The sweep separately identifies the best variant by expectancy, profit factor, and net PnL. No single winner is promoted to production without an out-of-sample or walk-forward check.

## Conservative replay rules

- entry must be touched on M5 before expiry
- existing SL/TP is evaluated before any same-bar management update
- same-bar SL/TP ambiguity is STOP_FIRST
- management updates apply only to following bars
- production mutation remains false

## Go criteria for the next research stage

A configuration is only a candidate if it has positive expectancy, profit factor > 1, positive average R, and does not depend on a materially smaller trade subset. Stability across neighboring parameter values is preferred over a single isolated optimum.
