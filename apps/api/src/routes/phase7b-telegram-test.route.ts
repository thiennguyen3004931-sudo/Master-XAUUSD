import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router, type Request, type Response } from "express";

const execFileAsync = promisify(execFile);
const router = Router();

router.post("/", async (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: "Chỉ cho phép gửi tin test Telegram từ localhost." });
  }

  try {
    const root = findProjectRoot();
    const script = path.join(root, "scripts", "run-phase7b-telegram-notifier-local.ps1");
    const envFile = path.join(root, ".env.phase7b-telegram");
    const workRoot = resolveWorkRoot(root);

    if (!fs.existsSync(script)) throw new Error(`Không tìm thấy script Telegram: ${script}`);
    if (!fs.existsSync(envFile)) throw new Error(`Không tìm thấy cấu hình Telegram: ${envFile}`);
    fs.mkdirSync(workRoot, { recursive: true });

    const result = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", script,
        "-WorkDir", workRoot,
        "-EnvFile", envFile,
        "-SendTest",
        "-Once",
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const stdout = String(result.stdout ?? "");
    if (!stdout.includes("PHASE7B_TELEGRAM_TEST=PASS")) {
      throw new Error(`Telegram test không trả PASS.\n${stdout}\n${String(result.stderr ?? "")}`.trim());
    }

    return res.json({
      accepted: true,
      action: "TELEGRAM_TEST_SENT",
      message: "Đã gửi tin nhắn test Telegram. Kiểm tra Telegram để xem nội dung mẫu.",
      orderPermission: "NONE",
      demoOnly: true,
    });
  } catch (error) {
    return res.status(503).json({ error: errorMessage(error) });
  }
});

function resolveWorkRoot(root: string): string {
  const configured = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (!configured) return path.join(root, ".runtime");
  const resolved = path.resolve(configured);
  return path.basename(resolved).toLowerCase() === "phase7b-demo-forward" ? path.dirname(resolved) : resolved;
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let index = 0; index < 8; index += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) && fs.existsSync(path.join(current, "scripts"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Không xác định được thư mục dự án từ ${process.cwd()}.`);
}

function isLoopback(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default router;
