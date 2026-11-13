# Windows DPAPI CurrentUser adapter. Ephemeral stdin/stdout data only.
# No keys, private PEM, credentials, MT5 access, registry writes or on-disk modifications.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Protect', 'Unprotect')]
  [string]$Operation
)
$ErrorActionPreference = 'Stop'
$inputBytes = $null
$resultBytes = $null
$entropy = $null
try {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
  $line = [Console]::In.ReadLine()
  if ([string]::IsNullOrWhiteSpace($line) -or $line.Length -gt 98304 -or
      $line -cnotmatch '^[A-Za-z0-9+/]+={0,2}$') {
    throw 'INVALID_INPUT'
  }
  $inputBytes = [Convert]::FromBase64String($line)
  if ($inputBytes.Length -lt 1 -or $inputBytes.Length -gt 65536) {
    throw 'INVALID_LENGTH'
  }
  # Windows PowerShell 5.1 does not always resolve ProtectedData types until
  # System.Security is loaded (unlike PowerShell 7 runtimes).
  Add-Type -AssemblyName System.Security -ErrorAction Stop
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('XAUUSD_CUSTOMER_INSTALLATION_DPAPI_V1')
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($Operation -eq 'Protect') {
    $resultBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, $scope)
  } else {
    $resultBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $entropy, $scope)
  }
  if ($null -eq $resultBytes -or $resultBytes.Length -lt 1 -or $resultBytes.Length -gt 65536) {
    throw 'INVALID_OUTPUT'
  }
  [Console]::Out.WriteLine([Convert]::ToBase64String($resultBytes))
} catch {
  # Never print a crypto exception, payload or other potentially sensitive contents.
  [Console]::Error.WriteLine('CUSTOMER_DPAPI_OPERATION_FAILED')
  exit 1
} finally {
  if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
  if ($null -ne $resultBytes) { [Array]::Clear($resultBytes, 0, $resultBytes.Length) }
  if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
}
