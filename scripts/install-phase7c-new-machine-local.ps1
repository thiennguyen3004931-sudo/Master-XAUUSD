param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$LiveEnvFile,

  [Parameter(Mandatory = $true)]
  [string]$TelegramEnvFile,

  [Parameter(Mandatory = $true)]
  [string]$RiskProfileFile,

  [string]$StrategyEntryConditionsFile = "",

  [string]$RepositoryUrl = "https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core.git",

  [ValidatePattern("^[0-9a-fA-F]{40}$")]
  [string]$ExpectedCommit = "800ab441ffa1eec45488f7b7ff92c15b3a44846e",

  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$TimeoutSeconds = 180,

  [Parameter(Mandatory = $true)]
  [switch]$ConfirmOldMachineStopped,

  [switch]$SkipPanelInstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BootstrapRoot = Split-Path -Parent $PSScriptRoot
$ExpectedCommit = $ExpectedCommit.ToLowerInvariant()

function Write-Step([string]$Name, [string]$Value = "START") {
  Write-Host "PHASE7C_NEW_MACHINE_${Name}=$Value"
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "New-machine bootstrap requires PowerShell Administrator."
  }
  Write-Step "ADMIN" "PASS"
}

function Resolve-RequiredFile([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-CommandPath([string[]]$Names, [string]$Label) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
      return [string]$command.Source
    }
  }
  throw "$Label is required but was not found in PATH."
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$Label) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Write-JsonAtomic([string]$Path, $Value, [int]$Depth = 10) {
  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $temp = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText($temp, "$json`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

function Assert-GitIgnored([string]$Root, [string]$RelativePath) {
  Push-Location $Root
  try {
    & git check-ignore -q -- $RelativePath
    if ($LASTEXITCODE -ne 0) {
      throw "Local-only file is not ignored by git: $RelativePath. Bootstrap refuses to risk committing secrets/runtime state."
    }
  } finally {
    Pop-Location
  }
}

function Register-WebTask(
  [string]$Root,
  [string]$WorkDir,
  [string]$BridgeEnv,
  [int]$ApiPortValue,
  [int]$WebPortValue
) {
  $taskName = "XAUUSD-Phase7B-Web"
  $runner = Join-Path $Root "scripts\run-phase7b-web-autostart.ps1"
  if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Web runtime runner not found: $runner"
  }

  $powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -WorkDir `"$WorkDir`" -BridgeEnv `"$BridgeEnv`" -ApiPort $ApiPortValue -WebPort $WebPortValue"
  $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments -WorkingDirectory $Root

  $currentUser = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 20 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "XAUUSD Phase7C local Control API/Web UI. Trading order permission remains in the executor/bridge gates." `
    -Force `
    -ErrorAction Stop | Out-Null

  $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if (@($registered.Actions).Count -ne 1) {
    throw "Web task registration did not persist exactly one action."
  }
  Write-Step "WEB_TASK" "PASS|NAME=$taskName|USER=$currentUser"
}

function Wait-Bridge(
  [string]$BaseUrl,
  [hashtable]$Headers,
  [long]$ExpectedLogin,
  [string]$ExpectedServer,
  [int]$Timeout
) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  $last = ""
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Headers $Headers -Method Get -TimeoutSec 8
      $last = ($health | ConvertTo-Json -Compress -Depth 5)
      $serverMatches = [string]::Equals(
        ([string]$health.server).Trim(),
        $ExpectedServer.Trim(),
        [System.StringComparison]::OrdinalIgnoreCase
      )
      if (
        [bool]$health.connected -and
        [string]$health.status -eq "ok" -and
        [string]$health.configuredAccountMode -eq "LIVE" -and
        [string]$health.accountMode -eq "real" -and
        [long]$health.accountLogin -eq $ExpectedLogin -and
        $serverMatches -and
        [bool]$health.tradingEnabled -and
        [bool]$health.terminalTradeAllowed -and
        [bool]$health.expertTradeAllowed
      ) {
        return $health
      }
    } catch {
      $last = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  }
  throw "LIVE MT5 bridge did not become healthy within $Timeout seconds. Last=$last"
}

function Read-BridgeArray([string]$BaseUrl, [hashtable]$Headers, [string]$Path) {
  $response = Invoke-WebRequest -Uri "$BaseUrl$Path" -Headers $Headers -Method Get -UseBasicParsing -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-FlatBroker([string]$BaseUrl, [hashtable]$Headers, [string]$Stage) {
  $positions = @(Read-BridgeArray -BaseUrl $BaseUrl -Headers $Headers -Path "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray -BaseUrl $BaseUrl -Headers $Headers -Path "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0) { throw "$Stage requires zero XAUUSD positions. Current=$($positions.Count)" }
  if ($orders.Count -ne 0) { throw "$Stage requires zero XAUUSD pending orders. Current=$($orders.Count)" }
  Write-Step "${Stage}_POSITIONS" "0"
  Write-Step "${Stage}_PENDING_ORDERS" "0"
}

function Wait-Api([string]$ApiBase, [int]$Timeout) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  $last = ""
  while ((Get-Date) -lt $deadline) {
    try {
      $mode = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
      if ($null -ne $mode.state) { return }
    } catch { $last = $_.Exception.Message }
    Start-Sleep -Seconds 2
  }
  throw "Control API did not become ready within $Timeout seconds. Last=$last"
}

function Wait-LifecycleReady([string]$ApiBase, [int]$Timeout) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  $stableSince = $null
  $last = ""
  while ((Get-Date) -lt $deadline) {
    try {
      $state = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/lifecycle" -Method Get -TimeoutSec 5
      $last = ($state | ConvertTo-Json -Compress -Depth 6)
      $sample = (
        [bool]$state.running -and
        [bool]$state.ready -and
        [string]$state.mode.mode -eq "PAUSE" -and
        [string]$state.accountMode.accountMode -eq "LIVE" -and
        [bool]$state.accountMode.valid
      )
      if ($sample) {
        if ($null -eq $stableSince) { $stableSince = Get-Date }
        if (((Get-Date) - $stableSince).TotalSeconds -ge 5) { return $state }
      } else {
        $stableSince = $null
      }
    } catch {
      $last = $_.Exception.Message
      $stableSince = $null
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Lifecycle did not remain READY for 5 seconds within $Timeout seconds. Last=$last"
}

if (-not $ConfirmOldMachineStopped) {
  throw "Refusing new-machine LIVE bootstrap until -ConfirmOldMachineStopped is supplied. Never run the same LIVE account ARMED on two machines."
}
if ($ApiPort -lt 1024 -or $ApiPort -gt 65535 -or $WebPort -lt 1024 -or $WebPort -gt 65535 -or $ApiPort -eq $WebPort) {
  throw "ApiPort/WebPort are invalid."
}
if ($TimeoutSeconds -lt 60 -or $TimeoutSeconds -gt 900) {
  throw "TimeoutSeconds must be between 60 and 900."
}

Assert-Administrator

$LiveEnvFile = Resolve-RequiredFile $LiveEnvFile "LIVE env file"
$TelegramEnvFile = Resolve-RequiredFile $TelegramEnvFile "Telegram env file"
$RiskProfileFile = Resolve-RequiredFile $RiskProfileFile "Risk profile file"
if (-not [string]::IsNullOrWhiteSpace($StrategyEntryConditionsFile)) {
  $StrategyEntryConditionsFile = Resolve-RequiredFile $StrategyEntryConditionsFile "Strategy entry conditions file"
}

$gitExe = Get-CommandPath @("git.exe", "git") "Git"
$nodeExe = Get-CommandPath @("node.exe", "node") "Node.js"
$pnpmExe = Get-CommandPath @("pnpm.cmd", "pnpm.exe", "pnpm") "pnpm"
$pyExe = Get-CommandPath @("py.exe", "py") "Python launcher"

$nodeVersion = (& $nodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
  throw "Node.js 24.x is required to match the production CI toolchain. Current=$nodeVersion"
}
$pnpmVersion = (& $pnpmExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne "10.18.0") {
  throw "pnpm 10.18.0 is required. Current=$pnpmVersion"
}
Write-Step "PREREQUISITES" "PASS|NODE=$nodeVersion|PNPM=$pnpmVersion"

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$bootstrapFull = [System.IO.Path]::GetFullPath($BootstrapRoot)
if ([string]::Equals($ProjectRoot.TrimEnd('\'), $bootstrapFull.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "ProjectRoot must be a separate production working copy, not the bootstrap repository itself."
}
if (Test-Path -LiteralPath $ProjectRoot) {
  $children = @(Get-ChildItem -LiteralPath $ProjectRoot -Force -ErrorAction Stop)
  if ($children.Count -ne 0) {
    throw "ProjectRoot must not contain an existing project/runtime. Refusing to reuse: $ProjectRoot"
  }
} else {
  New-Item -ItemType Directory -Force -Path $ProjectRoot | Out-Null
}

Write-Step "GIT_CLONE" "START"
Invoke-Checked $gitExe @("clone", "--no-checkout", $RepositoryUrl, $ProjectRoot) "Git clone"
Push-Location $ProjectRoot
try {
  Invoke-Checked $gitExe @("fetch", "--no-tags", "origin", $ExpectedCommit) "Fetch expected production commit"
  & $gitExe merge-base --is-ancestor $ExpectedCommit "origin/main"
  if ($LASTEXITCODE -ne 0) {
    throw "Expected production commit is not an ancestor of origin/main: $ExpectedCommit"
  }
  Invoke-Checked $gitExe @("checkout", "-B", "main", $ExpectedCommit) "Checkout exact production commit on local main"
  $actual = (& $gitExe rev-parse HEAD).Trim().ToLowerInvariant()
  if ($actual -ne $ExpectedCommit) {
    throw "Exact source checkout mismatch. expected=$ExpectedCommit actual=$actual"
  }
  $dirty = @(& $gitExe status --porcelain --untracked-files=no)
  if ($dirty.Count -ne 0) { throw "Fresh production checkout is unexpectedly dirty." }
} finally {
  Pop-Location
}
Write-Step "GIT_CLONE" "PASS|HEAD=$ExpectedCommit|BRANCH=main"

# The accepted production commit predates a tracked /.runtime/ ignore rule.
# Keep machine-local runtime state out of git without changing the accepted
# production tree: use this clone's private .git/info/exclude.
$localExcludePath = Join-Path $ProjectRoot ".git\info\exclude"
$localExclude = if (Test-Path -LiteralPath $localExcludePath) {
  Get-Content -LiteralPath $localExcludePath -Raw
} else {
  ""
}
if ($localExclude -notmatch '(?m)^/\.runtime/$') {
  Add-Content -LiteralPath $localExcludePath -Value "/.runtime/" -Encoding ascii
}
Write-Step "LOCAL_RUNTIME_GIT_EXCLUDE" "PASS"

$accountLibrary = Join-Path $ProjectRoot "scripts\lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $accountLibrary -PathType Leaf)) {
  throw "Canonical account library missing from production source: $accountLibrary"
}
. $accountLibrary

$liveEnvRelative = "packages/mt5-broker/bridge/.env.phase7b-live"
$telegramEnvRelative = ".env.phase7b-telegram"
Assert-GitIgnored -Root $ProjectRoot -RelativePath $liveEnvRelative
Assert-GitIgnored -Root $ProjectRoot -RelativePath $telegramEnvRelative
Assert-GitIgnored -Root $ProjectRoot -RelativePath ".runtime/"

$liveEnvDestination = Join-Path $ProjectRoot ($liveEnvRelative -replace '/', '\')
$telegramEnvDestination = Join-Path $ProjectRoot $telegramEnvRelative
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $liveEnvDestination) | Out-Null
Copy-Item -LiteralPath $LiveEnvFile -Destination $liveEnvDestination -Force
Copy-Item -LiteralPath $TelegramEnvFile -Destination $telegramEnvDestination -Force
$liveEnvDestination = (Resolve-Path -LiteralPath $liveEnvDestination).Path
$telegramEnvDestination = (Resolve-Path -LiteralPath $telegramEnvDestination).Path

$envInfo = Assert-Phase7CAccountEnv -EnvFile $liveEnvDestination -AccountMode "LIVE" -RequireTrading
$liveIdentity = Get-Phase7CLiveProfileIdentity $liveEnvDestination
$telegramToken = ([string](Get-Phase7CEnvValue $telegramEnvDestination "ZIQ_TELEGRAM_BOT_TOKEN")).Trim()
$telegramChatId = ([string](Get-Phase7CEnvValue $telegramEnvDestination "ZIQ_TELEGRAM_CHAT_ID")).Trim()
if ([string]::IsNullOrWhiteSpace($telegramToken) -or [string]::IsNullOrWhiteSpace($telegramChatId)) {
  throw "Telegram env must contain ZIQ_TELEGRAM_BOT_TOKEN and ZIQ_TELEGRAM_CHAT_ID."
}
$riskRaw = Get-Content -LiteralPath $RiskProfileFile -Raw | ConvertFrom-Json
$risk = Assert-Phase7CRiskProfile $riskRaw "New-machine migration risk profile"
Write-Step "LOCAL_CONFIG_VALIDATE" "PASS|LOGIN=$($liveIdentity.login)|SERVER=$($liveIdentity.server)"

$workDir = Join-Path $ProjectRoot ".runtime"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$workDir = (Resolve-Path -LiteralPath $workDir).Path

$canonicalRisk = [pscustomobject]@{
  version = 2
  trendFixedLot = [double]$risk.trendFixedLot
  sidewayRiskPercent = [double]$risk.sidewayRiskPercent
  sidewayMaxLot = [double]$risk.sidewayMaxLot
  trendFixedTpEnabled = [bool]$risk.trendFixedTpEnabled
  trendFixedTpDistance = [double]$risk.trendFixedTpDistance
  sidewayFixedTpEnabled = [bool]$risk.sidewayFixedTpEnabled
  sidewayFixedTpDistance = [double]$risk.sidewayFixedTpDistance
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "new-machine-bootstrap"
}
Write-JsonAtomic -Path (Join-Path $workDir "phase7c-lot-settings.json") -Value $canonicalRisk

$liveRisk = [pscustomobject]@{
  version = 2
  accountMode = "LIVE"
  accountLogin = [long]$liveIdentity.login
  server = [string]$liveIdentity.server
  profileFingerprint = [string]$liveIdentity.profileFingerprint
  trendFixedLot = [double]$risk.trendFixedLot
  sidewayRiskPercent = [double]$risk.sidewayRiskPercent
  sidewayMaxLot = [double]$risk.sidewayMaxLot
  trendFixedTpEnabled = [bool]$risk.trendFixedTpEnabled
  trendFixedTpDistance = [double]$risk.trendFixedTpDistance
  sidewayFixedTpEnabled = [bool]$risk.sidewayFixedTpEnabled
  sidewayFixedTpDistance = [double]$risk.sidewayFixedTpDistance
  appliesTo = "NEW_POSITIONS_ONLY"
  martingale = $false
  recoveryLotEscalation = $false
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "new-machine-bootstrap"
}
Write-JsonAtomic -Path (Get-Phase7CRiskProfilePath $workDir "LIVE") -Value $liveRisk
[void](Assert-Phase7CLiveRiskProfileBinding -Profile $liveRisk -LiveEnvFile $liveEnvDestination -Label "New-machine LIVE risk profile")

$accountState = [pscustomobject]@{
  version = 1
  accountMode = "LIVE"
  liveExecutionEnabled = $true
  envFile = $liveEnvDestination
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "new-machine-bootstrap"
}
Write-JsonAtomic -Path (Join-Path $workDir "phase7c-account-mode.json") -Value $accountState

$botMode = [pscustomobject]@{
  mode = "PAUSE"
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "new-machine-bootstrap"
}
Write-JsonAtomic -Path (Join-Path $workDir "phase7c-bot-mode.json") -Value $botMode

$armPath = Get-Phase7CLiveArmPath $workDir
Remove-Item -LiteralPath $armPath -Force -ErrorAction SilentlyContinue
[void](Write-Phase7CLiveAuthorizationState -WorkDir $workDir -LiveEnvFile $liveEnvDestination -AuthorizedBy "new-machine-bootstrap")

if (-not [string]::IsNullOrWhiteSpace($StrategyEntryConditionsFile)) {
  $strategyRaw = Get-Content -LiteralPath $StrategyEntryConditionsFile -Raw | ConvertFrom-Json
  if ($null -eq $strategyRaw -or [int]$strategyRaw.version -le 0) {
    throw "Strategy entry conditions migration file must contain a persisted version > 0."
  }
  Copy-Item -LiteralPath $StrategyEntryConditionsFile -Destination (Join-Path $workDir "phase7c-strategy-entry-conditions.json") -Force
  Write-Step "STRATEGY_ENTRY_CONFIG" "MIGRATED"
} else {
  Write-Step "STRATEGY_ENTRY_CONFIG" "SAFE_DEFAULT"
}

$taskConfig = [pscustomobject]@{
  version = 2
  accountMode = "LIVE"
  demoOnly = $false
  liveExecutionEnabled = $true
  armed = $true
  workDir = $workDir
  controlApiUrl = "http://127.0.0.1:$ApiPort"
  envFile = $liveEnvDestination
  telegramEnvFile = $telegramEnvDestination
  nodePath = $nodeExe
  pnpmPath = $pnpmExe
  trendFixedVolume = [double]$risk.trendFixedLot
  sidewayRiskPercent = [double]$risk.sidewayRiskPercent
  sidewayMaxLot = [double]$risk.sidewayMaxLot
}
Write-JsonAtomic -Path (Join-Path $workDir "phase7c-executor-task-config.json") -Value $taskConfig
Write-Step "RUNTIME_CONFIG" "PASS|BOT_MODE=PAUSE|LIVE_ARM=DISARMED"

Push-Location $ProjectRoot
try {
  Invoke-Checked $pnpmExe @("install", "--frozen-lockfile") "pnpm install"
  Invoke-Checked $pnpmExe @("build") "Workspace build"
} finally {
  Pop-Location
}
Write-Step "NODE_BUILD" "PASS"

$bridgeDir = Join-Path $ProjectRoot "packages\mt5-broker\bridge"
$venvPython = Join-Path $bridgeDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
  Push-Location $bridgeDir
  try {
    Invoke-Checked $pyExe @("-3", "-m", "venv", ".venv") "Bridge Python venv creation"
  } finally {
    Pop-Location
  }
}
Invoke-Checked $venvPython @("-m", "pip", "install", "--upgrade", "pip") "Bridge pip upgrade"
Invoke-Checked $venvPython @("-m", "pip", "install", "-r", (Join-Path $bridgeDir "requirements.txt")) "Bridge Python dependencies"
Write-Step "BRIDGE_DEPENDENCIES" "PASS"

$bridgeTaskInstaller = Join-Path $ProjectRoot "scripts\register-phase7c-account-bridge-task-local.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bridgeTaskInstaller
if ($LASTEXITCODE -ne 0) { throw "Phase7C account bridge task registration failed." }
Start-ScheduledTask -TaskName "XAUUSD-Phase7C-Bridge" -ErrorAction Stop

$bridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$bridgeHeaders = @{ "x-mt5-api-key" = $envInfo.apiKey }
$bridgeHealth = Wait-Bridge `
  -BaseUrl $bridgeBase `
  -Headers $bridgeHeaders `
  -ExpectedLogin ([long]$liveIdentity.login) `
  -ExpectedServer ([string]$liveIdentity.server) `
  -Timeout $TimeoutSeconds
Assert-FlatBroker -BaseUrl $bridgeBase -Headers $bridgeHeaders -Stage "BRIDGE_PREFLIGHT"
Write-Step "BRIDGE" "PASS|SESSION=$($bridgeHealth.bridgeSessionId)|LIVE_ARM=DISARMED"

Register-WebTask -Root $ProjectRoot -WorkDir $workDir -BridgeEnv $liveEnvDestination -ApiPortValue $ApiPort -WebPortValue $WebPort
Start-ScheduledTask -TaskName "XAUUSD-Phase7B-Web" -ErrorAction Stop
$apiBase = "http://127.0.0.1:$ApiPort"
Wait-Api -ApiBase $apiBase -Timeout $TimeoutSeconds

$pause = Invoke-RestMethod `
  -Uri "$apiBase/api/v1/phase7c/bot-mode" `
  -Method Post `
  -ContentType "application/json" `
  -Body (@{ mode = "PAUSE"; source = "new-machine-bootstrap" } | ConvertTo-Json -Compress) `
  -TimeoutSec 10
if ([string]$pause.state.mode -ne "PAUSE") {
  throw "Control API did not confirm PAUSE on the new machine."
}

$armCapability = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c-live-arm-control/capability" -Method Get -TimeoutSec 8
if ([string]$armCapability.liveArmStatus -ne "DISARMED" -or [bool]$armCapability.liveExecutionArmed) {
  throw "New machine must remain DISARMED before executor bootstrap."
}
Write-Step "CONTROL_API" "PASS|BOT_MODE=PAUSE|ARM=DISARMED"

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$executorTaskInstaller = Join-Path $ProjectRoot "scripts\register-phase7c-executor-task-local.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $executorTaskInstaller `
  -TaskName "XAUUSD-Phase7C-Executors" `
  -ProjectRoot $ProjectRoot `
  -Create `
  -PrincipalUserId "SYSTEM" `
  -PrincipalLogonType "ServiceAccount" `
  -ApiUserSid $currentSid
if ($LASTEXITCODE -ne 0) { throw "Phase7C executor task registration failed." }
Write-Step "EXECUTOR_TASK" "PASS|PRINCIPAL=SYSTEM"

[void](Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/lifecycle/start" -Method Post -TimeoutSec 70)
[void](Wait-LifecycleReady -ApiBase $apiBase -Timeout $TimeoutSeconds)
Assert-FlatBroker -BaseUrl $bridgeBase -Headers $bridgeHeaders -Stage "PRE_ACCEPTANCE"
Write-Step "INITIAL_LIFECYCLE" "PASS|MODE=PAUSE|ARM=DISARMED"

Push-Location $ProjectRoot
try {
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Production working tree must remain clean before canonical acceptance. status=$($dirty -join ';')"
  }
} finally {
  Pop-Location
}

$recovery = Join-Path $ProjectRoot "scripts\recover-phase7c-runtime-ready-stable-deploy-local.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $recovery -ExpectedCommit $ExpectedCommit -TimeoutSeconds $TimeoutSeconds
if ($LASTEXITCODE -ne 0) {
  throw "Canonical runtime-ready stable acceptance failed."
}
Write-Step "CANONICAL_ACCEPTANCE" "PASS"

$finalMode = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 8
$finalArm = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c-live-arm-control/capability" -Method Get -TimeoutSec 8
$finalLifecycle = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/lifecycle" -Method Get -TimeoutSec 8
$finalSource = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/runtime-source-attestation" -Method Get -TimeoutSec 8

if ([string]$finalMode.state.mode -ne "PAUSE") { throw "Final bot mode is not PAUSE." }
if ([string]$finalArm.liveArmStatus -ne "DISARMED" -or [bool]$finalArm.liveExecutionArmed) { throw "Final LIVE ARM is not DISARMED." }
if (-not [bool]$finalLifecycle.running -or -not [bool]$finalLifecycle.ready) { throw "Final lifecycle is not RUNNING/READY." }
if ([string]$finalSource.deployment.sourceCommit -ne $ExpectedCommit) {
  throw "Final runtime source commit mismatch. expected=$ExpectedCommit actual=$($finalSource.deployment.sourceCommit)"
}
if ([string]$finalSource.overall -ne "EXACT_MATCH") {
  throw "Final runtime source attestation is not EXACT_MATCH. actual=$($finalSource.overall)"
}
Assert-FlatBroker -BaseUrl $bridgeBase -Headers $bridgeHeaders -Stage "FINAL"

if (-not $SkipPanelInstall) {
  $panelInstaller = Join-Path $ProjectRoot "scripts\install-phase7c-mt5-decision-panel-local.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $panelInstaller -BridgeEnv $liveEnvDestination
  if ($LASTEXITCODE -ne 0) { throw "MT5 decision panel installation failed." }
  Write-Step "MT5_PANEL" "PASS"
} else {
  Write-Step "MT5_PANEL" "SKIPPED"
}

Write-Host "PHASE7C_NEW_MACHINE_STATUS=PASS"
Write-Host "PHASE7C_NEW_MACHINE_SOURCE_COMMIT=$ExpectedCommit"
Write-Host "PHASE7C_NEW_MACHINE_SOURCE_ATTESTATION=EXACT_MATCH"
Write-Host "PHASE7C_NEW_MACHINE_ACCOUNT_MODE=LIVE"
Write-Host "PHASE7C_NEW_MACHINE_BOT_MODE=PAUSE"
Write-Host "PHASE7C_NEW_MACHINE_ARM=DISARMED"
Write-Host "PHASE7C_NEW_MACHINE_POSITIONS=0"
Write-Host "PHASE7C_NEW_MACHINE_PENDING_ORDERS=0"
Write-Host "PHASE7C_NEW_MACHINE_LIVE_TEST_ORDER=NONE"
Write-Host "PHASE7C_NEW_MACHINE_NEXT_ACTION=VERIFY_THEN_MANUAL_AUTO_AND_ARM"
