import fs from "node:fs";
import path from "node:path";

export function acquireExecutionLock({
  file = process.env.ZIQ_PHASE7C_EXECUTION_LOCK || path.resolve(".runtime", "phase7c-execution.lock"),
  owner,
  staleAfterMs = 30_000,
} = {}) {
  if (!owner) throw new Error("Phase 7C execution lock owner is required.");
  const lockPath = path.resolve(file);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const record = {
        version: 1,
        token,
        owner: String(owner),
        pid: process.pid,
        createdAt: Date.now(),
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.closeSync(descriptor);
      let released = false;
      return {
        acquired: true,
        file: lockPath,
        owner: record.owner,
        token,
        release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (current?.token === token) fs.unlinkSync(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readLock(lockPath);
      const ageMs = current ? Math.max(0, Date.now() - Number(current.createdAt || 0)) : Number.POSITIVE_INFINITY;
      if (attempt === 0 && ageMs > staleAfterMs) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") {
            return {
              acquired: false,
              file: lockPath,
              reason: "LOCK_BUSY_STALE_CANNOT_REMOVE",
              current,
              ageMs,
            };
          }
          continue;
        }
      }
      return {
        acquired: false,
        file: lockPath,
        reason: "LOCK_BUSY",
        current,
        ageMs,
      };
    }
  }

  return { acquired: false, file: lockPath, reason: "LOCK_BUSY" };
}

export function readExecutionLock(file = process.env.ZIQ_PHASE7C_EXECUTION_LOCK || path.resolve(".runtime", "phase7c-execution.lock")) {
  return readLock(path.resolve(file));
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}
