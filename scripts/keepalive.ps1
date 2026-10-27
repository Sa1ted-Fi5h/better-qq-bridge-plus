# Keep qq-bridge / SnowLuma / GPT-SoVITS / DSH desktop alive.
# Designed to run from Task Scheduler every 5 minutes.
# All child processes are started hidden (no console window, no focus stealing).
# Writes to state\keepalive.log.
param([switch]$Quiet)

$ErrorActionPreference = 'SilentlyContinue'
$Repo = Split-Path -Parent $PSScriptRoot
$Log  = Join-Path $Repo 'state\keepalive.log'
$Node = 'C:\Users\Admin\tools\nodejs\node.exe'

function Write-Log([string]$msg) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  if (-not $Quiet) { Write-Host $line }
  try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch {}
}

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if ($task.Wait(400) -and $client.Connected) { return $true }
    return $false
  } catch { return $false } finally { $client.Close() }
}

# 1) qq-bridge: console on 3100. Start node directly (hidden), no .bat window.
if (-not (Test-Port 3100)) {
  Write-Log 'qq-bridge is down -> node src\bridge.js (hidden)'
  $lock = Join-Path $Repo 'state\bridge.lock'
  if (Test-Path $lock) { Remove-Item $lock -Force }
  Start-Process -FilePath $Node -ArgumentList 'src\bridge.js' -WorkingDirectory $Repo -WindowStyle Hidden
}

# 2) SnowLuma: OneBot HTTP 3000 / WS 3001. Run index.mjs directly (hidden).
if (-not (Test-Port 3000) -and -not (Test-Port 3001)) {
  Write-Log 'SnowLuma is down -> node index.mjs (hidden)'
  Start-Process -FilePath $Node -ArgumentList 'index.mjs' -WorkingDirectory 'E:\Program Files\SnowLuma' -WindowStyle Hidden
}

# 3) GPT-SoVITS: HTTP 9880. Run python directly (hidden).
if (-not (Test-Port 9880)) {
  Write-Log 'GPT-SoVITS is down -> python api_v2.py (hidden)'
  Start-Process -FilePath 'E:\GBT-Sovits\runtime\python.exe' -ArgumentList 'api_v2.py','-a','127.0.0.1','-p','9880' -WorkingDirectory 'E:\GBT-Sovits' -WindowStyle Hidden
}

# 4) DSH desktop: the bridge needs its Web API; MCP servers are hosted by it.
if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  Write-Log 'DSH desktop is not running -> DeepSeek Harness.exe'
  Start-Process -FilePath 'E:\Program Files\DSH\DeepSeek Harness.exe'
}
