export interface TrailingStopPlan {
  enabled: boolean;
  startAtR: number;
  mode: "ATR" | "TREND_STRUCTURE";
  atrMultiple: number;
  neverWidenStop: true;

  /**
   * XAUUSD price-unit gain from entry before trend trailing is armed.
   * Optional so legacy ATR plans remain source-compatible.
   */
  activateAtProfitPrice?: number;

  /**
   * XAUUSD price-unit gain from entry before swing/structure trailing
   * becomes the preferred trailing method.
   */
  structureTrailAtProfitPrice?: number;

  /**
   * Positive price distance locked beyond entry on first activation.
   */
  positiveLockPrice?: number;

  /**
   * ATR buffer placed beyond the latest confirmed protective swing.
   */
  swingBufferAtrMultiple?: number;

  /**
   * Minimum ATR distance the stop must keep from the current exit price.
   */
  minimumDistanceAtrMultiple?: number;
}