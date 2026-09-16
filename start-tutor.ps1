# Starts the local Whisper server in its own window, then the tutor app in this one.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File .\start-tutor.ps1

Set-Location $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot'; npm run whisper" -WindowStyle Minimized

Write-Host "Whisper is starting in a separate (minimised) window."
Write-Host "The tutor will be at http://localhost:3000 once it says Ready. Press Ctrl+C here to stop it."
npm run dev
