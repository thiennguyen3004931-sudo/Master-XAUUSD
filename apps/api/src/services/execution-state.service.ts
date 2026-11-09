import { dirname, basename, resolve } from "node:path";

import { SqliteExecutionRepository } from "./sqlite-execution.repository.js";

let repository: SqliteExecutionRepository | null = null;

export function getExecutionStatePath(): string {
  const configured = process.env.EXECUTION_STATE_DB_PATH?.trim();

  if (configured) {
    return resolve(configured);
  }

  const cwd = process.cwd();
  const runningFromApiPackage =
    basename(cwd).toLowerCase() === "api" &&
    basename(dirname(cwd)).toLowerCase() === "apps";

  return runningFromApiPackage
    ? resolve(cwd, "data", "execution-state.sqlite3")
    : resolve(cwd, "apps", "api", "data", "execution-state.sqlite3");
}

export function getExecutionRepository(): SqliteExecutionRepository {
  repository ??= new SqliteExecutionRepository(getExecutionStatePath());
  return repository;
}

export function closeExecutionRepository(): void {
  repository?.close();
  repository = null;
}