import { TradingSession } from "@xauusd/types";

/**
 * Approximate UTC session classifier. Production execution should prefer an
 * explicit session supplied by the market-data layer because DST and broker
 * schedules vary.
 */
export class SessionClassifier {
  classify(timestamp: number): TradingSession {
    const hour = new Date(timestamp).getUTCHours();
    if (hour >= 0 && hour < 7) return TradingSession.ASIAN;
    if (hour >= 7 && hour < 12) return TradingSession.LONDON;
    if (hour >= 12 && hour < 16) return TradingSession.OVERLAP;
    if (hour >= 16 && hour < 22) return TradingSession.NEW_YORK;
    return TradingSession.CLOSED;
  }
}
