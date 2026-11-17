export interface SymbolExecutionSpec {
  symbol: string;
  tickSize: number;
  digits: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  maxSpread: number;
  stopsLevelTicks: number;
  freezeLevelTicks: number;
}
