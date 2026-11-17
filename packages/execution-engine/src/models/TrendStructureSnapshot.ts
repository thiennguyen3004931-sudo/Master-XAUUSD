export interface TrendStructureSnapshot {
  /**
   * True only when the current position direction is still supported
   * by the latest confirmed trend/market structure.
   */
  trendValid: boolean;

  /**
   * True only on an explicit confirmed structure break against
   * the held position direction.
   */
  structureBroken: boolean;

  latestSwingHigh?: number;
  latestSwingLow?: number;

  /**
   * Timestamp of the analysis snapshot used for management.
   */
  assessedAt?: number;
}