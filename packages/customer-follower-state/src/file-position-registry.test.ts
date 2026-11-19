import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCustomerFollowerPositionRegistry } from "./file-position-registry.js";

const roots: string[] = [];

async function tempFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xauusd-follower-registry-"));
  roots.push(root);
  return path.join(root, "state", "positions.json");
}

async function removeWithRetry(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }
  throw lastError;
}

afterEach(async () => {
  const pending = roots.splice(0);
  for (const root of pending) {
    await removeWithRetry(root);
  }
});

describe("FileCustomerFollowerPositionRegistry", () => {
  it("survives restart and preserves master-to-follower ticket ownership", async () => {
    const file = await tempFile();
    const first = new FileCustomerFollowerPositionRegistry(file);

    await first.set("master-001", "ticket-9001");
    await first.set("master-002", "ticket-9002");

    const second = new FileCustomerFollowerPositionRegistry(file);
    await expect(second.get("master-001")).resolves.toBe("ticket-9001");
    await expect(second.get("master-002")).resolves.toBe("ticket-9002");

    await second.delete("master-001");

    const third = new FileCustomerFollowerPositionRegistry(file);
    await expect(third.get("master-001")).resolves.toBeUndefined();
    await expect(third.get("master-002")).resolves.toBe("ticket-9002");
  });

  it("serializes concurrent writers without losing bindings", async () => {
    const file = await tempFile();
    const first = new FileCustomerFollowerPositionRegistry(file);
    const second = new FileCustomerFollowerPositionRegistry(file);

    await Promise.all([
      first.set("master-a", "ticket-a"),
      second.set("master-b", "ticket-b"),
    ]);

    const restarted = new FileCustomerFollowerPositionRegistry(file);
    await expect(restarted.get("master-a")).resolves.toBe("ticket-a");
    await expect(restarted.get("master-b")).resolves.toBe("ticket-b");
  });

  it("recovers a stale lock left behind by a crashed process", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    const lockPath = file + ".lock";
    await writeFile(
      lockPath,
      JSON.stringify({ version: 1, pid: 2_147_483_647, token: "stale" }),
      "utf8",
    );
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    const registry = new FileCustomerFollowerPositionRegistry(file);
    await registry.set("master-stale", "ticket-stale");

    await expect(registry.get("master-stale")).resolves.toBe("ticket-stale");
  });

  it("does not let a stale owner's release remove its replacement lock", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    const registry = new FileCustomerFollowerPositionRegistry(file);
    const internal = registry as unknown as {
      acquireLock: () => Promise<() => Promise<void>>;
    };
    let release: (() => Promise<void>) | undefined;

    try {
      release = await internal.acquireLock();
      const lockPath = file + ".lock";
      await unlink(lockPath);
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          token: "replacement-owner",
        }),
        "utf8",
      );

      await release();
      release = undefined;

      const replacement = JSON.parse(await readFile(lockPath, "utf8")) as {
        token: string;
      };
      expect(replacement.token).toBe("replacement-owner");
    } finally {
      if (release) await release().catch(() => undefined);
    }
  });

  it("does not reclaim a stale lock while its owner process is still alive", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    const registry = new FileCustomerFollowerPositionRegistry(file);
    const internal = registry as unknown as {
      acquireLock: () => Promise<() => Promise<void>>;
      reclaimStaleLock: () => Promise<boolean>;
    };
    let release: (() => Promise<void>) | undefined;

    try {
      release = await internal.acquireLock();
      const lockPath = file + ".lock";
      const stale = new Date(Date.now() - 60_000);
      await utimes(lockPath, stale, stale);

      await expect(internal.reclaimStaleLock()).resolves.toBe(false);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
        pid: process.pid,
      });
    } finally {
      if (release) await release().catch(() => undefined);
    }
  });

  it("writes versioned deterministic JSON without leaking unrelated data", async () => {
    const file = await tempFile();
    const registry = new FileCustomerFollowerPositionRegistry(file);

    await registry.set("master-b", "ticket-b");
    await registry.set("master-a", "ticket-a");

    const text = await readFile(file, "utf8");
    expect(text).toContain('"version": 1');
    expect(text.indexOf("master-a")).toBeLessThan(text.indexOf("master-b"));
    expect(text).not.toContain("apiToken");
    expect(text).not.toContain("privateKey");
  });

  it("fails closed on corrupt or non-canonical persisted state", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        bindings: { " master-001": "ticket-9001" },
      }),
      "utf8",
    );

    const registry = new FileCustomerFollowerPositionRegistry(file);
    await expect(registry.get("master-001")).rejects.toThrow(
      "FOLLOWER_POSITION_REGISTRY_INVALID",
    );
  });

  it("validates binding inputs before persistence", async () => {
    const file = await tempFile();
    const registry = new FileCustomerFollowerPositionRegistry(file);

    await expect(registry.set(" master", "ticket")).rejects.toThrow(
      "position binding values must be canonical",
    );
    await expect(registry.set("master", "")).rejects.toThrow(
      "position binding values must be canonical",
    );
  });
});
