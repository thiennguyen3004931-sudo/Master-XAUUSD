#!/usr/bin/env python3
"""READ-ONLY export of MT5 M5 history to CSV for scripts/v6_offline_backtest.py.

Runs on the Windows trading PC with the MT5 terminal open. Uses only
initialize / copy_rates_range / shutdown: no order is ever sent.

    python scripts/v6_export_mt5_history.py --symbol XAUUSD.G --days 180 \
        --broker-utc-offset 2 --out data/xauusd_m5.csv

MT5 bar times are broker-server time; --broker-utc-offset converts them to UTC.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="XAUUSD.G")
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--broker-utc-offset", type=float, required=True)
    ap.add_argument("--out", type=Path, default=Path("data/xauusd_m5.csv"))
    args = ap.parse_args(argv)
    import MetaTrader5 as mt5  # noqa: WPS433 (Windows only)
    if not mt5.initialize():
        print(f"initialize failed: {mt5.last_error()}")
        return 1
    try:
        end = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=args.broker_utc_offset)
        start = end - dt.timedelta(days=args.days)
        rates = mt5.copy_rates_range(args.symbol, mt5.TIMEFRAME_M5, start.replace(tzinfo=None), end.replace(tzinfo=None))
        if rates is None or len(rates) == 0:
            print(f"no data: {mt5.last_error()}")
            return 1
        args.out.parent.mkdir(parents=True, exist_ok=True)
        off = int(args.broker_utc_offset * 3600)
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["time", "open", "high", "low", "close"])
            for r in rates:
                t = dt.datetime.fromtimestamp(int(r["time"]) - off, tz=dt.timezone.utc)
                w.writerow([t.strftime("%Y-%m-%dT%H:%M:%SZ"), r["open"], r["high"], r["low"], r["close"]])
        print(f"wrote {len(rates)} bars to {args.out}")
        return 0
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
