export interface OrderBlock {
  id?: string;
  high: number;
  low: number;
  bullish: boolean;
  mitigated: boolean;
  createdAt?: number;
}
