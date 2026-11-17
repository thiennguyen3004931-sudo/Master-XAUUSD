import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const pagePath = path.join(root, "apps", "web", "src", "pages", "Phase7BOpsPage.tsx");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}
function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

let page = read(pagePath);

if (!page.includes("async function startDemoSystem()")) {
  const marker = `async function sendTelegramTest(): Promise<ActionResponse> {
  return readJson<ActionResponse>(await fetch(\`${'${API_BASE}'}/api/v1/phase7b-telegram-test\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
}`;
  if (!page.includes(marker)) throw new Error("Telegram test function marker not found.");
  const addition = `${marker}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForOps(predicate: (status: OpsStatus) => boolean, timeoutMs: number): Promise<OpsStatus> {
  const deadline = Date.now() + timeoutMs;
  let last = await getOps();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await sleep(700);
    last = await getOps();
  }
  return last;
}

async function startDemoSystem(): Promise<ActionResponse> {
  let status = await getOps();
  const demoReady = Boolean(
    status.bridge.reachable &&
    status.bridge.accountMode === "demo" &&
    status.bridge.tradingEnabled === true &&
    status.bridge.terminalTradeAllowed === true &&
    status.bridge.expertTradeAllowed === true,
  );
  if (!status.controlEnabled) throw new Error("Điều khiển local đang bị khóa.");
  if (!demoReady) throw new Error("MT5 DEMO chưa sẵn sàng. Kiểm tra Bridge / Algo Trading trước khi chạy Bot.");

  if (!status.bot.alive) {
    try {
      await runAction("bot/start");
    } catch {
      // Windows may close the HTTP keep-alive while spawning the background process.
      // Status verification below is authoritative.
    }
    status = await waitForOps((value) => value.bot.alive && value.bot.armed, 35_000);
    if (!status.bot.alive || !status.bot.armed) throw new Error("Bot DEMO không lên RUNNING sau 35 giây.");
  }

  if (!status.telegram.alive) {
    try {
      await runAction("telegram/start");
    } catch {
      // Same recovery rule: verify actual runtime/heartbeat rather than HTTP socket alone.
    }
    status = await waitForOps((value) => value.telegram.alive && value.telegram.heartbeatFresh, 25_000);
    if (!status.telegram.alive || !status.telegram.heartbeatFresh) {
      throw new Error("Bot đã chạy nhưng Telegram chưa lên RUNNING. Kiểm tra log Telegram trên trang điều khiển.");
    }
  }

  return {
    accepted: true,
    action: "DEMO_SYSTEM_READY",
    message: `HỆ THỐNG DEMO ĐÃ CHẠY NỀN · Bot PID ${status.bot.pid ?? "—"} · Telegram PID ${status.telegram.pid ?? "—"}.`,
    pid: status.bot.pid,
  };
}`;
  page = page.replace(marker, addition);
}

if (!page.includes("const startSystem = useMutation")) {
  const marker = `  const testTelegram = useMutation({ mutationFn: sendTelegramTest });`;
  if (!page.includes(marker)) throw new Error("Mutation marker not found.");
  page = page.replace(
    marker,
    `${marker}
  const startSystem = useMutation({
    mutationFn: startDemoSystem,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["phase7b-ops-status"] });
    },
  });`,
  );
}

page = page.replace(
  `  const actionPending = mutate.isPending;`,
  `  const systemReady = Boolean(o.bot.alive && o.bot.armed && o.telegram.alive && o.telegram.heartbeatFresh && demoReady);
  const actionPending = mutate.isPending || startSystem.isPending;`,
);
page = page.replace(
  `  const botStarting = actionPending && pendingAction === "bot/start";`,
  `  const botStarting = startSystem.isPending || (mutate.isPending && pendingAction === "bot/start");`,
);
page = page.replace(
  `  const telegramStarting = actionPending && pendingAction === "telegram/start";`,
  `  const telegramStarting = startSystem.isPending || (mutate.isPending && pendingAction === "telegram/start");`,
);

page = page.replace(
  `<Typography variant="h4" fontWeight={950}>Điều khiển Bot & Telegram</Typography>`,
  `<Typography variant="h4" fontWeight={950}>Bot DEMO · Một nút vận hành</Typography>`,
);
page = page.replace(
  `          Chỉ điều khiển tiến trình trên máy local này. Tài khoản thật luôn bị khóa.`,
  `          Bridge + API + Web chạy nền cùng Windows. Chỉ cần nhấn CHẠY BOT DEMO để bật Bot và Telegram. Tài khoản thật luôn bị khóa.`,
);

if (!page.includes("HỆ THỐNG DEMO ĐANG CHẠY NỀN")) {
  const marker = `      <Grid container spacing={2}>`;
  const block = `      {systemReady && (
        <Alert severity="success">
          <b>HỆ THỐNG DEMO ĐANG CHẠY NỀN.</b> Bạn chỉ cần theo dõi Web/Telegram; không cần mở PowerShell.
        </Alert>
      )}

${marker}`;
  const index = page.indexOf(marker);
  if (index < 0) throw new Error("First grid marker not found.");
  page = page.slice(0, index) + block + page.slice(index + marker.length);
}

page = page.replace(
  `onClick={() => mutate.mutate("bot/start")}`,
  `onClick={() => startSystem.mutate()}`,
);
page = page.replace(
  `{botStarting ? "ĐANG BẬT BOT..." : "BẬT BOT DEMO"}`,
  `{startSystem.isPending ? "ĐANG KHỞI ĐỘNG HỆ THỐNG..." : systemReady ? "BOT DEMO ĐANG CHẠY" : "CHẠY BOT DEMO"}`,
);
page = page.replace(
  `disabled={actionPending || o.bot.alive || !o.controlEnabled || !demoReady}`,
  `disabled={actionPending || systemReady || !o.controlEnabled || !demoReady}`,
);

page = page.replace(
  "Điều kiện vào lệnh: 2 mô hình nến + Supertrend M15 cùng hướng + M5 cùng hướng và fresh flip ≤ 2 nến đóng. FVG chỉ là bối cảnh. Khối lượng mặc định 0.03 lot.",
  "Điều kiện vào lệnh: 1 trong 3 mô hình nến + Supertrend M15 và M5 cùng hướng + SL cấu trúc hợp lệ. Flip age/FVG chỉ là bối cảnh. Khối lượng DEMO cố định 0.03 lot.",
);

if (!page.includes("startSystem.isSuccess")) {
  const marker = `      {mutate.isSuccess && <Alert severity="success">{mutate.data.message}</Alert>}`;
  if (!page.includes(marker)) throw new Error("Success alert marker not found.");
  page = page.replace(
    marker,
    `      {startSystem.isSuccess && <Alert severity="success">{startSystem.data.message}</Alert>}
      {startSystem.isError && (
        <Alert severity="error" sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
          {startSystem.error instanceof Error ? startSystem.error.message : "Không khởi động được hệ thống DEMO."}
        </Alert>
      )}
${marker}`,
  );
}

if (!page.includes("async function startDemoSystem()")) throw new Error("One-click function missing after patch.");
if (!page.includes('"CHẠY BOT DEMO"')) throw new Error("One-click button label missing after patch.");
write(pagePath, page);

console.log("PHASE7B_V17_WEB_ONE_CLICK=PASS");
console.log("PHASE7B_V17_ONE_CLICK_STARTS=BOT_PLUS_TELEGRAM");
console.log("PHASE7B_V17_HTTP_START_RECOVERY=RUNTIME_HEARTBEAT_VERIFY");
console.log("PHASE7B_V17_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V17_WEB_BUILD_REQUIRED=True");
console.log("PHASE7B_V17=PASS");
