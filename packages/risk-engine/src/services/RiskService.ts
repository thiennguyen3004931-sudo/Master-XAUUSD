import type { IRiskEngine } from "../contracts";
import type { RiskAssessment, RiskContext } from "../models";
import { RiskPipeline } from "../pipeline";

export class RiskService {
  constructor(
    private readonly engine: IRiskEngine = new RiskPipeline(),
  ) {}

  evaluate(context: RiskContext): RiskAssessment {
    return this.engine.evaluate(context);
  }
}
