<#
  Installs the local neural voice: a Python environment, XTTS-v2 and its model weights.
  About 4 GB of downloads and 15-30 minutes, mostly waiting for PyTorch.

  Run it once, from the project folder:
      powershell -ExecutionPolicy Bypass -File .\voice_server\setup.ps1

  Afterwards, "npm run voice" starts the server, and start-tutor.cmd starts it with everything else.

  Switches:
    -Python          path to a Python 3.11 or 3.12 executable (PyTorch has no wheels for very new versions)
    -Cuda            CUDA wheel tag, e.g. cu128 (default) or cu130; use "cpu" for a machine with no NVIDIA card
    -AcceptLicence   accept the XTTS model licence without being asked (see below)
#>
param(
  [string]$Python = "",
  [string]$Cuda = "cu128",
  [switch]$AcceptLicence
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
  Write-Host "Falling back to the default Python. If PyTorch won't install, pass -Python with a 3.11 or 3.12 path." -ForegroundColor DarkYellow
  return $fallback
}

# 1. The model licence, before anything is downloaded. This is the student's decision to make.
$marker = Join-Path $here ".licence-accepted"
if (-not (Test-Path $marker)) {
  Write-Host ""
  Write-Host "XTTS-v2 model licence" -ForegroundColor Cyan
  Write-Host "---------------------"
  Write-Host "The voice model is released under the Coqui Public Model License 1.0.0 (CPML),"
  Write-Host "which allows personal, non-commercial use only: you may not use the model or the"
  Write-Host "speech it produces for commercial purposes."
  Write-Host "Full terms: https://coqui.ai/cpml"
  Write-Host ""
  if (-not $AcceptLicence) {
    $answer = Read-Host "Do you accept these terms? (yes/no)"
    if ($answer -notmatch '^\s*(y|yes)\s*$') { throw "Licence not accepted, so nothing was installed." }
  }
  Set-Content -Path $marker -Encoding utf8 -Value @(
    "Coqui Public Model License 1.0.0 (CPML) accepted for XTTS-v2.",
    "https://coqui.ai/cpml",
    "Personal, non-commercial use only.",
    "Accepted on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')."
  )
  Write-Host "Accepted; recorded in voice_server/.licence-accepted." -ForegroundColor Green
}

$python = Find-Python
Write-Host "Using $python"

# 2. A private environment, so this can't disturb Whisper's or the avatar's packages.
$venv = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $venv)) {
  Write-Host "Creating the virtual environment..."
  & $python -m venv (Join-Path $here ".venv")
}
& $venv -m pip install --upgrade pip --quiet

# 3. PyTorch first, from the CUDA index, so the next step can't pull in a CPU-only build.
Write-Host "Installing PyTorch ($Cuda). This is several gigabytes and takes a while..."
if ($Cuda -eq "cpu") {
  & $venv -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
} else {
  & $venv -m pip install torch torchaudio --index-url "https://download.pytorch.org/whl/$Cuda"
}
if ($LASTEXITCODE -ne 0) { throw "PyTorch didn't install. Try a different -Cuda tag (cu128, cu130) or -Python 3.12." }

# 4. XTTS, plus two pins found the hard way:
#    - transformers 5 removed isin_mps_friendly, which XTTS imports, so stay on 4.x;
#    - from torch 2.9 audio IO moved out of torchaudio, so torchcodec is needed to read a wav.
Write-Host "Installing XTTS..."
& $venv -m pip install --quiet coqui-tts
& $venv -m pip install --quiet "transformers>=4.57,<5" torchcodec
if ($LASTEXITCODE -ne 0) { throw "XTTS didn't install." }

# 5. Fetch the model now, so the first start isn't a surprise 1.8 GB download.
Write-Host "Downloading the voice model (about 1.8 GB)..."
$env:COQUI_TOS_AGREED = "1"  # accepted above
& $venv -c "from TTS.api import TTS; t = TTS('tts_models/multilingual/multi-dataset/xtts_v2'); print('built-in speakers:', len(t.speakers))"
if ($LASTEXITCODE -ne 0) { throw "The model didn't download." }

# 6. Check the GPU is actually usable.
& $venv -c "import torch; print('CUDA available:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only (slow)')"

Write-Host ""
Write-Host "Done. Start her with:  npm run voice" -ForegroundColor Green
Write-Host "Then choose Voice - XTTS on the Settings page."
Write-Host "For a native French accent, drop a wav of a French speaker into voice_server\voices and pick it there."
