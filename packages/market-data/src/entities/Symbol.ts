/** String symbol used by market-data providers, for example XAUUSD. */
export type Symbol = string;

export interface SymbolInfo {
  name: string;
  digits: number;
  point: number;
  contractSize: number;
  baseCurrency: string;
  quoteCurrency: string;
}
