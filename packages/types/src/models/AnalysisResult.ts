import type { MarketStructure } from "../enums/MarketStructure";
import type { Trend } from "../enums/Trend";
import type { FairValueGap } from "./FairValueGap";
import type { LiquidityZone } from "./LiquidityZone";
import type { OrderBlock } from "./OrderBlock";
import type { SwingPoint } from "./SwingPoint";

/**
 * Shared analysis contract. Generic parameters avoid a dependency cycle with
 * @xauusd/market-data, which continues to own Candle and Timeframe.
 */
export interface AnalysisResult<TTimeframe = string, TCandle = unknown> {
  symbol: string;
  timeframe: TTimeframe;
  trend: Trend;
  structure: MarketStructure;
  lastCandle: TCandle | null;
  swings: SwingPoint[];
  internalSwings: SwingPoint[];
  externalSwings: SwingPoint[];
  liquidityZones: LiquidityZone[];
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  equalHighs: SwingPoint[];
  equalLows: SwingPoint[];
  premiumZone: number;
  discountZone: number;
  equilibrium: number;
  score: number;
  createdAt: number;
}
