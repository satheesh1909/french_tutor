<#
  Installs the local Piper voice: a small Python environment and a handful of voice models.
  About 450 MB and a couple of minutes. No GPU needed — Piper runs on the CPU, faster than real time.

  Run it once, from the project folder:
      powershell -ExecutionPolicy Bypass -File .\piper_server\setup.ps1

  Afterwards, "npm run piper" starts the server, and start-tutor.cmd starts it with everything else.

  Switches:
    -Python  path to a Python 3.10-3.12 executable
    -Voices  which voices to fetch; the default is three French and three English ones
#>
param(
  [string]$Python = "",
  [string[]]$Voices = @(
    "fr_FR-siwis-medium",
    "fr_FR-upmc-medium",
    "fr_FR-tom-medium",
    "en_GB-cori-high",
    "en_GB-jenny_dioco-medium",
    "en_GB-alan-medium"
  )
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
Set-Location $here

function Find-Python {
  if ($Python) { return $Python }
  # "py -3.12" writes to stderr when that version isn't installed, and a stop-on-error script would
  # treat that as fatal instead of trying the next one. So keep the probe quiet and judge it by the
  # exit code alone.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    foreach ($version in @("3.12", "3.11")) {
      $found = & py "-$version" -c "import sys; print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $found) { return ($found | Select-Object -Last 1).ToString().Trim() }
    }
  } finally {
    $ErrorActionPreference = $previous
  }
  $fallback = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $fallback) { throw "No Python found. Install Python 3.12 from python.org and run this again." }
  return $fallback
}

$python = Find-Python
Write-Host "Using $python"

# 1. A private environment. This one is small: Piper needs onnxruntime, not PyTorch.
$venv = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $venv)) {
  Write-Host "Creating the virtual environment..."
  & $python -m venv (Join-Path $here ".venv")
}
& $venv -m pip install --upgrade pip --quiet
Write-Host "Installing Piper..."
& $venv -m pip install --quiet piper-tts
if ($LASTEXITCODE -ne 0) { throw "Piper didn't install." }

# 2. The voices. Each is an .onnx and an .onnx.json, about 60 MB a pair.
$voiceDir = Join-Path $here "voices"
New-Item -ItemType Directory -Force $voiceDir | Out-Null
Write-Host "Fetching voices (about 450 MB)..."
$list = $Voices -join " "
& $venv -c @"
import sys
from pathlib import Path
from piper.download_voices import download_voice
out = Path(sys.argv[1])
for name in sys.argv[2:]:
    if (out / (name + '.onnx')).exists():
        print('  have', name)
        continue
    download_voice(name, out)
    print('  got', name)
"@ $voiceDir @Voices
if ($LASTEXITCODE -ne 0) { throw "A voice didn't download. Check the names against https://huggingface.co/rhasspy/piper-voices" }

# 3. Prove it speaks.
& $venv -c @"
import time
from piper import PiperVoice
voice = PiperVoice.load(r'$voiceDir\fr_FR-siwis-medium.onnx')
start = time.time()
chunks = list(voice.synthesize('Bonjour, on commence le cours de francais.'))
seconds = sum(len(c.audio_float_array) for c in chunks) / chunks[0].sample_rate
took = time.time() - start
print(f'Spoke {seconds:.1f}s of French in {took:.2f}s ({seconds / took:.0f}x faster than real time).')
"@
if ($LASTEXITCODE -ne 0) { throw "Piper installed but couldn't speak." }

Write-Host ""
Write-Host "Done. Start her with:  npm run piper" -ForegroundColor Green
Write-Host "Then choose Voice - Local (Piper) on the Settings page."
