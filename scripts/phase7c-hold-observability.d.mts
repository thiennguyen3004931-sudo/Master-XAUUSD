export interface CanonicalHoldReason {
  readonly reasonCode: string;
  readonly reason: string;
}

export type Phase7CHoldStrategy =
  | "TREND"
  | "SIDEWAY";

export declare const CANONICAL_HOLD_REASONS:
  Readonly<Record<
    "TREND" | "SIDEWAY" | "RECOVERY_TP",
    CanonicalHoldReason
  >>;

export declare function canonicalHoldReason(
  strategy:
    | Phase7CHoldStrategy
    | string
    | null
    | undefined,
  managedOrMode?:
    | {
        dailyMode?: string | null;
      }
    | string
    | null,
): CanonicalHoldReason | null;
