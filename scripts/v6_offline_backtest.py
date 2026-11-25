#!/usr/bin/env python3
"""Offline backtest runner for the V6 strategy (hardening/go-live).

Runs the SAME ``run_historical_backtest_on_mt5`` used by the live runtime, but
feeds it bars from a CSV file instead of a live MT5 terminal, so it can run in
CI / on Linux without broker access. Costs (spread, commission, slippage,
swap) are passed explicitly.

CSV input (UTC, header required, M5 or M1 bars):
    time,open,high,low,close
    2026-01-05T00:00:00Z,2650.10,2651.00,2649.80,2650.70

Usage:
    python scripts/v6_offline_backtest.py --csv data/xauusd_m5.csv --mode AUTO_REGIME
    python scripts/v6_offline_backtest.py --synthetic --seed 7   # plumbing check only

Export real history from MT5 (on the trading PC):
    python scripts/v6_export_mt5_history.py --symbol XAUUSD.G --days 120 --out data/xauusd_m5.csv

Synthetic data is a random walk: results are NOT evidence of profitability.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import json
import random
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent


def load_engine():
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe_bt", HERE / "mt5-direct-probe.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _ts(value: str) -> int:
    text = value.strip()
    if text.isdigit():
        n = int(text)
        return n if n > 10**11 else n * 1000
    parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp() * 1000)


def read_csv(path: Path) -> list[list[float]]:
    rows = []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            stamp = r.get("time") or r.get("datetime") or r.get("timestamp") or ""
            rows.append([float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), _ts(stamp)])
    rows.sort(key=lambda b: b[4])
    return rows


def resample(bars: list[list[float]], minutes: int) -> list[list[float]]:
    """Aggregate OHLC bars into ``minutes`` buckets aligned to UTC."""
    out: list[list[float]] = []
    span = minutes * 60_000
    for o, h, low, c, t in bars:
        bucket = (t // span) * span
        if out and out[-1][4] == bucket:
            cur = out[-1]
            cur[1] = max(cur[1], h)
            cur[2] = min(cur[2], low)
            cur[3] = c
        else:
            out.append([o, h, low, c, bucket])
    return [[round(b[0], 2), round(b[1], 2), round(b[2], 2), round(b[3], 2), int(b[4])] for b in out]


def synthetic_m5(seed: int, days: int, start_price: float = 2650.0) -> list[list[float]]:
    """Regime-switching random walk on weekdays (trend / range / volatile)."""
    rng = random.Random(seed)
    t0 = int(dt.datetime(2026, 1, 5, tzinfo=dt.timezone.utc).timestamp() * 1000)
    price = start_price
    bars = []
    drift, vol, left = 0.0, 0.8, 0
    for i in range(days * 288):
        t = t0 + i * 300_000
        if dt.datetime.fromtimestamp(t / 1000, tz=dt.timezone.utc).weekday() >= 5:
            continue
        if left <= 0:
            regime = rng.choice(["trend_up", "trend_down", "range", "volatile"])
            drift = {"trend_up": 0.12, "trend_down": -0.12, "range": 0.0, "volatile": 0.0}[regime]
            vol = {"trend_up": 0.7, "trend_down": 0.7, "range": 0.5, "volatile": 1.6}[regime]
            left = rng.randint(100, 600)
        left -= 1
        o = price
        c = o + drift + rng.gauss(0, vol)
        h = max(o, c) + abs(rng.gauss(0, vol * 0.6))
        low = min(o, c) - abs(rng.gauss(0, vol * 0.6))
        bars.append([round(o, 2), round(h, 2), round(low, 2), round(c, 2), t])
        price = c
    return bars


class OfflineMt5:
    """Read-only stand-in: only what the backtest reads. No order_send."""
    TIMEFRAME_M5, TIMEFRAME_M15, TIMEFRAME_H1, TIMEFRAME_H4 = 5, 15, 60, 240

    def __init__(self, contract_size: float = 100.0, leverage: int = 100):
        self._sym = SimpleNamespace(trade_contract_size=contract_size, trade_tick_size=0.01,
                                    trade_tick_value=contract_size * 0.01, point=0.01, digits=2,
                                    volume_min=0.01, volume_step=0.01, volume_max=100.0)
        self._acct = SimpleNamespace(leverage=leverage)

    def symbol_info(self, symbol):
        return self._sym

    def account_info(self):
        return self._acct

    def copy_rates_from_pos(self, *a, **k):
        return None


def run(m5: list[list[float]], args) -> dict:
    engine = load_engine()
    cfg = {
        "m5Bars": m5,
        "m15Bars": resample(m5, 15),
        "h1Bars": resample(m5, 60),
        "h4Bars": resample(m5, 240),
        "strategyMode": args.mode,
        "minConfidence": args.min_confidence,
        "spreadPts": args.spread,
        "commissionPtsRoundTrip": args.commission,
        "slippagePtsRoundTrip": args.slippage,
        "swapPtsPerDay": args.swap,
        "volume": args.lot,
        "startingBalance": args.balance,
        "usdPerPricePerLot": 100.0,
        "leverage": 100,
        "brokerUtcOffsetHours": 0,
    }
    res = engine.run_historical_backtest_on_mt5(OfflineMt5(), "XAUUSD", cfg)
    keys = ["ok", "status", "message", "tradeCount", "openAtEndCount", "wins", "breakevens", "losses", "winRatePct",
            "breakevenRatePct", "lossRatePct", "profitFactor", "expectancyR", "netPts", "netPnlUsd",
            "maxDrawdownPts", "maxDrawdownPct", "maxConsecutiveLosses", "waitPullbackSkipped",
            "nearObstacleBlocked", "ambiguousBarsCount", "barsScanned", "fixedLot", "simulationResolution"]
    summary = {k: res.get(k) for k in keys if k in res}
    summary["costs"] = {"spreadPts": args.spread, "commissionPtsRoundTrip": args.commission,
                        "slippagePtsRoundTrip": args.slippage, "swapPtsPerDay": args.swap}
    summary["chronologicalSegments"] = res.get("chronologicalSegments")
    return summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--csv", type=Path)
    src.add_argument("--synthetic", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--resample-from-m1", action="store_true", help="CSV is M1; aggregate to M5 first")
    ap.add_argument("--mode", default="AUTO_REGIME")
    ap.add_argument("--min-confidence", type=float, default=85)
    ap.add_argument("--spread", type=float, default=0.25, help="USD/oz, e.g. 0.25 = 25 points")
    ap.add_argument("--commission", type=float, default=0.07, help="USD/oz round trip (7 USD/lot)")
    ap.add_argument("--slippage", type=float, default=0.10, help="USD/oz round trip")
    ap.add_argument("--swap", type=float, default=0.0, help="USD/oz per day held")
    ap.add_argument("--lot", type=float, default=0.02)
    ap.add_argument("--balance", type=float, default=4000.0)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    if args.csv:
        bars = read_csv(args.csv)
        if args.resample_from_m1:
            bars = resample(bars, 5)
        source = {"type": "CSV", "file": str(args.csv)}
    else:
        bars = synthetic_m5(args.seed, args.days)
        source = {"type": "SYNTHETIC_RANDOM_WALK", "seed": args.seed, "days": args.days,
                  "warning": "Synthetic data: validates accounting only, NOT strategy edge"}
    summary = {"source": source, "mode": args.mode, **run(bars, args)}
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    print(text)
    return 0 if summary.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
