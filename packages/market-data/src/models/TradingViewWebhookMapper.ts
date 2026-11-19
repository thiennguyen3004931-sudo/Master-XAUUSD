import type { Candle } from "../entities/Candle";
import { Timeframe } from "../entities/Timeframe";
import type { TradingViewWebhookPayload } from "./TradingViewWebhookPayload";

export class TradingViewWebhookMapper {
  static toCandle(payload: TradingViewWebhookPayload): Candle {
    const timeframe = this.parseTimeframe(payload.timeframe);

    return {
      symbol: payload.symbol.trim().toUpperCase(),
      timeframe,
      openTime: payload.openTime,
      closeTime: payload.closeTime,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      close: payload.close,
      volume: payload.volume,
      spread: payload.spread,
    };
  }

  private static parseTimeframe(value: string): Timeframe {
    const normalized = value.trim().toUpperCase();
    const timeframe = Object.values(Timeframe).find(
      (candidate) => candidate === normalized,
    );

    if (!timeframe) {
      throw new Error(`Unsupported timeframe: ${value}`);
    }

    return timeframe;
  }
}
