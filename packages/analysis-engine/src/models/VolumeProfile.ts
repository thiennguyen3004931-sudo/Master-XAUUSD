export interface VolumeProfileNode {
  low: number;
  high: number;
  price: number;
  volume: number;
  share: number;
}

export interface VolumeProfile {
  poc: number;
  hvn: VolumeProfileNode[];
  lvn: VolumeProfileNode[];
  nodes: VolumeProfileNode[];
  rangeLow: number;
  rangeHigh: number;
  totalVolume: number;
  lookback: number;
  createdAt: number;
}