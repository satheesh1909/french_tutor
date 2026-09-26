<#
  Opens the tutor in its own chromeless window, so it feels like an app rather than a browser tab.
  Falls back to the default browser if neither Edge nor Chrome is installed.
#>
param([string]$Url = "http://localhost:3000")

$browsers = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)

foreach ($browser in $browsers) {
  if (Test-Path $browser) {
    # A separate profile directory keeps the microphone permission and window size to the tutor.
    $profileDir = Join-Path $env:LOCALAPPDATA "FrenchTutor\browser"
    Start-Process -FilePath $browser -ArgumentList "--app=$Url", "--user-data-dir=`"$profileDir`"", "--window-size=1280,860"
    exit 0
  }
}

Start-Process $Url
