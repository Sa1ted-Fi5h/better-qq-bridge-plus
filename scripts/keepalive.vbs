' Silent launcher for keepalive.ps1 (no console window at all).
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\DSH???\qq-bridge-plus\scripts\keepalive.ps1"" -Quiet", 0, False
