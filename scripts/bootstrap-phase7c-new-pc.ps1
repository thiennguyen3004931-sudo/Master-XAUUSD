param(
  [string]$WorkDir = ".runtime",
  [switch]$InstallDependencies,
  [switch]$CreateLocalConfigTemplates,
  [switch]$Build,
  [switch]$RegisterAccountSwitchTask,
  [switch]$InstallMt5Panels
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BridgeDir = Join-Path $ProjectRoot "packages\mt5-broker\bridge"
$DemoExample = Join-Path $BridgeDir ".env.phase7b-demo.example"
$LiveExample = Join-Path $BridgeDir ".env.phase7b-live.example"
$DemoProfile = Join-Path $BridgeDir ".env.phase7b-demo"
$LiveProfile = Join-Path $BridgeDir ".env.phase7b-live"
$RegisterSwitch = Join-Path $PSScriptRoot "register-phase7c-account-switch-task-local.ps1"
$PanelInstaller = Join-Path $PSScriptRoot "install-phase7c-mt5-decision-panel-both-accounts-local.ps1"
$SourceTest = Join-Path $PSScriptRoot "test-phase7c-portable-deploy-source.mjs"

function Get-VersionTuple([string]$Raw) {
  $match = [regex]::Match($Raw, '(\d+)\.(\d+)(?:\.(\d+))?')
  if (-not $match.Success) { return $null }
  return @(
    [int]$match.Groups[1].Value,
    [int]$match.Groups[2].Value,
    $(if ($match.Groups[3].Success) { [int]$match.Groups[3].Value } else { 0 })
  )
}

function Assert-MinVersion([string]$Name, [string]$Raw, [int]$Major, [int]$Minor = 0) {
  $parts = Get-VersionTuple $Raw
  if ($null -eq $parts) { throw "Could not parse $Name version: $Raw" }
  if ($parts[0] -lt $Major -or ($parts[0] -eq $Major -and $parts[1] -lt $Minor)) {
    throw "$Name $Major.$Minor+ is required. Detected=$Raw"
  }
}

function Is-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Copy-TemplateIfMissing([string]$Source, [string]$Destination, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "$Label example profile is missing: $Source" }
  if (Test-Path -LiteralPath $Destination) {
    Write-Host "PHASE7C_NEW_PC_CONFIG=$Label|EXISTS|UNCHANGED"
    return
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  Write-Host "PHASE7C_NEW_PC_CONFIG=$Label|CREATED_FROM_EXAMPLE"
}

if ($env:OS -ne "Windows_NT") {
  throw "Phase7C execution bootstrap supports Windows only. Use GitHub Codespaces for phone/browser development."
}

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP=START"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_EXECUTION_HOST=WINDOWS"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_LIVE_ARM=False"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_ACCOUNT_SWITCH=False"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_ORDER_SEND=False"

  $git = Get-Command git -ErrorAction Stop
  $node = Get-Command node -ErrorAction Stop
  $pnpm = Get-Command pnpm -ErrorAction Stop
  $python = Get-Command python -ErrorAction Stop

  $gitVersion = (& $git.Source --version | Select-Object -First 1)
  $nodeVersion = (& $node.Source --version | Select-Object -First 1)
  $pnpmVersion = (& $pnpm.Source --version | Select-Object -First 1)
  $pythonVersion = (& $python.Source --version | Select-Object -First 1)

  Assert-MinVersion -Name "Node.js" -Raw $nodeVersion -Major 24
  Assert-MinVersion -Name "pnpm" -Raw $pnpmVersion -Major 10 -Minor 18
  Assert-MinVersion -Name "Python" -Raw $pythonVersion -Major 3 -Minor 12

  Write-Host "PHASE7C_NEW_PC_PREREQ_GIT=$gitVersion"
  Write-Host "PHASE7C_NEW_PC_PREREQ_NODE=$nodeVersion"
  Write-Host "PHASE7C_NEW_PC_PREREQ_PNPM=$pnpmVersion"
  Write-Host "PHASE7C_NEW_PC_PREREQ_PYTHON=$pythonVersion"
  Write-Host "PHASE7C_NEW_PC_PREREQUISITES=PASS"

  if (Test-Path -LiteralPath $SourceTest) {
    & $node.Source $SourceTest
    if ($LASTEXITCODE -ne 0) { throw "Portable deployment source test failed." }
  }

  if ($CreateLocalConfigTemplates) {
    Copy-TemplateIfMissing -Source $DemoExample -Destination $DemoProfile -Label "DEMO"
    Copy-TemplateIfMissing -Source $LiveExample -Destination $LiveProfile -Label "LIVE"
    Write-Host "PHASE7C_NEW_PC_CONFIG_TEMPLATES=PASS"
    Write-Host "PHASE7C_NEW_PC_CONFIG_NEXT=EDIT_LOCAL_ENV_PROFILES_WITH_THIS_PC_MT5_PATH_LOGIN_SERVER_AND_API_KEY"
  } else {
    Write-Host "PHASE7C_NEW_PC_CONFIG_TEMPLATES=SKIPPED"
  }

  if ($InstallDependencies) {
    & $pnpm.Source install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

    & $python.Source -m pip install -r (Join-Path $BridgeDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Python bridge dependency install failed." }
    Write-Host "PHASE7C_NEW_PC_DEPENDENCIES=PASS"
  } else {
    Write-Host "PHASE7C_NEW_PC_DEPENDENCIES=SKIPPED"
  }

  if ($Build) {
    & $pnpm.Source --filter '@xauusd/api...' build
    if ($LASTEXITCODE -ne 0) { throw "API dependency graph build failed." }
    & $pnpm.Source --filter '@xauusd/web...' build
    if ($LASTEXITCODE -ne 0) { throw "Web dependency graph build failed." }
    Write-Host "PHASE7C_NEW_PC_BUILD=PASS"
  } else {
    Write-Host "PHASE7C_NEW_PC_BUILD=SKIPPED"
  }

  if ($RegisterAccountSwitchTask -or $InstallMt5Panels) {
    if (-not (Test-Path -LiteralPath $WorkDir)) {
      [System.IO.Directory]::CreateDirectory((Join-Path $ProjectRoot $WorkDir)) | Out-Null
    }
  }

  if ($RegisterAccountSwitchTask) {
    if (-not (Is-Administrator)) {
      throw "RegisterAccountSwitchTask requires PowerShell Administrator. No task was registered."
    }
    if (-not (Test-Path -LiteralPath $RegisterSwitch)) { throw "Account-switch task registration helper is missing." }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RegisterSwitch -WorkDir $WorkDir
    if ($LASTEXITCODE -ne 0) { throw "Account-switch Scheduled Task registration failed." }
    Write-Host "PHASE7C_NEW_PC_ACCOUNT_SWITCH_TASK=REGISTERED_NO_TRIGGER"
  } else {
    Write-Host "PHASE7C_NEW_PC_ACCOUNT_SWITCH_TASK=SKIPPED"
  }

  if ($InstallMt5Panels) {
    if (-not (Test-Path -LiteralPath $DemoProfile) -or -not (Test-Path -LiteralPath $LiveProfile)) {
      throw "MT5 panel installation requires configured local DEMO and LIVE env profiles. Create/edit them first."
    }
    if (-not (Test-Path -LiteralPath $PanelInstaller)) { throw "Dual-account MT5 panel installer is missing." }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PanelInstaller
    if ($LASTEXITCODE -ne 0) { throw "MT5 panel installation failed." }
    Write-Host "PHASE7C_NEW_PC_MT5_PANELS=PASS"
  } else {
    Write-Host "PHASE7C_NEW_PC_MT5_PANELS=SKIPPED"
  }

  $didSetup = $InstallDependencies -or $CreateLocalConfigTemplates -or $Build -or $RegisterAccountSwitchTask -or $InstallMt5Panels
  if (-not $didSetup) {
    Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_MODE=PREPARE_ONLY"
  } else {
    Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_MODE=EXPLICIT_SETUP_FLAGS_ONLY"
  }

  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_LIVE_ARM=False"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_ACCOUNT_SWITCH=False"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP_ORDER_SEND=False"
  Write-Host "PHASE7C_NEW_PC_BOOTSTRAP=PASS"
}
finally {
  Pop-Location
}
