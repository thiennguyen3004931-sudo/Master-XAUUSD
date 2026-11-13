Option Explicit

Dim shell, fso, scriptDir, psScript, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = fso.BuildPath(scriptDir, "open-phase7b-demo-v19-local.ps1")

If Not fso.FileExists(psScript) Then
  MsgBox "Khong tim thay script mo Phase7B: " & psScript, vbCritical, "XAUUSD AI MASTER"
  WScript.Quit 1
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psScript & """"
shell.Run command, 0, False
