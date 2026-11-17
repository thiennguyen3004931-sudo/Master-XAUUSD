from __future__ import annotations

import hmac
from fastapi import Header, HTTPException, status
from .config import Settings


def api_key_dependency(settings: Settings):
    async def verify(x_mt5_api_key: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_mt5_api_key, settings.api_key):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid MT5 bridge API key")
    return verify
