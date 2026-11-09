import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import type { CustomerGrantRegistryRepository } from "@xauusd/customer-grant-registry";
import {
  assertCustomerProductGrantLifecycleRecord,
  type CustomerProductGrantLifecycleRecord,
} from "@xauusd/customer-product-access";

const SNAPSHOT_PATTERN = /^([0-9a-f]{64})\.r([0-9]{12})\.json$/;

export class CustomerGrantRegistryPersistenceError extends Error {
  constructor(
    readonly code:
      | "CORRUPT_SNAPSHOT"
      | "INVALID_ROOT_DIRECTORY"
      | "PERSISTENCE_IO_ERROR",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CustomerGrantRegistryPersistenceError";
  }
}

function assertCanonicalNonBlankString(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a canonical non-blank string`);
  }
}

function hashGrantId(grantId: string): string {
  return createHash("sha256").update(grantId, "utf8").digest("hex");
}

function revisionToken(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new TypeError("revision must be a positive safe integer");
  }
  return String(revision).padStart(12, "0");
}

function snapshotName(grantId: string, revision: number): string {
  return `${hashGrantId(grantId)}.r${revisionToken(revision)}.json`;
}

function parseSnapshotName(
  name: string,
): { readonly hash: string; readonly revision: number } | null {
  const match = SNAPSHOT_PATTERN.exec(name);
  if (!match) return null;

  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    return null;
  }

  return { hash: match[1], revision };
}

function cloneLifecycle(
  record: CustomerProductGrantLifecycleRecord,
): CustomerProductGrantLifecycleRecord {
  assertCustomerProductGrantLifecycleRecord(record);

  return Object.freeze({
    version: 1,
    grant: Object.freeze({
      ...record.grant,
      allowedBotModes: Object.freeze([...record.grant.allowedBotModes]),
      allowedCopySizingModes: Object.freeze([
        ...record.grant.allowedCopySizingModes,
      ]),
    }),
    status: record.status,
    revokedAt: record.revokedAt,
    revision: record.revision,
  });
}

function ioError(
  operation: string,
  error: unknown,
): CustomerGrantRegistryPersistenceError {
  return new CustomerGrantRegistryPersistenceError(
    "PERSISTENCE_IO_ERROR",
    `customer grant registry persistence failed during ${operation}`,
    { cause: error },
  );
}

async function ignoreMissingUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export class FileCustomerGrantRegistryRepository
  implements CustomerGrantRegistryRepository
{
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (
      typeof rootDirectory !== "string" ||
      rootDirectory.trim().length === 0 ||
      rootDirectory.trim() !== rootDirectory
    ) {
      throw new CustomerGrantRegistryPersistenceError(
        "INVALID_ROOT_DIRECTORY",
        "rootDirectory must be a canonical non-blank path",
      );
    }

    this.rootDirectory = resolve(rootDirectory);
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.rootDirectory, { recursive: true });
    } catch (error) {
      throw ioError("mkdir", error);
    }
  }

  private async readSnapshot(
    name: string,
  ): Promise<CustomerProductGrantLifecycleRecord> {
    const parsedName = parseSnapshotName(name);
    if (!parsedName) {
      throw new CustomerGrantRegistryPersistenceError(
        "CORRUPT_SNAPSHOT",
        `invalid snapshot filename: ${name}`,
      );
    }

    let raw: string;
    try {
      raw = await readFile(join(this.rootDirectory, name), "utf8");
    } catch (error) {
      throw ioError("read snapshot", error);
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
      assertCustomerProductGrantLifecycleRecord(value);
    } catch (error) {
      throw new CustomerGrantRegistryPersistenceError(
        "CORRUPT_SNAPSHOT",
        `invalid lifecycle snapshot: ${name}`,
        { cause: error },
      );
    }

    if (
      hashGrantId(value.grant.grantId) !== parsedName.hash ||
      value.revision !== parsedName.revision
    ) {
      throw new CustomerGrantRegistryPersistenceError(
        "CORRUPT_SNAPSHOT",
        `snapshot identity mismatch: ${name}`,
      );
    }

    return cloneLifecycle(value);
  }

  private async snapshotNames(): Promise<readonly string[]> {
    await this.ensureRoot();

    let names: string[];
    try {
      names = await readdir(this.rootDirectory);
    } catch (error) {
      throw ioError("list snapshots", error);
    }

    return names.filter((name) => SNAPSHOT_PATTERN.test(name)).sort();
  }

  private async readHistory(
    grantId: string,
  ): Promise<readonly CustomerProductGrantLifecycleRecord[]> {
    assertCanonicalNonBlankString(grantId, "grantId");
    const expectedHash = hashGrantId(grantId);
    const names = (await this.snapshotNames())
      .map((name) => ({ name, parsed: parseSnapshotName(name) }))
      .filter(
        (
          item,
        ): item is {
          readonly name: string;
          readonly parsed: { readonly hash: string; readonly revision: number };
        } => item.parsed !== null && item.parsed.hash === expectedHash,
      )
      .sort((left, right) => left.parsed.revision - right.parsed.revision);

    const history: CustomerProductGrantLifecycleRecord[] = [];
    for (const item of names) {
      const record = await this.readSnapshot(item.name);
      if (record.grant.grantId !== grantId) {
        throw new CustomerGrantRegistryPersistenceError(
          "CORRUPT_SNAPSHOT",
          `snapshot grantId hash collision or tamper detected: ${item.name}`,
        );
      }
      history.push(record);
    }

    for (let index = 0; index < history.length; index++) {
      const expectedRevision = index + 1;
      if (history[index].revision !== expectedRevision) {
        throw new CustomerGrantRegistryPersistenceError(
          "CORRUPT_SNAPSHOT",
          `non-contiguous lifecycle history for grantId ${grantId}`,
        );
      }

      if (
        index > 0 &&
        JSON.stringify(history[index].grant) !==
          JSON.stringify(history[0].grant)
      ) {
        throw new CustomerGrantRegistryPersistenceError(
          "CORRUPT_SNAPSHOT",
          `grant identity changed across lifecycle revisions for ${grantId}`,
        );
      }
    }

    return history;
  }

  async get(
    grantId: string,
  ): Promise<CustomerProductGrantLifecycleRecord | null> {
    const history = await this.readHistory(grantId);
    const latest = history.at(-1);
    return latest ? cloneLifecycle(latest) : null;
  }

  async list(): Promise<readonly CustomerProductGrantLifecycleRecord[]> {
    const names = await this.snapshotNames();
    const hashes = [
      ...new Set(
        names
          .map(parseSnapshotName)
          .filter(
            (
              item,
            ): item is {
              readonly hash: string;
              readonly revision: number;
            } => item !== null,
          )
          .map((item) => item.hash),
      ),
    ].sort();

    const latest: CustomerProductGrantLifecycleRecord[] = [];

    for (const hash of hashes) {
      const hashNames = names
        .map((name) => ({ name, parsed: parseSnapshotName(name) }))
        .filter(
          (
            item,
          ): item is {
            readonly name: string;
            readonly parsed: {
              readonly hash: string;
              readonly revision: number;
            };
          } => item.parsed !== null && item.parsed.hash === hash,
        )
        .sort((left, right) => left.parsed.revision - right.parsed.revision);

      if (hashNames.length === 0) continue;

      const records: CustomerProductGrantLifecycleRecord[] = [];
      for (const item of hashNames) {
        records.push(await this.readSnapshot(item.name));
      }

      const grantId = records[0].grant.grantId;
      const expectedHistory = await this.readHistory(grantId);
      const last = expectedHistory.at(-1);
      if (last) latest.push(last);
    }

    return Object.freeze(
      latest
        .sort((left, right) =>
          left.grant.grantId.localeCompare(right.grant.grantId),
        )
        .map(cloneLifecycle),
    );
  }

  async compareAndSet(
    grantId: string,
    expectedRevision: number | null,
    next: CustomerProductGrantLifecycleRecord,
  ): Promise<boolean> {
    assertCanonicalNonBlankString(grantId, "grantId");
    assertCustomerProductGrantLifecycleRecord(next);

    if (next.grant.grantId !== grantId) {
      throw new TypeError("repository grantId must match lifecycle grantId");
    }

    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
    ) {
      throw new TypeError(
        "expectedRevision must be null or a positive safe integer",
      );
    }

    const current = await this.get(grantId);
    const expectedNextRevision =
      expectedRevision === null ? 1 : expectedRevision + 1;

    if (expectedRevision === null) {
      if (current !== null) return false;
    } else if (current === null || current.revision !== expectedRevision) {
      return false;
    }

    if (next.revision !== expectedNextRevision) {
      throw new TypeError(
        "next lifecycle revision must advance exactly one revision",
      );
    }

    await this.ensureRoot();

    const finalPath = join(
      this.rootDirectory,
      snapshotName(grantId, next.revision),
    );
    const tempPath = join(
      this.rootDirectory,
      `.${hashGrantId(grantId)}.r${revisionToken(next.revision)}.${process.pid}.${randomUUID()}.tmp`,
    );

    const payload = `${JSON.stringify(next)}\n`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      try {
        await link(tempPath, finalPath);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          return false;
        }
        throw error;
      }

      const persisted = await this.readSnapshot(
        snapshotName(grantId, next.revision),
      );

      if (
        persisted.revision !== next.revision ||
        persisted.grant.grantId !== grantId
      ) {
        throw new CustomerGrantRegistryPersistenceError(
          "CORRUPT_SNAPSHOT",
          "persisted lifecycle snapshot failed identity verification",
        );
      }

      return true;
    } catch (error) {
      if (error instanceof CustomerGrantRegistryPersistenceError) {
        throw error;
      }
      throw ioError("compare-and-set", error);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Best-effort close before cleanup.
        }
      }
      try {
        await ignoreMissingUnlink(tempPath);
      } catch {
        // Temporary cleanup failure must not rewrite or delete final snapshots.
      }
    }
  }
}
