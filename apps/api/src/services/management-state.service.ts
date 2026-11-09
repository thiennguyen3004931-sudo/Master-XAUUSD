import {
  getExecutionStatePath,
} from "./execution-state.service.js";

import {
  SqliteManagementStateRepository,
} from "./sqlite-management-state.repository.js";

let repository:
  | SqliteManagementStateRepository
  | null = null;

export function getManagementStateRepository():
  SqliteManagementStateRepository {
  repository ??=
    new SqliteManagementStateRepository(
      getExecutionStatePath(),
    );

  return repository;
}

export function closeManagementStateRepository(): void {
  repository?.close();
  repository = null;
}