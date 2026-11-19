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

function requiredReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`${label} marker not found.`);
  return text.replace(from, to);
}

let page = read(pagePath);

// A. Add the one-click orchestration functions. Avoid nested template literals
// so this helper parses cleanly on Node 24 / Windows.
if (!page.includes("async function startDemoSystem()")) {
  const marker = "function StatusCard(";
  if (!page.includes(marker)) throw new Error("StatusCard insertion marker not found.");

  const block = [
    "function sleep(ms: number): Promise<void> {",
    "  return new Promise((resolve) => window.setTimeout(resolve, ms));",
    "}",
    "",
    "async function waitForOps(predicate: (status: OpsStatus) => boolean, timeoutMs: number): Promise<OpsStatus> {",
    "  const deadline = Date.now() + timeoutMs;",
    "  let last = await getOps();",
    "  while (Date.now() < deadline) {",
    "    if (predicate(last)) return last;",
    "    await sleep(700);",
    "    last = await getOps();",
    "  }",
    "  return last;",
    "}",
    "",
    "async function startDemoSystem(): Promise<ActionResponse> {",
    "  let status = await getOps();",
    "  const demoReady = Boolean(",
    "    status.bridge.reachable &&",
    "    status.bridge.accountMode === \"demo\" &&",
    "    status.bridge.tradingEnabled === true &&",
    "    status.bridge.terminalTradeAllowed === true &&",
    "    status.bridge.expertTradeAllowed === true,",
    "  );",
    "  if (!status.controlEnabled) throw new Error(\"Điều khiển local đang bị khóa.\");",
    "  if (!demoReady) throw new Error(\"MT5 DEMO chưa sẵn sàng. Kiểm tra Bridge / Algo Trading trước khi chạy Bot.\");",
    "",
    "  if (!status.bot.alive) {",
    "    try {",
    "      await runAction(\"bot/start\");",
    "    } catch {",
    "      // Windows đôi khi đóng HTTP keep-alive khi spawn process nền; heartbeat mới là nguồn xác nhận.",
    "    }",
    "    status = await waitForOps((value) => value.bot.alive && value.bot.armed, 35_000);",
    "    if (!status.bot.alive || !status.bot.armed) throw new Error(\"Bot DEMO không lên RUNNING sau 35 giây.\");",
    "  }",
    "",
    "  if (!status.telegram.alive) {",
    "    try {",
    "      await runAction(\"telegram/start\");",
    "    } catch {",
    "      // Tương tự Bot: xác nhận bằng runtime + heartbeat thay vì socket HTTP.",
    "    }",
    "    status = await waitForOps((value) => value.telegram.alive && value.telegram.heartbeatFresh, 25_000);",
    "    if (!status.telegram.alive || !status.telegram.heartbeatFresh) {",
    "      throw new Error(\"Bot đã chạy nhưng Telegram chưa lên RUNNING. Kiểm tra log Telegram trên trang điều khiển.\");",
    "    }",
    "  }",
    "",
    "  return {",
    "    accepted: true,",
    "    action: \"DEMO_SYSTEM_READY\",",
    "    message: \"HỆ THỐNG DEMO ĐÃ CHẠY NỀN · Bot PID \" + String(status.bot.pid ?? \"—\") + \" · Telegram PID \" + String(status.telegram.pid ?? \"—\") + \".\",",
    "    pid: status.bot.pid,",
    "  };",
    "}",
    "",
  ].join("\n");

  page = page.replace(marker, block + marker);
}

// B. Add a dedicated mutation for the whole system.
if (!page.includes("const startSystem = useMutation")) {
  const marker = "  const testTelegram = useMutation({ mutationFn: sendTelegramTest });";
  const replacement = [
    marker,
    "  const startSystem = useMutation({",
    "    mutationFn: startDemoSystem,",
    "    onSuccess: async () => {",
    "      await queryClient.invalidateQueries({ queryKey: [\"phase7b-ops-status\"] });",
    "    },",
    "  });",
  ].join("\n");
  page = requiredReplace(page, marker, replacement, "Start-system mutation");
}

// C. Derive one-click readiness / pending state.
if (!page.includes("const systemReady = Boolean(")) {
  page = requiredReplace(
    page,
    "  const actionPending = mutate.isPending;",
    [
      "  const systemReady = Boolean(o.bot.alive && o.bot.armed && o.telegram.alive && o.telegram.heartbeatFresh && demoReady);",
      "  const actionPending = mutate.isPending || startSystem.isPending;",
    ].join("\n"),
    "System-ready state",
  );
}

page = page.replace(
  "  const botStarting = actionPending && pendingAction === \"bot/start\";",
  "  const botStarting = startSystem.isPending || (mutate.isPending && pendingAction === \"bot/start\");",
);
page = page.replace(
  "  const telegramStarting = actionPending && pendingAction === \"telegram/start\";",
  "  const telegramStarting = startSystem.isPending || (mutate.isPending && pendingAction === \"telegram/start\");",
);

// D. Make the page clearly one-click oriented.
page = page.replace(
  '<Typography variant="h4" fontWeight={950}>Điều khiển Bot & Telegram</Typography>',
  '<Typography variant="h4" fontWeight={950}>Bot DEMO · Một nút vận hành</Typography>',
);
page = page.replace(
  "          Chỉ điều khiển tiến trình trên máy local này. Tài khoản thật luôn bị khóa.",
  "          Bridge + API + Web chạy nền cùng Windows. Chỉ cần nhấn CHẠY BOT DEMO để bật Bot và Telegram. Tài khoản thật luôn bị khóa.",
);

if (!page.includes("HỆ THỐNG DEMO ĐANG CHẠY NỀN")) {
  const marker = "      <Grid container spacing={2}>";
  const idx = page.indexOf(marker);
  if (idx < 0) throw new Error("First grid marker not found.");
  const alertBlock = [
    "      {systemReady && (",
    '        <Alert severity="success">',
    "          <b>HỆ THỐNG DEMO ĐANG CHẠY NỀN.</b> Bạn chỉ cần theo dõi Web/Telegram; không cần mở PowerShell.",
    "        </Alert>",
    "      )}",
    "",
  ].join("\n");
  page = page.slice(0, idx) + alertBlock + page.slice(idx);
}

// E. Main green button becomes the single start action.
page = page.replace(
  'onClick={() => mutate.mutate("bot/start")}',
  "onClick={() => startSystem.mutate()}",
);
page = page.replace(
  '{botStarting ? "ĐANG BẬT BOT..." : "BẬT BOT DEMO"}',
  '{startSystem.isPending ? "ĐANG KHỞI ĐỘNG HỆ THỐNG..." : systemReady ? "BOT DEMO ĐANG CHẠY" : "CHẠY BOT DEMO"}',
);
page = page.replace(
  "disabled={actionPending || o.bot.alive || !o.controlEnabled || !demoReady}",
  "disabled={actionPending || systemReady || !o.controlEnabled || !demoReady}",
);

// F. Keep displayed strategy wording aligned with the current V6+ entry gate.
page = page.replace(
  "Điều kiện vào lệnh: 2 mô hình nến + Supertrend M15 cùng hướng + M5 cùng hướng và fresh flip ≤ 2 nến đóng. FVG chỉ là bối cảnh. Khối lượng mặc định 0.03 lot.",
  "Điều kiện vào lệnh: 1 trong 3 mô hình nến + Supertrend M15 và M5 cùng hướng + SL cấu trúc hợp lệ. Flip age/FVG chỉ là bối cảnh. Khối lượng DEMO cố định 0.03 lot.",
);

// G. Surface one-click success/error without removing the diagnostic controls.
if (!page.includes("startSystem.isSuccess")) {
  const marker = '      {mutate.isSuccess && <Alert severity="success">{mutate.data.message}</Alert>}';
  const block = [
    '      {startSystem.isSuccess && <Alert severity="success">{startSystem.data.message}</Alert>}',
    "      {startSystem.isError && (",
    '        <Alert severity="error" sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>',
    '          {startSystem.error instanceof Error ? startSystem.error.message : "Không khởi động được hệ thống DEMO."}',
    "        </Alert>",
    "      )}",
    marker,
  ].join("\n");
  page = requiredReplace(page, marker, block, "One-click result alert");
}

if (!page.includes("async function startDemoSystem()")) throw new Error("One-click function missing after patch.");
if (!page.includes('"CHẠY BOT DEMO"')) throw new Error("One-click button label missing after patch.");
if (!page.includes("const startSystem = useMutation")) throw new Error("One-click mutation missing after patch.");

write(pagePath, page);

console.log("PHASE7B_V18_WEB_ONE_CLICK=PASS");
console.log("PHASE7B_V18_ONE_CLICK_STARTS=BOT_PLUS_TELEGRAM");
console.log("PHASE7B_V18_HTTP_START_RECOVERY=RUNTIME_HEARTBEAT_VERIFY");
console.log("PHASE7B_V18_MAIN_BUTTON=CHAY_BOT_DEMO");
console.log("PHASE7B_V18_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V18_WEB_BUILD_REQUIRED=True");
console.log("PHASE7B_V18=PASS");
