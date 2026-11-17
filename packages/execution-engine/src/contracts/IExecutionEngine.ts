import type {
  ExecutionEngineResult,
  ExecutionRequest,
} from "../models";

export interface IExecutionEngine {
  execute(request: ExecutionRequest): Promise<ExecutionEngineResult>;
}
