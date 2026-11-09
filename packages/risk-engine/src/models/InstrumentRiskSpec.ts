export interface InstrumentRiskSpec {
  symbol: string;
  tickSize: number;
  tickValuePerLot: number;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  maxSpread: number;
  priceDigits?: number;
}
