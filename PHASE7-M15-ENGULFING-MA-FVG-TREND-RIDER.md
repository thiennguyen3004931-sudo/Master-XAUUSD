# Phase 7 — M15 Engulfing + MA + FVG Trend Rider

Research-only additive lane. Phase 6D/6E remain unchanged.

## Entry

A trade is created only when all mandatory conditions agree:

### BUY
- M15 body bullish engulfing is present.
- MA20 > MA50 > MA200.
- M15 close > MA20.
- A bullish FVG from the configured recent lookback is relevant to the engulfing bar.

### SELL
- M15 body bearish engulfing is present.
- MA20 < MA50 < MA200.
- M15 close < MA20.
- A bearish FVG from the configured recent lookback is relevant to the engulfing bar.

There is no Volume Profile requirement in Phase 7 and no USD risk-cap gate.

## Stop loss

The initial SL is price-distance based, not USD-risk based:

- Structural reference = engulfing candle low for BUY / high for SELL.
- If structural distance < 6 price units, use 6.
- If structural distance is 6–10, use the structural distance.
- If structural distance > 10, cap initial SL distance at 10.

Therefore every qualifying signal uses an initial SL between 6 and 10 XAUUSD price units.

## Position size

Phase 7 research uses fixed volume. The local runner defaults to 0.03 lot so a broker with min/step 0.01 can split the position into three 0.01-lot pieces. This is not a production sizing recommendation and can be changed explicitly with `-FixedVolume` for research.

## Trend-rider management

Default management:

1. At +6 price units:
   - close approximately one third of the original position when broker lot-step permits;
   - move SL on the remaining position to entry +2 for BUY / entry -2 for SELL.
2. At +10 price units:
   - close another approximately one third when broker lot-step permits;
   - activate trailing stop at 5 price units.
3. Leave the final remainder to run with the trend.
4. Exit the remaining position on trailing/stop or M15 close crossing MA20 against the trade.

If fixed volume is too small for a legal partial close, the engine does not invent a fractional broker lot. It still applies the protected SL and trailing logic.

## Validation status

The first Phase 7 replay intentionally reuses the available 360-day historical dataset for research diagnostics. It is **not** an independent blind holdout because the Phase 7 specification was created after Phase 6E results were observed.

Any production candidate must be preregistered and tested on a new independent historical/forward window.

`PHASE7_PRODUCTION_MUTATION=false`
