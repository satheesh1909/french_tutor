<#
  Puts a "French Tutor" shortcut on the Desktop and in the Start menu, with the app's icon.
  Run it once: double-click "Create desktop shortcut.cmd".
#>
Set-Location $PSScriptRoot

$target = Join-Path $PSScriptRoot "start-tutor.cmd"
$icon = Join-Path $PSScriptRoot "assets\french-tutor.ico"
$shell = New-Object -ComObject WScript.Shell

$places = @(
  [System.Environment]::GetFolderPath("Desktop"),
  (Join-Path ([System.Environment]::GetFolderPath("ApplicationData")) "Microsoft\Windows\Start Menu\Programs")
)

foreach ($place in $places) {
  if (-not (Test-Path $place)) { continue }
  $link = $shell.CreateShortcut((Join-Path $place "French Tutor.lnk"))
  $link.TargetPath = $target
  $link.WorkingDirectory = $PSScriptRoot
  $link.Description = "Charlotte, your French tutor"
  $link.WindowStyle = 7  # start minimised: the console is only there while things warm up
  if (Test-Path $icon) { $link.IconLocation = $icon }
  $link.Save()
  Write-Host "Created: $(Join-Path $place 'French Tutor.lnk')"
}

Write-Host ""
Write-Host "Done. Double-click 'French Tutor' on your desktop, or search for it in the Start menu." -ForegroundColor Green
