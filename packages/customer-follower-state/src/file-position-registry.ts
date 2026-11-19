import {
  link,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomerFollowerPositionRegistry } from "@xauusd/customer-agent";

interface RegistryFile {
  readonly version: 1;
  readonly bindings: Readonly<Record<string, string>>;
}

interface LockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
}

function canonical(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function parseRegistry(text: string): Map<string, string> {
  const parsed = JSON.parse(text) as Partial<RegistryFile>;
  if (
    parsed.version !== 1 ||
    parsed.bindings === null ||
    typeof parsed.bindings !== "object" ||
    Array.isArray(parsed.bindings)
  ) {
    throw new Error("FOLLOWER_POSITION_REGISTRY_INVALID");
  }

  const map = new Map<string, string>();
  for (const [masterPositionRef, followerTicket] of Object.entries(
    parsed.bindings,
  )) {
    if (!canonical(masterPositionRef) || !canonical(followerTicket)) {
      throw new Error("FOLLOWER_POSITION_REGISTRY_INVALID");
    }
    map.set(masterPositionRef, followerTicket);
  }
  return map;
}

function parseLockRecord(text: string): LockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Partial<LockRecord>;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    !canonical(record.token)
  ) {
    return undefined;
  }
  return {
    version: 1,
    pid: record.pid as number,
    token: record.token,
  };
}

function serializeLockRecord(token: string): string {
  return JSON.stringify({ version: 1, pid: process.pid, token } satisfies LockRecord);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Other errors,
    // including ESRCH, mean we cannot establish a live owner for this PID.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function serializeRegistry(bindings: ReadonlyMap<string, string>): string {
  return (
    JSON.stringify(
      {
        version: 1,
        bindings: Object.fromEntries(
          [...bindings.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      } satisfies RegistryFile,
      null,
      2,
    ) + "\n"
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 8) await delay(25 * attempt);
    }
  }
  throw lastError;
}

const STALE_LOCK_MS = 30_000;

export class FileCustomerFollowerPositionRegistry
  implements CustomerFollowerPositionRegistry
{
  private readonly lockPath: string;
  private readonly guardPath: string;
  private readonly guardReaperPath: string;

  constructor(private readonly filePath: string) {
    if (!canonical(filePath)) {
      throw new TypeError("filePath must be a canonical non-blank string");
    }
    this.lockPath = filePath + ".lock";
    this.guardPath = this.lockPath + ".guard";
    this.guardReaperPath = this.guardPath + ".reaper";
  }

  async get(masterPositionRef: string): Promise<string | undefined> {
    if (!canonical(masterPositionRef)) {
      throw new TypeError(
        "masterPositionRef must be a canonical non-blank string",
      );
    }
    const bindings = await this.readLatest();
    return bindings.get(masterPositionRef);
  }

  async set(masterPositionRef: string, followerTicket: string): Promise<void> {
    if (!canonical(masterPositionRef) || !canonical(followerTicket)) {
      throw new TypeError(
        "position binding values must be canonical non-blank strings",
      );
    }

    await this.mutate((bindings) => {
      bindings.set(masterPositionRef, followerTicket);
    });
  }

  async delete(masterPositionRef: string): Promise<void> {
    if (!canonical(masterPositionRef)) {
      throw new TypeError(
        "masterPositionRef must be a canonical non-blank string",
      );
    }

    await this.mutate((bindings) => {
      bindings.delete(masterPositionRef);
    });
  }

  private async readLatest(): Promise<Map<string, string>> {
    try {
      return parseRegistry(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return new Map();
      }
      throw error;
    }
  }

  private async readLockRecord(filePath: string): Promise<LockRecord | undefined> {
    try {
      return parseLockRecord(await readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private claimPath(filePath: string, record: LockRecord): string {
    return filePath + "." + record.pid + "." + record.token + ".claim";
  }

  private async createExclusiveLock(
    filePath: string,
    token: string,
  ): Promise<boolean> {
    const record = parseLockRecord(serializeLockRecord(token));
    if (!record) throw new Error("FOLLOWER_POSITION_REGISTRY_LOCK_RECORD_INVALID");

    const claimPath = this.claimPath(filePath, record);
    await writeFile(claimPath, serializeLockRecord(token), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    try {
      // Publish only a fully written owner record. link() is an atomic,
      // no-overwrite operation on the same filesystem.
      await link(claimPath, filePath);
    } catch (error) {
      await unlinkIfExists(claimPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw error;
    }

    // The published lock has its own hard link, so the private claim can go.
    await unlinkIfExists(claimPath).catch(() => undefined);
    return true;
  }

  private async mutate(
    change: (bindings: Map<string, string>) => void,
  ): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const release = await this.acquireLock();
    try {
      const current = await this.readLatest();
      const next = new Map(current);
      change(next);
      await this.persist(next);
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 80; attempt += 1) {
      const ownerToken = randomUUID();
      try {
        const acquired = await this.createExclusiveLock(this.lockPath, ownerToken);
        if (acquired) {
          return async () => {
            await this.withLockPathGuard(async () => {
              const current = await this.readLockRecord(this.lockPath);
              // A recovered lock may now belong to another process.
              if (
                current?.token !== ownerToken ||
                current.pid !== process.pid
              ) {
                return;
              }
              await unlinkIfExists(this.lockPath);
              await unlinkIfExists(this.claimPath(this.lockPath, current)).catch(() => undefined);
            });
          };
        }
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }

      const reclaimed = await this.reclaimStaleLock();
      if (reclaimed) continue;
      if (attempt < 80) await delay(25);
    }

    throw new Error("FOLLOWER_POSITION_REGISTRY_LOCK_TIMEOUT", {
      cause: lastError,
    });
  }

  private async reclaimStaleLock(): Promise<boolean> {
    let reclaimed = false;

    // Release and stale recovery share a guard. A lock is only reclaimable if
    // its recorded owner process is gone, not merely because it ran slowly.
    await this.withLockPathGuard(async () => {
      const record = await this.readLockRecord(this.lockPath);
      if (!record || processIsAlive(record.pid)) return;

      let lock;
      try {
        lock = await stat(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
        throw error;
      }
      if (Date.now() - lock.mtimeMs <= STALE_LOCK_MS) return;

      const verifiedRecord = await this.readLockRecord(this.lockPath);
      if (
        verifiedRecord?.token !== record.token ||
        verifiedRecord.pid !== record.pid ||
        processIsAlive(verifiedRecord.pid)
      ) {
        return;
      }
      const verifiedStat = await stat(this.lockPath);
      if (Date.now() - verifiedStat.mtimeMs <= STALE_LOCK_MS) return;

      await unlinkIfExists(this.lockPath);
      await unlinkIfExists(this.claimPath(this.lockPath, record)).catch(() => undefined);
      reclaimed = true;
    });

    return reclaimed;
  }

  private async withLockPathGuard<T>(
    action: () => Promise<T>,
  ): Promise<T> {
    const releaseGuard = await this.acquireGuard();
    try {
      return await action();
    } finally {
      await releaseGuard();
    }
  }

  private async acquireGuard(): Promise<() => Promise<void>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 80; attempt += 1) {
      const guardToken = randomUUID();
      try {
        const acquired = await this.createExclusiveLock(this.guardPath, guardToken);
        if (acquired) {
          return async () => {
            const current = await this.readLockRecord(this.guardPath);
            if (
              current?.token !== guardToken ||
              current.pid !== process.pid
            ) {
              return;
            }
            await unlinkIfExists(this.guardPath);
            await unlinkIfExists(this.claimPath(this.guardPath, current)).catch(() => undefined);
          };
        }
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }

      const reclaimed = await this.reclaimStaleGuard();
      if (reclaimed) continue;
      if (attempt < 80) await delay(25);
    }

    throw new Error("FOLLOWER_POSITION_REGISTRY_GUARD_TIMEOUT", {
      cause: lastError,
    });
  }

  private async reclaimStaleGuard(): Promise<boolean> {
    // This reaper claim intentionally has no automatic stale-recovery path:
    // if a process dies while holding it, mutations fail closed rather than
    // risking a second reaper deleting a replacement guard.
    const reaperToken = randomUUID();
    let claimed = false;

    try {
      claimed = await this.createExclusiveLock(
        this.guardReaperPath,
        reaperToken,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw error;
    }
    if (!claimed) return false;

    try {
      const record = await this.readLockRecord(this.guardPath);
      if (!record || processIsAlive(record.pid)) return false;

      let guard;
      try {
        guard = await stat(this.guardPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
      }
      if (Date.now() - guard.mtimeMs <= STALE_LOCK_MS) return false;

      const verifiedRecord = await this.readLockRecord(this.guardPath);
      if (
        verifiedRecord?.token !== record.token ||
        verifiedRecord.pid !== record.pid ||
        processIsAlive(verifiedRecord.pid)
      ) {
        return false;
      }
      const verifiedStat = await stat(this.guardPath);
      if (Date.now() - verifiedStat.mtimeMs <= STALE_LOCK_MS) return false;

      await unlinkIfExists(this.guardPath);
      await unlinkIfExists(this.claimPath(this.guardPath, record)).catch(() => undefined);
      return true;
    } finally {
      const reaperRecord = await this.readLockRecord(this.guardReaperPath);
      if (
        reaperRecord?.token === reaperToken &&
        reaperRecord.pid === process.pid
      ) {
        await unlinkIfExists(this.guardReaperPath);
        await unlinkIfExists(this.claimPath(this.guardReaperPath, reaperRecord)).catch(() => undefined);
      }
    }
  }

  private async persist(bindings: ReadonlyMap<string, string>): Promise<void> {
    const tempPath =
      this.filePath + "." + process.pid + "." + randomUUID() + ".tmp";

    try {
      await writeFile(tempPath, serializeRegistry(bindings), {
        encoding: "utf8",
        mode: 0o600,
      });
      await renameWithRetry(tempPath, this.filePath);
    } finally {
      try {
        await unlink(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}
