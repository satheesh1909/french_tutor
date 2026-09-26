<#
  Starts the French tutor and opens it in its own window.

  You don't need to run this by hand: double-click start-tutor.cmd, or the
  "French Tutor" shortcut that "Create desktop shortcut.cmd" makes for you.

  Switches:
    -Dev        development server with hot reload, instead of the built app
    -Port 3000  which port to serve on
    -NoBrowser  start the server but don't open a window
    -Stop       stop a tutor that is already running
#>
param(
  [int]$Port = 3000,
  [switch]$Dev,
  [switch]$NoBrowser,
  [switch]$Stop
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$pidFile = Join-Path $PSScriptRoot ".tutor.pids"
$appUrl = "http://localhost:$Port"

function Test-Ready([string]$url, [int]$timeoutSec = 3) {
  try { return (Invoke-WebRequest -Uri $url -TimeoutSec $timeoutSec -UseBasicParsing).StatusCode -eq 200 }
  catch { return $false }
}

function Stop-Tutor {
  $stopped = 0
  if (Test-Path $pidFile) {
    foreach ($line in Get-Content $pidFile) {
      $id = 0
      if ([int]::TryParse($line, [ref]$id)) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop; $stopped++ } catch {}
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  if ($stopped -eq 0) {
    # No usable pid file: fall back to the processes this launcher would have started.
    $leftovers = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match 'next(\.js)?.{0,40}\bstart\b' -or $_.CommandLine -match 'whisper_server' -or $_.CommandLine -match 'avatar_server') }
    foreach ($p in $leftovers) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $stopped++ } catch {}
    }
  }
  Write-Host "Stopped $stopped process(es)."
}

if ($Stop) { Stop-Tutor; exit 0 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js isn't installed. Get it from https://nodejs.org and run this again." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

# Already running? Just show it.
if (Test-Ready "$appUrl/api/health") {
  Write-Host "The tutor is already running at $appUrl."
  if (-not $NoBrowser) { & (Join-Path $PSScriptRoot "open-tutor.ps1") -Url $appUrl }
  exit 0
}

$started = @()

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
  Write-Host "First run: installing dependencies, this takes a couple of minutes..."
  & npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
}

# --- Whisper (optional): exact word timings for speaking speed ---
$whisperUrl = "http://127.0.0.1:8765/health"
if (Test-Ready $whisperUrl 2) {
  Write-Host "Whisper is already running."
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  Write-Host "Starting Whisper (first start can take a minute while the model loads)..."
  $w = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run whisper" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  $started += $w.Id
} else {
  Write-Host "Python isn't installed, so speaking speed will be estimated instead of measured." -ForegroundColor DarkYellow
}

# --- Avatar (optional): lip-syncs her photo to her voice on the GPU ---
$avatarPython = Join-Path $PSScriptRoot "avatar_server\.venv\Scripts\python.exe"
if (Test-Ready "http://127.0.0.1:8766/health" 2) {
  Write-Host "The avatar server is already running."
} elseif (Test-Path $avatarPython) {
  Write-Host "Starting the avatar (about a minute to warm up the GPU)..."
  $a = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run avatar" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  $started += $a.Id
} else {
  Write-Host "No avatar server installed, so her photo won't move. See README." -ForegroundColor DarkYellow
}

# --- The app itself ---
if (-not $Dev) {
  # Rebuild only when something in the project is newer than the last build.
  $buildId = Join-Path $PSScriptRoot ".next\BUILD_ID"
  $newest = Get-ChildItem -Path (Join-Path $PSScriptRoot "src"), (Join-Path $PSScriptRoot "package.json"), (Join-Path $PSScriptRoot "next.config.ts") -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $needsBuild = -not (Test-Path $buildId) -or ($newest -and (Get-Item $buildId).LastWriteTime -lt $newest.LastWriteTime)
  if ($needsBuild) {
    Write-Host "Building the app (only needed after changes)..."
    & npm run build
    if ($LASTEXITCODE -ne 0) {
      Write-Host "The build failed, so starting in development mode instead." -ForegroundColor DarkYellow
      $Dev = $true
    }
  }
}

$mode = if ($Dev) { "dev" } else { "start" }
Write-Host "Starting the tutor ($mode) on port $Port..."
$app = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run $mode -- --port $Port" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
$started += $app.Id
$started | Set-Content -Path $pidFile -Encoding ascii

# --- Wait for it to answer, then open the window ---
$deadline = (Get-Date).AddSeconds(120)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Ready "$appUrl/api/health") { $ready = $true; break }
  if ($app.HasExited) { break }
  Start-Sleep -Milliseconds 700
}

if (-not $ready) {
  Write-Host "The tutor didn't start. Run 'npm run $mode' in this folder to see why." -ForegroundColor Red
  Stop-Tutor
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "  Charlotte is ready at $appUrl" -ForegroundColor Green
Write-Host "  To stop her later, run stop-tutor.cmd in this folder."
Write-Host ""
if (-not $NoBrowser) { & (Join-Path $PSScriptRoot "open-tutor.ps1") -Url $appUrl }
Start-Sleep -Seconds 2
