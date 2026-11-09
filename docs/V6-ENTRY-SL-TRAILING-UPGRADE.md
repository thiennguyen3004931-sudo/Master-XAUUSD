# V6 direct MT5 strategy, SL and trailing upgrade — review / DEMO only

This document covers **scripts/xauusd-standalone-server.mjs** and **scripts/mt5-direct-probe.py**. It does not change the legacy Phase7B/Phase7C controller implementation.

## Hard release gates

- **Do not deploy this PR on a LIVE account.** It is a draft until Windows MT5 DEMO E2E, regression review and broker-execution acceptance. V6 direct broker actions reject REAL account entry/DCA. The standalone Web account switch does not arm LIVE.
- The control API is fail-closed without \`ZIQ_V6_CONTROL_TOKEN\`. Enter the control secret in the standalone Web UI once per browser tab (session storage), and **only access the trading UI over localhost or a protected HTTPS/VPN connection**.
- The old checked-in Telegram bot token was removed from source in this branch. **Revoke/rotate the previously exposed token**; rewriting source does not invalidate the existing token or erase Git history. Check previously tracked \`.runtime\` files for credentials, and never put fresh secrets in Git.
- The release is not a profitability claim. Static dashboard samples are illustrative, not a verified MT5 tick replay.

## Automatic entry contracts

All strategies require confirmed candles (the most recent MT5 candle is considered forming); enough M5/M15/H1/H4 history; valid Bid/Ask; and a valid broker-protected SL/TP and minimum reward/risk.

| Mode | Entry filter | Exit |
| --- | --- | --- |
| BOT_1_TREND | EMA10/25 directional bias on H4, H1 and M15, strong confirmed M15 body/engulfing and same-direction closed M5 | Structural swing SL, H1/H4 candidate or 2.2R fallback, minimum 1.6R |
| BOT_2_SIDEWAY | H1 range/flatness filter, 20 completed M15 candles forming a bounded corridor, quote in outer 25% of corridor, M15 rejection and confirmed M5 | SL outside range, target before opposite range boundary, minimum 1.25R; NO trend trailing or DCA |
| BOT_3_SWEEP | Last completed M15 must sweep the preceding eight-bar extreme and **close back inside**, with substantial rejection wick and same-direction M5 | SL behind sweep extreme, opposing S/R target or 2.2R, minimum 1.6R |
| BOT_4_SWEEP_DCA_PLUS | Same confirmed Sweep entry; DCA remains separately user-controlled | Same entry exit; optional protected pyramiding |
| AUTO_REGIME | Prefer valid Sweep, otherwise confirmed Trend, otherwise valid Sideway | Rules of selected underlying strategy |
| SEMI_AUTO_TREND | No automatic new entry | Optional adoption of user manual tickets and protected management |

Setup confidence numbers are **heuristic scores** and MUST NOT be reported as calibrated win probability. Mode filtering is re-evaluated inside the Python broker action, never trusted solely from the browser or Node monitoring snapshot.

## Stop placement and order gate

- Derive stop from eight confirmed M5 candle extremes (or exact range/sweep invalidation) plus an ATR-related price buffer.
- If raw structure is nearer than six XAUUSD price units, widen the stop outside the structure to six units. If the genuine structural invalidation is **more than ten price units**, reject and wait for a better entry rather than blindly clipping the stop inside the swing.
- Check broker Bid/Ask, quote age <=20 s, spread <=65 points (starting research default, broker-specific), minimum stop distance, valid lot min/step/max, \`order_calc_profit\` loss at SL and equity before any \`order_send\`.
- Server-supplied cap is **<=1.0% equity per original order**, **<=0.5% for each DCA add**, and <=1.5% estimated stop risk for all open positions plus the new order. These caps are provisional; the broker's trading costs and adverse gaps may exceed them.
- Do not place any new order if another open position has no SL, or account information / order-profit estimation is unavailable.
- Avoid counting a fixed 100 USD/lot unit as a universal MT5 contract assumption; broker-side \`order_calc_profit\` is authoritative.

## Ticket-aware management

- Persistent ticket state: \`.runtime/v6-position-manager-state.json\` stores *initial R*, favorable peak and whether H1 partial has been attempted. It is not committed. If original R cannot be reliably recovered, do not invent one.
- Move SL to entry +/-0.25 price units after the trade reaches its original 1R; this offset is not guaranteed to cover commissions, swap, spread or slippage.
- After BE, tighten SL to the last five **confirmed** M5 candle lows/highs with a 0.35-unit buffer, subject to a gap of at least 1.2 units from the executable quote and strictly monotonic tightening.
- On a significant M15 expansion or sufficiently large excursion, also consider the persisted lifetime ticket peak minus/plus 10 price units; choose only the *tightest safe* candidate.
- For Trend/Sweep tickets only, near H1 and >=1.2 initial R, attempt one 50% partial close, mark it before broker submission to avoid double partials on lost responses, and extend the remaining TP toward H4 when suitable.
- Do not trail Sideway trades as Trend runners. Do not modify another EA's positions. Manual position adoption is opt-in.
- Reading status via \`probe\` never sends orders or changes SL. Mutations are serialized from the standalone Node server. A new automatic order can occur at most once for the same account, mode, direction and confirmed M15 candle.

## Positive DCA

- Remains **OFF by default**. Sideway DCA is forbidden in the Python check regardless of Web checkbox state.
- Every older layer must have positive profit and an SL *confirmed by fresh MT5 positions_get* at or beyond entry before any additional order.
- Require a newly closed M15 strategy signal after the latest position entry, matching the selected bot and direction, plus configured step distance, at least 1.2 units.
- Derive added order SL from that strategy's newly calculated structural invalidation, not a blind fixed 6.8-unit stop. The candidate TP must still provide sufficient RR and pass independent broker risk gates.
- The read-only \`probe\` call only reports DCA eligibility; it must not execute DCA.

## Verification

Offline command sequence (no installed MT5 required):

\`\`\`bash
python -m py_compile scripts/xauusd_v6_trade_rules.py scripts/mt5-direct-probe.py tests/test_v6_trade_rules.py tests/test_v6_mt5_execution.py
python -m unittest discover -s tests -p 'test_v6_*.py' -v
node --check scripts/xauusd-standalone-server.mjs
\`\`\`

Next, on Windows MT5 DEMO, verify:
1. Each mode allows only its intended entries, with no duplicate M15 trade on restart.
2. When structure requires >10 price units, no order is sent.
3. BUY and SELL initial SL/TP use correct broker-side Bid/Ask, stops, lot step and risk caps.
4. BE/trailing never widen a stop, and a temporarily unavailable broker cannot make state assume BE was accepted.
5. The H1 partial closes at most once per ticket, and the runner remains protected.
6. DCA remains disabled on Sideway and blocks when any earlier layer is not broker-confirmed protected.
7. Status reads, Web refresh and mobile polling cannot change live positions.
8. Real-account entries are rejected, even if a browser sends a trade request.

Only after DEMO and independent replay with costs, return/win/loss by session and market regime, drawdown and out-of-sample walk-forward should the strategy be considered for LIVE authorization in a **separate reviewed change**.

## Out-of-scope / still pending

A global daily-loss kill switch, full reconciliation of broker execution history vs local partial-close state after process crashes, verified NEWS calendar guard, robust spread/slippage/commission modeling, calibrated signal confidence and dynamic ATR regime tuning all require further work and acceptance.
