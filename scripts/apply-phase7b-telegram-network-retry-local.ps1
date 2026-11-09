param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$NotifierPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-compact.mjs"

Push-Location $Root
try {
  if (-not (Test-Path $NotifierPath)) {
    throw "Compact Telegram notifier not found: $NotifierPath"
  }

  $text = [System.IO.File]::ReadAllText($NotifierPath)

  if (-not $text.Contains('import https from "node:https";')) {
    if ($text.StartsWith('import fs from "node:fs";')) {
      $text = $text.Replace('import fs from "node:fs";', 'import fs from "node:fs";' + "`n" + 'import https from "node:https";')
    } else {
      throw "Unexpected notifier header; cannot insert node:https import safely."
    }
  }

  $startMarker = 'async function sendHtml(text) {'
  $endMarker = 'function loadState() {'
  $start = $text.IndexOf($startMarker)
  $end = $text.IndexOf($endMarker)
  if ($start -lt 0 -or $end -le $start) {
    throw "Could not locate sendHtml/loadState markers for Telegram network patch."
  }

  $replacement = @'
async function sendHtml(text) {
  const highContrastText = String(text)
    .replaceAll("<code>", "<b>")
    .replaceAll("</code>", "</b>");
  const payload = {
    chat_id: chatId,
    text: highContrastText.slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(messageThreadId === null ? {} : { message_thread_id: messageThreadId }),
    ...(monitorUrl ? {
      reply_markup: {
        inline_keyboard: [[{ text: "📊 Mở theo dõi DEMO", url: monitorUrl }]],
      },
    } : {}),
  };

  let lastError = null;
  const delays = [0, 700, 1600, 3200];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      await sendTelegramHttps(payload);
      if (attempt > 0) console.log(`PHASE7B_TELEGRAM_SEND_RECOVERED_ATTEMPT=${attempt + 1}`);
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code ?? error?.cause?.code ?? "UNKNOWN";
      console.error(`PHASE7B_TELEGRAM_SEND_RETRY=${attempt + 1}/${delays.length} CODE=${code} ERROR=${errorMessage(error)}`);
    }
  }
  throw lastError ?? new Error("Telegram send failed after retries.");
}

function sendTelegramHttps(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      protocol: "https:",
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: "POST",
      family: 4,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "XAUUSD-AI-MASTER-Phase7B/1.0",
        "connection": "close",
      },
      timeout: 10_000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = responseText ? JSON.parse(responseText) : null; } catch {}
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300 || parsed?.ok !== true) {
          const error = new Error(`Telegram sendMessage ${response.statusCode ?? 0}: ${responseText}`);
          error.code = `HTTP_${response.statusCode ?? 0}`;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });

    req.on("timeout", () => {
      const error = new Error("Telegram HTTPS request timed out after 10 seconds.");
      error.code = "ETIMEDOUT";
      req.destroy(error);
    });
    req.on("error", reject);
    req.end(body);
  });
}

'@

  $text = $text.Substring(0, $start) + $replacement + $text.Substring($end)
  [System.IO.File]::WriteAllText($NotifierPath, $text, $Utf8NoBom)

  & node --check $NotifierPath
  if ($LASTEXITCODE -ne 0) { throw "Telegram notifier syntax check failed: $LASTEXITCODE" }

  $verify = [System.IO.File]::ReadAllText($NotifierPath)
  foreach ($token in @(
    'import https from "node:https";',
    'family: 4',
    'PHASE7B_TELEGRAM_SEND_RETRY=',
    'sendTelegramHttps(payload)',
    'const delays = [0, 700, 1600, 3200]'
  )) {
    if (-not $verify.Contains($token)) { throw "Telegram network patch missing token: $token" }
  }

  Write-Host "PHASE7B_TELEGRAM_NETWORK_PATCH=PASS"
  Write-Host "PHASE7B_TELEGRAM_TRANSPORT=NODE_HTTPS_NATIVE_IPV4"
  Write-Host "PHASE7B_TELEGRAM_RETRIES=4"
  Write-Host "PHASE7B_TELEGRAM_RETRY_BACKOFF_MS=0,700,1600,3200"
  Write-Host "PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY"
}
finally {
  Pop-Location
}
