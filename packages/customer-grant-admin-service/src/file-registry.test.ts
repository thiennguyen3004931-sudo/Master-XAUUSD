import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCustomerProductGrantLifecycle,
  revokeCustomerProductGrant,
  type CustomerProductGrant,
} from "@xauusd/customer-product-access";
import {
  FileCustomerGrantRegistryRepository,
  CustomerGrantRegistryPersistenceError,
} from "./file-registry.js";

const NOW = 6_000_000;
const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "xauusd-grant-registry-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  while (roots.length > 0) {
    const value = roots.pop();
    if (value) {
      await rm(value, { recursive: true, force: true });
    }
  }
});

function grant(overrides: Partial<CustomerProductGrant> = {}): CustomerProductGrant {
  return {
    version: 1,
    grantId: "grant-persist-001",
    licenseId: "license-persist-001",
    customerId: "customer-persist-001",
    productMode: "SELF_MANAGED",
    installationId: "install-persist-001",
    allowedBotModes: ["PAUSE", "AUTO"],
    allowedCopySizingModes: [],
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
    ...overrides,
  };
}

describe("FileCustomerGrantRegistryRepository", () => {
  it("persists revision 1 across repository instances", async () => {
    const directory = await root();
    const first = new FileCustomerGrantRegistryRepository(directory);
    const record = createCustomerProductGrantLifecycle(grant());

    await expect(
      first.compareAndSet(record.grant.grantId, null, record),
    ).resolves.toBe(true);

    const restarted = new FileCustomerGrantRegistryRepository(directory);
    await expect(restarted.get(record.grant.grantId)).resolves.toEqual(record);
  });

  it("persists revocation as an immutable second snapshot", async () => {
    const directory = await root();
    const repository = new FileCustomerGrantRegistryRepository(directory);
    const active = createCustomerProductGrantLifecycle(grant());
    const revoked = revokeCustomerProductGrant(active, NOW);

    expect(
      await repository.compareAndSet(active.grant.grantId, null, active),
    ).toBe(true);
    expect(
      await repository.compareAndSet(
        active.grant.grantId,
        active.revision,
        revoked,
      ),
    ).toBe(true);

    const restarted = new FileCustomerGrantRegistryRepository(directory);
    await expect(restarted.get(active.grant.grantId)).resolves.toMatchObject({
      status: "REVOKED",
      revokedAt: NOW,
      revision: 2,
    });
  });

  it("allows only one concurrent writer for the same next revision", async () => {
    const directory = await root();
    const setup = new FileCustomerGrantRegistryRepository(directory);
    const active = createCustomerProductGrantLifecycle(grant());
    expect(
      await setup.compareAndSet(active.grant.grantId, null, active),
    ).toBe(true);

    const next = revokeCustomerProductGrant(active, NOW);
    const left = new FileCustomerGrantRegistryRepository(directory);
    const right = new FileCustomerGrantRegistryRepository(directory);

    const results = await Promise.all([
      left.compareAndSet(active.grant.grantId, 1, next),
      right.compareAndSet(active.grant.grantId, 1, next),
    ]);

    expect(results.sort()).toEqual([false, true]);

    const restarted = new FileCustomerGrantRegistryRepository(directory);
    await expect(restarted.get(active.grant.grantId)).resolves.toMatchObject({
      revision: 2,
      status: "REVOKED",
    });
  });

  it("lists only latest revisions in deterministic grant order", async () => {
    const directory = await root();
    const repository = new FileCustomerGrantRegistryRepository(directory);
    const z = createCustomerProductGrantLifecycle(
      grant({ grantId: "grant-z" }),
    );
    const a = createCustomerProductGrantLifecycle(
      grant({ grantId: "grant-a" }),
    );

    expect(await repository.compareAndSet(z.grant.grantId, null, z)).toBe(true);
    expect(await repository.compareAndSet(a.grant.grantId, null, a)).toBe(true);

    const revokedZ = revokeCustomerProductGrant(z, NOW);
    expect(
      await repository.compareAndSet(z.grant.grantId, 1, revokedZ),
    ).toBe(true);

    const records = await repository.list();
    expect(records.map((record) => record.grant.grantId)).toEqual([
      "grant-a",
      "grant-z",
    ]);
    expect(records[1].revision).toBe(2);
  });

  it("fails closed when a final snapshot is malformed", async () => {
    const directory = await root();
    const record = createCustomerProductGrantLifecycle(grant());
    const repository = new FileCustomerGrantRegistryRepository(directory);
    expect(
      await repository.compareAndSet(record.grant.grantId, null, record),
    ).toBe(true);

    const hash = createHash("sha256")
      .update(record.grant.grantId, "utf8")
      .digest("hex");
    const path = join(directory, `${hash}.r000000000001.json`);
    const original = await readFile(path, "utf8");
    expect(original.length).toBeGreaterThan(0);
    await writeFile(path, "{not-json", "utf8");

    await expect(repository.get(record.grant.grantId)).rejects.toMatchObject({
      name: "CustomerGrantRegistryPersistenceError",
      code: "CORRUPT_SNAPSHOT",
    } satisfies Partial<CustomerGrantRegistryPersistenceError>);
  });

  it("rejects revision jumps before creating a new snapshot", async () => {
    const directory = await root();
    const repository = new FileCustomerGrantRegistryRepository(directory);
    const active = createCustomerProductGrantLifecycle(grant());
    expect(
      await repository.compareAndSet(active.grant.grantId, null, active),
    ).toBe(true);

    const invalid = {
      ...revokeCustomerProductGrant(active, NOW),
      revision: 3,
    };

    await expect(
      repository.compareAndSet(active.grant.grantId, 1, invalid),
    ).rejects.toThrow(/advance exactly one revision/);
  });
});
