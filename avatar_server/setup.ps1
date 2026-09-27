<#
  Installs the local lip-sync avatar: a Python environment, the Wav2Lip code and its model weights.
  About 6 GB of downloads and 20-40 minutes, mostly waiting for PyTorch.

  Run it once, from the project folder:
      powershell -ExecutionPolicy Bypass -File .\avatar_server\setup.ps1

  Afterwards, "npm run avatar" starts the server, and start-tutor.cmd starts it with everything else.

  Switches:
    -Python  path to a Python 3.11 or 3.12 executable (PyTorch has no wheels for very new versions)
    -Cuda    CUDA wheel tag, e.g. cu128 (default) or cu130; use "cpu" for a machine with no NVIDIA card
#>
param(
  [string]$Python = "",
  [string]$Cuda = "cu128"
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

$python = Find-Python
Write-Host "Using $python"

# 1. A private environment, so this can't disturb the Whisper server's packages.
$venv = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $venv)) {
  Write-Host "Creating the virtual environment..."
  & $python -m venv (Join-Path $here ".venv")
}
& $venv -m pip install --upgrade pip --quiet

# 2. PyTorch. This is the big one.
Write-Host "Installing PyTorch ($Cuda). This is several gigabytes and takes a while..."
if ($Cuda -eq "cpu") {
  & $venv -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
} else {
  & $venv -m pip install torch torchvision --index-url "https://download.pytorch.org/whl/$Cuda"
}
if ($LASTEXITCODE -ne 0) { throw "PyTorch didn't install. Try a different -Cuda tag (cu128, cu130) or -Python 3.12." }

Write-Host "Installing the rest..."
& $venv -m pip install --quiet "numpy<2" "librosa==0.10.2.post1" opencv-python scipy tqdm imageio-ffmpeg soundfile numba

# 3. Wav2Lip itself, patched for modern libraries.
if (-not (Test-Path (Join-Path $here "wav2lip"))) {
  Write-Host "Cloning Wav2Lip..."
  & git clone --depth 1 https://github.com/Rudrabha/Wav2Lip.git (Join-Path $here "wav2lip")
}
& $venv (Join-Path $here "patch_wav2lip.py")

# 4. Model weights, from a long-standing mirror on Hugging Face.
$checkpoint = Join-Path $here "wav2lip\checkpoints\wav2lip_gan.pth"
$detector = Join-Path $here "wav2lip\face_detection\detection\sfd\s3fd.pth"
New-Item -ItemType Directory -Force (Split-Path $checkpoint) | Out-Null
New-Item -ItemType Directory -Force (Split-Path $detector) | Out-Null
if (-not (Test-Path $checkpoint)) {
  Write-Host "Downloading the lip-sync model (436 MB)..."
  Invoke-WebRequest -Uri "https://huggingface.co/camenduru/Wav2Lip/resolve/main/checkpoints/wav2lip_gan.pth" -OutFile $checkpoint
}
if (-not (Test-Path $detector)) {
  Write-Host "Downloading the face detector (90 MB)..."
  Invoke-WebRequest -Uri "https://huggingface.co/camenduru/Wav2Lip/resolve/main/face_detection/detection/sfd/s3fd.pth" -OutFile $detector
}

# 5. Check the GPU is actually usable.
& $venv -c "import torch; print('CUDA available:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only (slow)')"

Write-Host ""
Write-Host "Done. Start her with:  npm run avatar" -ForegroundColor Green
Write-Host "Then choose Avatar - Photo on the Settings page."
