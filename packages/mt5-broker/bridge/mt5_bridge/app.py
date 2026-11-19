from __future__ import annotations

from contextlib import asynccontextmanager
import logging
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

from .auth import api_key_dependency
from .broker_time import (
    broker_time_offset_seconds,
    normalize_candles,
    normalize_deals,
    normalize_positions,
    normalize_quote,
    normalize_ticks,
    normalize_trading_day_boundary,
)
from .config import Settings
from .errors import BridgeError
from .forming_candles import candles_with_forming
from .guarded_gateway import GuardedMt5Gateway
from .historical_candles import historical_candles
from .historical_ticks import historical_ticks
from .ledger import IdempotencyLedger
from .models import CloseRequest, ModifyRequest, OrderRequest

settings = Settings.from_env()
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
ledger = IdempotencyLedger(settings.ledger_path)
gateway = GuardedMt5Gateway(settings, ledger)
verify_api_key = api_key_dependency(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    connected = gateway.start()
    if not connected and settings.fail_startup_if_disconnected:
        raise RuntimeError(gateway.last_error or "MT5 initialization failed")
    yield
    gateway.stop()


app = FastAPI(
    title="XAUUSD AI MASTER — MT5 Bridge",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(BridgeError)
async def bridge_error_handler(_, exc: BridgeError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": {"message": str(exc), "code": exc.code}},
    )


@app.get("/health", dependencies=[Depends(verify_api_key)])
def health(reconnect: bool = True):
    return {
        **gateway.health(reconnect=reconnect),
        "brokerTimeOffsetSeconds": broker_time_offset_seconds(),
    }


@app.get("/v1/quotes/{symbol}", dependencies=[Depends(verify_api_key)])
def quote(symbol: str):
    return normalize_quote(gateway.quote(symbol))


@app.get("/v1/session/day-boundary/{symbol}", dependencies=[Depends(verify_api_key)])
def trading_day_boundary(symbol: str):
    return normalize_trading_day_boundary(gateway.trading_day_boundary(symbol))


@app.get("/v1/candles/{symbol}", dependencies=[Depends(verify_api_key)])
def candles(
    symbol: str,
    timeframe: str = "M15",
    count: int = 320,
    includeForming: bool = False,
):
    rows = (
        candles_with_forming(gateway, symbol, timeframe, count)
        if includeForming
        else gateway.candles(symbol, timeframe, count)
    )
    return normalize_candles(rows)


@app.get("/v1/history/candles/{symbol}", dependencies=[Depends(verify_api_key)])
def candle_history(
    symbol: str,
    fromMs: int,
    toMs: int,
    timeframe: str = "M15",
):
    return normalize_candles(
        historical_candles(gateway, symbol, timeframe, fromMs, toMs)
    )


@app.get("/v1/history/ticks/{symbol}", dependencies=[Depends(verify_api_key)])
def tick_history(symbol: str, fromMs: int, toMs: int):
    return normalize_ticks(historical_ticks(gateway, symbol, fromMs, toMs))


@app.get("/v1/symbols/{symbol}/spec", dependencies=[Depends(verify_api_key)])
def symbol_spec(symbol: str):
    return gateway.symbol_spec(symbol)


@app.get("/v1/history/deals", dependencies=[Depends(verify_api_key)])
def deal_history(fromMs: int, toMs: int, symbol: str | None = None):
    return normalize_deals(gateway.deals(fromMs, toMs, symbol))


@app.get("/v1/positions", dependencies=[Depends(verify_api_key)])
def positions(symbol: str | None = Query(default=None), reconnect: bool = True):
    return normalize_positions(gateway.positions(symbol, reconnect=reconnect))


@app.get("/v1/orders", dependencies=[Depends(verify_api_key)])
def pending_orders(symbol: str | None = Query(default=None), reconnect: bool = True):
    return gateway.pending_orders(symbol, reconnect=reconnect)


@app.post("/v1/orders", dependencies=[Depends(verify_api_key)])
def place_order(request: OrderRequest):
    return gateway.place_order(request)


@app.delete("/v1/orders/{ticket}", dependencies=[Depends(verify_api_key)])
def cancel_order(ticket: str):
    return gateway.cancel_order(ticket)


@app.post("/v1/positions/{ticket}/close", dependencies=[Depends(verify_api_key)])
def close_position(ticket: str, request: CloseRequest):
    return gateway.close_position(ticket, request)


@app.patch("/v1/positions/{ticket}", dependencies=[Depends(verify_api_key)])
def modify_position(ticket: str, request: ModifyRequest):
    return gateway.modify_position(ticket, request)
