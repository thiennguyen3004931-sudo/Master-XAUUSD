import fs from "node:fs";
import path from "node:path";

export function acquireRuntimeSingleton({
  file,
  owner,
  pid = process.pid,
} = {}) {
  if (!file) throw new Error("Runtime singleton lock file is required.");
  if (!owner) throw new Error("Runtime singleton lock owner is required.");

  const lockPath = path.resolve(file);
  const normalizedPid = Number(pid);
  if (!Number.isSafeInteger(normalizedPid) || normalizedPid <= 0) {
    throw new Error("Runtime singleton lock pid must be a positive integer.");
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = `${normalizedPid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let descriptor = null;

    try {
      descriptor = fs.openSync(lockPath, "wx");
      const record = {
        version: 1,
        owner: String(owner),
        pid: normalizedPid,
        token,
        createdAt: Date.now(),
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.closeSync(descriptor);
      descriptor = null;

      let released = false;
      return {
        acquired: true,
        file: lockPath,
        owner: record.owner,
        pid: record.pid,
        token,
        release() {
          if (released) return;
          released = true;
          const current = readRuntimeSingleton(lockPath);
          if (current?.token !== token) return;
          try {
            fs.unlinkSync(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
        descriptor = null;
      }

      if (error?.code !== "EEXIST") {
        try {
          const current = readRuntimeSingleton(lockPath);
          if (current?.token === token) fs.unlinkSync(lockPath);
        } catch {}
        throw error;
      }

      const current = readRuntimeSingleton(lockPath);
      if (!validRuntimeSingletonRecord(current)) {
        return {
          acquired: false,
          file: lockPath,
          reason: "LOCK_BUSY_INVALID_OWNER_RECORD",
          current,
        };
      }

      if (pidIsAlive(current.pid)) {
        return {
          acquired: false,
          file: lockPath,
          reason: "LOCK_BUSY_LIVE_OWNER",
          current,
        };
      }

      if (attempt === 0) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code === "ENOENT") continue;
          return {
            acquired: false,
            file: lockPath,
            reason: "LOCK_BUSY_DEAD_OWNER_CANNOT_REMOVE",
            current,
          };
        }
      }
    }
  }

  return {
    acquired: false,
    file: lockPath,
    reason: "LOCK_BUSY",
    current: readRuntimeSingleton(lockPath),
  };
}

export function readRuntimeSingleton(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

function validRuntimeSingletonRecord(record) {
  return Boolean(
    record &&
    Number(record.version) === 1 &&
    typeof record.owner === "string" &&
    record.owner.trim() &&
    Number.isSafeInteger(Number(record.pid)) &&
    Number(record.pid) > 0 &&
    typeof record.token === "string" &&
    record.token.trim() &&
    Number.isFinite(Number(record.createdAt)) &&
    Number(record.createdAt) > 0,
  );
}

function pidIsAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but this process cannot signal it.
    // Unknown errors fail closed as a potentially live owner.
    return true;
  }
}
