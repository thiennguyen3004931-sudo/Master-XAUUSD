// TEST-ONLY independent-directory authority fixture; not production-grade durability.
// The directory MUST NOT be included in customer SQLite backup/restore media.
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const denied = (reasonCode) => Object.freeze({ committed: false, decision: { ok: false, reasonCode } });
const validKey = (key) => typeof key === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(key);

/** Single-host synthetic fixture; lock failure, torn writes and malformed state deny. */
export class FileAuthorityFixture {
  constructor(directory) {
    if (typeof directory !== "string" || !directory) throw new TypeError("authority directory required");
    this.directory = directory;
  }

  async transact(bindingKey, callback) {
    if (!validKey(bindingKey) || typeof callback !== "function") return denied("AUTHORITY_FIXTURE_INVALID");
    const lock = join(this.directory, bindingKey + ".lock");
    const stateFile = join(this.directory, bindingKey + ".json");
    let locked = false;
    try {
      // A leftover temp file may represent an interrupted commit. Never auto-promote it.
      const entries = await readdir(this.directory);
      if (entries.some(name => name.startsWith(bindingKey + ".") && name.endsWith(".tmp"))) {
        return denied("AUTHORITY_FIXTURE_RECOVERY_REQUIRED");
      }
      const directoryStat = await lstat(this.directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return denied("AUTHORITY_FIXTURE_DIRECTORY_INVALID");
      // Caller provisions directory; never silently create a missing authority store.
      await mkdir(lock);
      locked = true;
      let previous;
      try {
        const stateStat = await lstat(stateFile);
        if (!stateStat.isFile() || stateStat.isSymbolicLink()) return denied("AUTHORITY_FIXTURE_STATE_INVALID");
        previous = JSON.parse(await readFile(stateFile, "utf8"));
      } catch {
        return denied("AUTHORITY_FIXTURE_STATE_UNAVAILABLE");
      }
      if (!previous || typeof previous !== "object" || Array.isArray(previous)) return denied("AUTHORITY_FIXTURE_STATE_INVALID");
      const proposal = await callback(previous);
      if (!proposal || proposal.commit !== true || proposal.decision?.ok !== true) {
        return { committed: false, decision: proposal?.decision ?? { ok: false, reasonCode: "AUTHORITY_FIXTURE_REJECTED" } };
      }
      const temp = join(this.directory, bindingKey + "." + randomUUID() + ".tmp");
      let handle;
      try {
        handle = await open(temp, "wx", 0o600);
        await handle.writeFile(JSON.stringify(proposal.next), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temp, stateFile);
        // Directory metadata flush may be unsupported; fail closed instead of claiming durability.
        const dir = await open(this.directory, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      } catch {
        if (handle) await handle.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
        return denied("AUTHORITY_FIXTURE_COMMIT_UNCERTAIN");
      }
      return { committed: true, decision: proposal.decision };
    } catch {
      return denied("AUTHORITY_FIXTURE_LOCK_UNAVAILABLE");
    } finally {
      if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }
}
