import type { IExecutionEngine } from "../contracts";
import type {
  ExecutionEngineResult,
  ExecutionRequest,
} from "../models";

export class ExecutionService {
  constructor(private readonly engine: IExecutionEngine) {}

  execute(
    request: ExecutionRequest,
  ): Promise<ExecutionEngineResult> {
    return this.engine.execute(request);
  }
}
