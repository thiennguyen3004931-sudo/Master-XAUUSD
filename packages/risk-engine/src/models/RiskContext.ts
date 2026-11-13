import type { SignalEngineResult } from "@xauusd/signal-engine";
import type { Account } from "@xauusd/types";
import type { InstrumentRiskSpec } from "./InstrumentRiskSpec";
import type { PortfolioRiskSnapshot } from "./PortfolioRiskSnapshot";

export interface RiskContext {
  signalResult: SignalEngineResult;
  account: Account;
  portfolio: PortfolioRiskSnapshot;
  instrument: InstrumentRiskSpec;
  evaluatedAt?: number;
}
