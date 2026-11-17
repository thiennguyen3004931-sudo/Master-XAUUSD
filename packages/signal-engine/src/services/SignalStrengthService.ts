import { SignalStrength } from "@xauusd/types";

export class SignalStrengthService {
  fromConfidence(confidence: number): SignalStrength {
    if (confidence >= 85) return SignalStrength.VERY_STRONG;
    if (confidence >= 75) return SignalStrength.STRONG;
    if (confidence >= 65) return SignalStrength.NORMAL;
    if (confidence >= 55) return SignalStrength.WEAK;
    return SignalStrength.VERY_WEAK;
  }
}
