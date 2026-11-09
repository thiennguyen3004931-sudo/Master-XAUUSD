export type SupplyDemandZoneType = "SUPPLY" | "DEMAND";

export interface SupplyDemandZone {
  id: string;
  type: SupplyDemandZoneType;
  low: number;
  high: number;
  strength: number;
  active: boolean;
  touched: boolean;
  createdAt: number;
}