export interface LiquidityZone {
  id?: string;
  price: number;
  upperBound?: number;
  lowerBound?: number;
  strength: number;
  touched: boolean;
  createdAt?: number;
}
