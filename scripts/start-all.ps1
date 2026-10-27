# one-click launcher for the qq-bridge-plus stack
# components: QQ / SnowLuma / GPT-SoVITS / qq-bridge / DSH
#
# usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-all.ps1
#   ... -Status
#   ... -SkipQq -SkipDsh -SkipTts -SkipBridge -SkipSnowLuma
param(
  [switch]$Status,
  [switch]$SkipQq,
  [switch]$SkipDsh,
  [switch]$SkipTts,
  [switch]$SkipBridge,
  [switch]$SkipSnowLuma,
  [switch]$NoBrowser
)

# system PATH often lacks node.exe; make it reachable for child processes
$NodeDir = 'C:\Users\Admin\tools\nodejs'
if (Test-Path (Join-Path $NodeDir 'node.exe')) { $env:PATH = $NodeDir + ';' + $env:PATH }
$NodeExe = Join-Path $NodeDir 'node.exe'

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root 'state'
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
$LogFile = Join-Path $StateDir 'start-all.log'

$SnowLumaDir = 'E:\Program Files\SnowLuma'
$SnowLumaEntry = Join-Path $SnowLumaDir 'index.mjs'
$TtsDir = 'E:\GBT-Sovits'
$TtsBat = Join-Path $TtsDir 'run_api.bat'
$DshExe = 'E:\Program Files\DSH\DeepSeek Harness.exe'
$QqExe = 'D:\Program Files\Tencent\QQNT\QQ.exe'
$BridgeDir = $Root

function Write-Log([string]$Message) {
  $line = '[' + (Get-Date).ToString('MM-dd HH:mm:ss') + '] ' + $Message
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(800)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Test-Proc([string]$Name) {
  try { return [bool](Get-Process -Name $Name -ErrorAction Stop) } catch { return $false }
}

function Wait-Port([int]$Port, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (Test-Port $Port) { return $true }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Start-Hidden([string]$FilePath, [string]$Arguments, [string]$WorkDir) {
  if ($Arguments) {
    Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkDir -WindowStyle Hidden | Out-Null
  } else {
    Start-Process -FilePath $FilePath -WorkingDirectory $WorkDir -WindowStyle Hidden | Out-Null
  }
}

# SnowLuma WebUI defaults to 5099 but falls back to 5100+ when the port is taken.
function Get-SnowLumaWebPort {
  $logDir = Join-Path $SnowLumaDir 'logs'
  if (Test-Path $logDir) {
    $log = Get-ChildItem $logDir -Filter 'snowluma-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
      $hit = Select-String -Path $log.FullName -Pattern 'WebUI\] listening http://127\.0\.0\.1:(\d+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($hit -and $hit.Matches.Count -gt 0) {
        $port = 0
        if ([int]::TryParse($hit.Matches[0].Groups[1].Value, [ref]$port)) {
          if (Test-Port $port) { return $port }
        }
      }
    }
  }
  foreach ($p in 5099..5109) { if (Test-Port $p) { return $p } }
  return 0
}

function Open-Console([string]$Url) {
  try {
    Start-Process $Url | Out-Null
    $shown = $Url
    if ($shown.Contains('?token=')) { $shown = $shown.Substring(0, $shown.IndexOf('?token=')) }
    Write-Log ('opened: ' + $shown)
  } catch {
    $shown = $Url
    if ($shown.Contains('?token=')) { $shown = $shown.Substring(0, $shown.IndexOf('?token=')) }
    Write-Log ('[warn] cannot open browser: ' + $shown)
  }
}

function Get-States {
  return [pscustomobject]@{
    QQ       = Test-Proc 'QQ'
    SnowHttp = Test-Port 3000
    SnowWs   = Test-Port 3001
    Tts      = Test-Port 9880
    Dsh      = Test-Proc 'DeepSeek Harness'
    Bridge   = Test-Port 3100
  }
}

function Write-Summary($s) {
  Write-Log ('QQ=' + $(if ($s.QQ) { 'ok' } else { 'no' }) +
    '  SnowLuma=' + $(if ($s.SnowHttp -and $s.SnowWs) { 'ok' } else { 'no' }) +
    '  TTS=' + $(if ($s.Tts) { 'ok' } else { 'no' }) +
    '  DSH=' + $(if ($s.Dsh) { 'ok' } else { 'no' }) +
    '  bridge=' + $(if ($s.Bridge) { 'ok' } else { 'no' }))
}

$s = Get-States

if ($Status) {
  Write-Log '===== status ====='
  Write-Log ('QQ         : ' + $(if ($s.QQ) { 'running' } else { 'stopped' }))
  Write-Log ('SnowLuma   : ' + $(if ($s.SnowHttp -and $s.SnowWs) { 'running (3000/3001)' } elseif ($s.SnowHttp) { 'starting (3000 only)' } else { 'stopped' }))
  Write-Log ('GPT-SoVITS : ' + $(if ($s.Tts) { 'running (9880)' } else { 'stopped' }))
  Write-Log ('DSH        : ' + $(if ($s.Dsh) { 'running' } else { 'stopped' }))
  Write-Log ('qq-bridge  : ' + $(if ($s.Bridge) { 'running (3100)' } else { 'stopped' }))
  Write-Log '=================='
  exit 0
}

Write-Log '===== one-click start ====='

# 1) DSH
if (-not $SkipDsh) {
  if ($s.Dsh) { Write-Log 'DSH already running, skip' }
  elseif (Test-Path $DshExe) { Start-Hidden $DshExe '' (Split-Path -Parent $DshExe); Write-Log 'DSH started' }
  else { Write-Log ('[warn] DSH exe not found: ' + $DshExe) }
}

# 2) QQ (must be logged in before SnowLuma can hook it)
if (-not $SkipQq) {
  if ($s.QQ) { Write-Log 'QQ already running, skip' }
  elseif (Test-Path $QqExe) {
    Start-Hidden $QqExe '' (Split-Path -Parent $QqExe)
    Write-Log 'QQ started (make sure it finishes login)'
    Start-Sleep -Seconds 10
  } else { Write-Log ('[warn] QQ exe not found: ' + $QqExe) }
}

# 3) SnowLuma: run node index.mjs directly (its launcher.bat pauses on failure),
#    hookAutoLoad=true in its config/runtime.json makes it hook QQ automatically.
if (-not $SkipSnowLuma) {
  if ($s.SnowHttp -and $s.SnowWs) { Write-Log 'SnowLuma already running, skip' }
  elseif (Test-Path $SnowLumaEntry) {
    Write-Log 'starting SnowLuma...'
    Start-Hidden $NodeExe 'index.mjs' $SnowLumaDir
    if (-not (Wait-Port 3000 120)) {
      Write-Log ('[warn] SnowLuma HTTP not ready within 120 s (port 3000). Check QQ login and ' + (Join-Path $SnowLumaDir 'logs'))
    } elseif (-not (Wait-Port 3001 20)) {
      Write-Log '[warn] SnowLuma WS not ready within 20 s (port 3001)'
    } else { Write-Log 'SnowLuma ready (3000/3001)' }
  } else { Write-Log ('[warn] SnowLuma not found: ' + $SnowLumaEntry) }
}

# 4) GPT-SoVITS
if (-not $SkipTts) {
  if ($s.Tts) { Write-Log 'GPT-SoVITS already running, skip' }
  elseif (Test-Path $TtsBat) {
    Write-Log 'starting GPT-SoVITS...'
    Start-Hidden 'cmd.exe' ('/c ""' + $TtsBat + '""') $TtsDir
    if (-not (Wait-Port 9880 150)) { Write-Log '[warn] GPT-SoVITS not ready within 150 s (port 9880)' }
    else { Write-Log 'GPT-SoVITS ready (9880)' }
  } else { Write-Log ('[warn] run_api.bat not found: ' + $TtsBat) }
}

# 5) qq-bridge (start.bat keeps it alive in a loop)
if (-not $SkipBridge) {
  if ($s.Bridge) { Write-Log 'qq-bridge already running, skip' }
  elseif (Test-Path (Join-Path $BridgeDir 'start.bat')) {
    Write-Log 'starting qq-bridge...'
    Start-Hidden 'cmd.exe' ('/c ""' + (Join-Path $BridgeDir 'start.bat') + '""') $BridgeDir
    if (-not (Wait-Port 3100 60)) { Write-Log '[warn] qq-bridge console not ready within 60 s (port 3100)' }
    else { Write-Log 'qq-bridge ready (3100)' }
  } else {
    Start-Hidden $NodeExe 'src\bridge.js' $BridgeDir
    if (-not (Wait-Port 3100 60)) { Write-Log '[warn] qq-bridge console not ready within 60 s (port 3100)' }
    else { Write-Log 'qq-bridge ready (3100)' }
  }
}

$s = Get-States
Write-Summary $s

# after everything is up, open the SnowLuma WebUI and the qq-bridge console
if (-not $NoBrowser) {
  $snowPort = Get-SnowLumaWebPort
  if ($snowPort -gt 0) { Open-Console ('http://127.0.0.1:' + $snowPort + '/') }
  else { Write-Log '[warn] SnowLuma WebUI port not found, skip opening' }
  if (Test-Port 3100) {
    $bridgeUrl = 'http://127.0.0.1:3100/'
    $tokenFile = Join-Path $Root 'state\console-token'
    if (Test-Path $tokenFile) {
      $consoleToken = ''
      try { $consoleToken = ([string](Get-Content -LiteralPath $tokenFile -Raw -ErrorAction Stop)).Trim() } catch { }
      if ($consoleToken) { $bridgeUrl = $bridgeUrl + '?token=' + [uri]::EscapeDataString($consoleToken) }
    }
    Open-Console $bridgeUrl
  }
  else { Write-Log '[warn] qq-bridge console (3100) not ready, skip opening' }
}

Write-Log '===== done ====='

