import { getExecutionStatePath } from "./execution-state.service";
import { Phase7CSemiAdoptionStateRepository } from "./phase7c-semi-adoption-state.service";

let repository: Phase7CSemiAdoptionStateRepository | null = null;

export function getPhase7CSemiAdoptionStateRepository(): Phase7CSemiAdoptionStateRepository {
  repository ??= new Phase7CSemiAdoptionStateRepository(getExecutionStatePath());
  return repository;
}

export function closePhase7CSemiAdoptionStateRepository(): void {
  repository?.close();
  repository = null;
}
