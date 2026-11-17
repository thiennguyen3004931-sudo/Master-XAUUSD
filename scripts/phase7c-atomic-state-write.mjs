import fs from "node:fs";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(milliseconds) {
  const delay = Math.max(0, Number(milliseconds) || 0);
  if (delay <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, delay);
}

function defaultTempPath(targetPath) {
  return `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

export function writeStateFileAtomicSync(
  targetPath,
  content,
  {
    fsImpl = fs,
    maxAttempts = 6,
    retryDelayMs = 100,
    tempPathFactory = defaultTempPath,
    sleep = sleepSync,
  } = {},
) {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    throw new Error("Atomic state target path is required.");
  }
  const attempts = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  const tempPath = tempPathFactory(targetPath);

  fsImpl.writeFileSync(tempPath, content, "utf8");

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        fsImpl.renameSync(tempPath, targetPath);
        return {
          targetPath,
          attempts: attempt,
          recoveredFromTransientRename: attempt > 1,
        };
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
        const retryable = RETRYABLE_RENAME_CODES.has(code);
        if (!retryable || attempt >= attempts) {
          throw error;
        }
        sleep(retryDelayMs);
      }
    }
  } finally {
    try {
      fsImpl.unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Best-effort temp cleanup only. Never delete/replace the canonical target here.
      }
    }
  }

  throw new Error("Atomic state rename exhausted unexpectedly.");
}

export const __test = {
  RETRYABLE_RENAME_CODES,
  defaultTempPath,
};
