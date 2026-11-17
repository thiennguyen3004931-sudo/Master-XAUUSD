Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*uvicorn mt5_bridge.app:app*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
