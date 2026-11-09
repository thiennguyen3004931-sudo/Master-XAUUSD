from __future__ import annotations

import json
import os
from urllib.request import Request, urlopen

BASE_URL = os.getenv("MT5_BRIDGE_URL", "http://127.0.0.1:8765").rstrip("/")
API_KEY = os.getenv("MT5_API_KEY", "")
SYMBOL = os.getenv("MT5_SMOKE_SYMBOL", "XAUUSD")

if not API_KEY:
    raise SystemExit("Set MT5_API_KEY before running the read-only smoke test.")


def get(path: str):
    request = Request(
        f"{BASE_URL}{path}",
        headers={"Accept": "application/json", "X-MT5-API-Key": API_KEY},
    )
    with urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


print(json.dumps({
    "health": get("/health"),
    "quote": get(f"/v1/quotes/{SYMBOL}"),
    "spec": get(f"/v1/symbols/{SYMBOL}/spec"),
    "positions": get(f"/v1/positions?symbol={SYMBOL}"),
}, indent=2))
