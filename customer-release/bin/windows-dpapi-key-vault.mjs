// Windows CurrentUser DPAPI primitive used by the new-installation identity contract.
// Real-customer migration, ACL audit and release acceptance remain separately blocked.
// The sensitive buffer crosses a local stdin/stdout pipe, never shell arguments or logs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const prefix = "XAUUSD_DPAPI_CURRENT_USER_V1:";
const script = fileURLToPath(new URL("./windows-dpapi-key-vault.ps1", import.meta.url));

function assertBytes(value) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 65536) {
    throw new Error("CUSTOMER_DPAPI_INPUT_INVALID");
  }
}
function decodeCanonicalBase64(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new Error("CUSTOMER_DPAPI_BASE64_INVALID");
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.length < 1 || bytes.length > 65536 || bytes.toString("base64") !== text) {
    throw new Error("CUSTOMER_DPAPI_BASE64_INVALID");
  }
  return bytes;
}
async function invokePowerShell(operation, data) {
  if (process.platform !== "win32") {
    throw new Error("CUSTOMER_DPAPI_WINDOWS_ONLY");
  }
  assertBytes(data);
  return new Promise((resolve, reject) => {
    let done = false;
    let stdout = "";
    let stdoutTooLong = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(value);
    };
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", path.resolve(script), "-Operation", operation,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 98304) {
        stdoutTooLong = true;
        child.kill();
      }
    });
    // Never attach a log sink for PowerShell stderr: cryptographic errors remain private.
    child.stderr.resume();
    child.on("error", () => finish(new Error("CUSTOMER_DPAPI_PROCESS_FAILED")));
    child.on("close", (code) => {
      if (code !== 0 || stdoutTooLong) {
        finish(new Error("CUSTOMER_DPAPI_OPERATION_FAILED"));
        return;
      }
      try { finish(null, decodeCanonicalBase64(stdout.trim())); }
      catch { finish(new Error("CUSTOMER_DPAPI_OUTPUT_INVALID")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(data.toString("base64") + "\n");
  });
}
export async function protectEphemeralInstallationBytes(plain) {
  assertBytes(plain);
  const ciphertext = await invokePowerShell("Protect", plain);
  try { return Buffer.from(prefix + ciphertext.toString("base64"), "utf8"); }
  finally { ciphertext.fill(0); }
}
export async function unprotectEphemeralInstallationBytes(blob) {
  assertBytes(blob);
  const payload = blob.toString("utf8");
  if (!payload.startsWith(prefix)) throw new Error("CUSTOMER_DPAPI_BLOB_VERSION_INVALID");
  const sealed = decodeCanonicalBase64(payload.slice(prefix.length));
  try { return await invokePowerShell("Unprotect", sealed); }
  finally { sealed.fill(0); }
}
