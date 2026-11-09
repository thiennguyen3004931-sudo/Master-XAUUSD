export interface Mt5BridgeSymbolSpec {
  symbol: string;
  brokerSymbol: string;
  tickSize: number;
  point: number;
  tickValuePerLot: number;
  effectiveTickValuePerLot: number;
  cashPerPriceUnitPerLot: number;
  riskValueSource: "MT5_ORDER_CALC_PROFIT";
  tickValueProfitPerLot: number;
  tickValueLossPerLot: number;
  contractSize: number;
  digits: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  maxSpread: number;
  stopsLevelTicks: number;
  freezeLevelTicks: number;
  fillingMode: number;
  executionMode: number;
}
