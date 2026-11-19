$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProbeLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$GuardLibrary = Join-Path $PSScriptRoot 'lib\phase7c-startup-runner-guard.ps1'

foreach ($required in @($ProbeLibrary, $GuardLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Runtime ownership JSON sharing test dependency is missing: $required"
  }
}

. $ProbeLibrary
. $GuardLibrary

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -ne $Expected) {
    throw "$Label mismatch. expected=$Expected actual=$Actual"
  }
}

function Assert-True([bool]$Condition, [string]$Label) {
  if (-not $Condition) { throw "$Label" }
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $ProbeLibrary,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) {
  $errors | ForEach-Object { Write-Error $_ }
  throw 'Runtime ownership probe library must parse cleanly.'
}

$readerFunction = $ast.Find({
  param($node)
  return $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    [string]$node.Name -eq 'Read-Phase7CRuntimeOwnershipJson'
}, $true)
if ($null -eq $readerFunction) {
  throw 'Read-Phase7CRuntimeOwnershipJson function is missing.'
}
$readerSource = [string]$readerFunction.Extent.Text

# Regression contract: diagnostic readers must not deny FILE_SHARE_DELETE,
# otherwise the broker's atomic File.Replace heartbeat/status writer can die
# under a concurrent read on Windows.
Assert-True ($readerSource -match '\[System\.IO\.File\]::Open') `
  'Read-Phase7CRuntimeOwnershipJson must use an explicit FileStream so sharing semantics are controlled.'
Assert-True ($readerSource -match '\[System\.IO\.FileShare\]::ReadWrite') `
  'Read-Phase7CRuntimeOwnershipJson must allow concurrent read/write sharing.'
Assert-True ($readerSource -match '\[System\.IO\.FileShare\]::Delete') `
  'Read-Phase7CRuntimeOwnershipJson must allow FILE_SHARE_DELETE so File.Replace remains atomic and non-blocking.'
Assert-True ($readerSource -notmatch 'Get-Content\s+-LiteralPath\s+\$Path\s+-Raw') `
  'Read-Phase7CRuntimeOwnershipJson must not use Get-Content for broker status/heartbeat JSON reads.'

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-runtime-json-sharing-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$path = Join-Path $tempRoot 'state.json'

try {
  $missing = Read-Phase7CRuntimeOwnershipJson -Path $path
  Assert-Equal ([bool]$missing.ok) $false 'Missing JSON ok'
  Assert-Equal ([string]$missing.error) 'MISSING' 'Missing JSON error'

  Write-Phase7CJsonAtomic -Path $path -Value ([pscustomobject]@{ version = 1; marker = 'initial' }) -Depth 4
  $valid = Read-Phase7CRuntimeOwnershipJson -Path $path
  Assert-Equal ([bool]$valid.ok) $true 'Valid JSON ok'
  Assert-Equal ([int]$valid.value.version) 1 'Valid JSON version'
  Assert-Equal ([string]$valid.value.marker) 'initial' 'Valid JSON marker'

  [System.IO.File]::WriteAllText($path, '{invalid-json', [System.Text.UTF8Encoding]::new($false))
  $invalid = Read-Phase7CRuntimeOwnershipJson -Path $path
  Assert-Equal ([bool]$invalid.ok) $false 'Invalid JSON ok'
  Assert-Equal ([string]$invalid.error) 'INVALID_OR_UNREADABLE' 'Invalid JSON error'

  Write-Phase7CJsonAtomic -Path $path -Value ([pscustomobject]@{ version = 1; marker = 'stress' }) -Depth 4

  $readerJobs = @()
  $readerScript = {
    param([string]$LibraryPath, [string]$JsonPath)
    $ErrorActionPreference = 'Stop'
    . $LibraryPath
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    $failures = 0
    while ([DateTime]::UtcNow -lt $deadline) {
      $sample = Read-Phase7CRuntimeOwnershipJson -Path $JsonPath
      if (-not [bool]$sample.ok) { $failures++ }
    }
    return $failures
  }

  foreach ($index in 1..2) {
    $readerJobs += Start-Job -ScriptBlock $readerScript -ArgumentList $ProbeLibrary, $path
  }

  $writerErrors = 0
  foreach ($index in 1..300) {
    try {
      Write-Phase7CJsonAtomic -Path $path -Value ([pscustomobject]@{ version = 1; sequence = $index }) -Depth 4
    } catch {
      $writerErrors++
    }
  }

  $readerFailures = 0
  foreach ($job in $readerJobs) {
    Wait-Job -Job $job | Out-Null
    $readerFailures += [int](Receive-Job -Job $job)
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }

  Assert-Equal $writerErrors 0 'Concurrent atomic writer errors'
  Assert-Equal $readerFailures 0 'Concurrent runtime ownership reader errors'

  Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_JSON_SHARE_DELETE=PASS'
  Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_JSON_FAIL_CLOSED=PASS'
  Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_JSON_CONCURRENCY=PASS'
} finally {
  Get-Job -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Completed' } | Stop-Job -ErrorAction SilentlyContinue
  Get-Job -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
