param(
  [Parameter(Mandatory = $true)] [ValidateSet("DEMO", "LIVE")] [string]$AccountMode,
  [Parameter(Mandatory = $true)] [string]$TerminalPath,
  [Parameter(Mandatory = $true)] [long]$Login,
  [Parameter(Mandatory = $true)] [string]$Server,
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [switch]$PromptForPassword
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary)) { throw "Phase7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

$AccountMode = ConvertTo-Phase7CAccountMode $AccountMode
if ($Login -le 0) { throw "Login must be a positive MT5 account number." }
if ([string]::IsNullOrWhiteSpace($Server)) { throw "Server is required." }
if (-not [System.IO.Path]::IsPathRooted($TerminalPath)) { throw "TerminalPath must be an absolute terminal64.exe path." }
if (-not (Test-Path -LiteralPath $TerminalPath)) { throw "MT5 terminal path does not exist: $TerminalPath" }
if ([System.IO.Path]::GetFileName($TerminalPath) -notmatch '^(?i:terminal64\.exe)$') { throw "TerminalPath must point to terminal64.exe." }

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

$target = if ($AccountMode -eq "LIVE") { Resolve-ProjectPath $LiveEnvFile } else { Resolve-ProjectPath $DemoEnvFile }
if (-not (Test-Path -LiteralPath $target)) {
  if ($AccountMode -ne "LIVE") { throw "DEMO env file not found: $target" }
  $template = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-live.example"
  if (-not (Test-Path -LiteralPath $template)) { throw "LIVE env template not found: $template" }
  Copy-Item -LiteralPath $template -Destination $target
}

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in Get-Content -LiteralPath $target) { [void]$lines.Add([string]$line) }

function Set-EnvLine([string]$Name, [string]$Value) {
  $replacement = "$Name=$Value"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $raw = ([string]$lines[$i]).TrimStart([char]0xFEFF)
    if ($raw -match ('^' + [regex]::Escape($Name) + '=')) {
      $lines[$i] = $replacement
      return
    }
  }
  [void]$lines.Add($replacement)
}

$passwordPlain = $null
if ($PromptForPassword) {
  $secure = Read-Host "MT5 password for $AccountMode login $Login" -AsSecureString
  $ptr = [IntPtr]::Zero
  try {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $passwordPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  }
}

Set-EnvLine "MT5_TERMINAL_PATH" $TerminalPath
Set-EnvLine "MT5_LOGIN" ([string]$Login)
Set-EnvLine "MT5_SERVER" $Server
Set-EnvLine "MT5_ALLOWED_LOGINS" ([string]$Login)
if ($null -ne $passwordPlain) { Set-EnvLine "MT5_PASSWORD" $passwordPlain }

if ($AccountMode -eq "LIVE") {
  # Profile configuration is identity-only. Never activate execution as a side
  # effect; the operator must deliberately enable capability later and then ARM.
  Set-EnvLine "MT5_TRADING_ENABLED" "false"
  Set-EnvLine "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "false"
}

$temp = "$target.$PID.$([guid]::NewGuid().ToString('N')).tmp"
try {
  [System.IO.File]::WriteAllText($temp, (($lines -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $target -Force
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  $passwordPlain = $null
}

$runtime = Join-Path $ProjectRoot ".runtime"
if (Test-Path -LiteralPath $runtime) {
  Clear-Phase7CLiveArmState -WorkDir $runtime -Reason "terminal-profile-changed"
}

Write-Host "PHASE7C_TERMINAL_PROFILE_MODE=$AccountMode"
Write-Host "PHASE7C_TERMINAL_PROFILE_LOGIN=$Login"
Write-Host "PHASE7C_TERMINAL_PROFILE_SERVER=$Server"
Write-Host "PHASE7C_TERMINAL_PROFILE_PASSWORD_UPDATED=$PromptForPassword"
Write-Host "PHASE7C_TERMINAL_PROFILE_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_TERMINAL_PROFILE_STATUS=PASS"
