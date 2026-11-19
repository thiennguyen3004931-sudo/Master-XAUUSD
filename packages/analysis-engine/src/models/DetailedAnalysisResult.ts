import type { Candle, Timeframe } from "@xauusd/market-data";
import type { AnalysisResult } from "@xauusd/types";
import type { AnalysisMetrics } from "./AnalysisMetrics";
import type { StructureEvent } from "./StructureEvent";
import type { SupplyDemandZone } from "./SupplyDemandZone";
import type { VolumeProfile } from "./VolumeProfile";

export interface DetailedAnalysisResult
  extends AnalysisResult<Timeframe, Candle> {
  metrics: AnalysisMetrics;
  structureEvents: StructureEvent[];
  supplyDemandZones?: SupplyDemandZone[];
  volumeProfile?: VolumeProfile;
}