import type { SignalContext, SignalEngineResult } from "../models";

export interface ISignalEngine {
  generate(context: SignalContext): SignalEngineResult;
}
