import { TradingSession } from "@xauusd/types";

export interface TradingSessionHours {
  asianStartUtc: number;
  asianEndUtc: number;
  londonStartUtc: number;
  londonEndUtc: number;
  newYorkStartUtc: number;
  newYorkEndUtc: number;
}

const DEFAULT_HOURS: TradingSessionHours = {
  asianStartUtc: 0,
  asianEndUtc: 9,
  londonStartUtc: 7,
  londonEndUtc: 16,
  newYorkStartUtc: 12,
  newYorkEndUtc: 21,
};

export class SessionService {
  constructor(private readonly hours: TradingSessionHours = DEFAULT_HOURS) {}

  getSession(date: Date = new Date()): TradingSession {
    const hour = date.getUTCHours();
    const inLondon = this.inRange(
      hour,
      this.hours.londonStartUtc,
      this.hours.londonEndUtc,
    );
    const inNewYork = this.inRange(
      hour,
      this.hours.newYorkStartUtc,
      this.hours.newYorkEndUtc,
    );

    if (inLondon && inNewYork) {
      return TradingSession.OVERLAP;
    }

    if (inLondon) {
      return TradingSession.LONDON;
    }

    if (inNewYork) {
      return TradingSession.NEW_YORK;
    }

    if (
      this.inRange(hour, this.hours.asianStartUtc, this.hours.asianEndUtc)
    ) {
      return TradingSession.ASIAN;
    }

    return TradingSession.CLOSED;
  }

  isTradable(date: Date = new Date()): boolean {
    return this.getSession(date) !== TradingSession.CLOSED;
  }

  private inRange(hour: number, start: number, end: number): boolean {
    if (start <= end) {
      return hour >= start && hour < end;
    }

    return hour >= start || hour < end;
  }
}
