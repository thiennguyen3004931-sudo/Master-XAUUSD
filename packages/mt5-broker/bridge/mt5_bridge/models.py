from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

try:
    from pydantic import model_validator
except ImportError:  # pragma: no cover - Pydantic v1 compatibility fallback
    model_validator = None  # type: ignore[assignment]
    from pydantic import root_validator


class OrderRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    side: Literal["BUY", "SELL"]
    orderType: Literal["MARKET", "LIMIT", "STOP"]
    timeInForce: Literal["GTC", "DAY", "IOC", "FOK"]
    volume: float = Field(gt=0)
    requestedPrice: float = Field(gt=0)
    stopLoss: float = Field(gt=0)
    # MT5 uses tp=0 to mean no fixed take-profit. Phase 7B manages exits
    # dynamically, so zero is a valid and intentional value.
    takeProfit: float = Field(ge=0)
    deviationPoints: int = Field(gt=0, le=10000)
    magicNumber: int = Field(gt=0)
    comment: str = Field(default="xauusd-ai-master", max_length=128)
    clientOrderId: str = Field(min_length=1, max_length=128)
    idempotencyKey: str = Field(min_length=1, max_length=256)
    expiresAt: int | None = None


class CloseRequest(BaseModel):
    volume: float = Field(gt=0)
    commandId: str = Field(min_length=1, max_length=256)


class ModifyRequest(BaseModel):
    stopLoss: float | None = Field(default=None, gt=0)
    takeProfit: float | None = Field(default=None, gt=0)
    commandId: str = Field(min_length=1, max_length=256)

    if model_validator is not None:

        @model_validator(mode="after")
        def require_protection_change(self) -> "ModifyRequest":
            if self.stopLoss is None and self.takeProfit is None:
                raise ValueError("At least one of stopLoss or takeProfit is required")
            return self

    else:

        @root_validator(skip_on_failure=True)
        def require_protection_change_v1(cls, values: dict[str, Any]) -> dict[str, Any]:
            if values.get("stopLoss") is None and values.get("takeProfit") is None:
                raise ValueError("At least one of stopLoss or takeProfit is required")
            return values
