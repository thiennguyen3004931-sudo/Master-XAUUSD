# Read-only GitHub Actions self-hosted runner diagnostic for the XAUUSD Windows machine.
# No process/service starts or stops, no tokens are read, and no MT5 operation is performed.
[CmdletBinding()]
param(
    [switch]$CheckNetwork
)
$ErrorActionPreference = 'Stop'
Write-Host '=== GitHub Actions Windows Runner: local read-only diagnostic ==='
Write-Host ('HOST=' + $env:COMPUTERNAME)
Write-Host 'EXPECTED_LABELS=self-hosted,Windows,X64,xauusd-core-ci'
try {
    $services = @(Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue)
    if ($services.Count -eq 0) {
        Write-Host 'RUNNER_SERVICE=NOT_FOUND (the runner might be launched with run.cmd)'
    } else {
        foreach ($service in $services) {
            Write-Host ('RUNNER_SERVICE=' + $service.Name + '; STATUS=' + $service.Status)
        }
    }
} catch {
    Write-Host ('RUNNER_SERVICE_QUERY_ERROR=' + $_.Exception.Message)
}
try {
    $listeners = @(Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue)
    Write-Host ('RUNNER_LISTENER_PROCESS_COUNT=' + $listeners.Count)
    foreach ($listener in $listeners) {
        Write-Host ('RUNNER_LISTENER_PID=' + $listener.Id)
    }
} catch {
    Write-Host ('RUNNER_PROCESS_QUERY_ERROR=' + $_.Exception.Message)
}
if ($CheckNetwork) {
    try {
        $reachable = Test-NetConnection -ComputerName 'github.com' -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
        Write-Host ('GITHUB_HTTPS_443_REACHABLE=' + [bool]$reachable)
    } catch {
        Write-Host ('GITHUB_NETWORK_QUERY_ERROR=' + $_.Exception.Message)
    }
}
Write-Host 'CHECK_GITHUB_UI=Repository Settings > Actions > Runners'
Write-Host 'DIAGNOSTIC_READ_ONLY=TRUE'
