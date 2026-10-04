$ErrorActionPreference = "SilentlyContinue"
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $project
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
# Minimized so a double-click from Desktop clearly starts something.
Start-Process -FilePath "npm.cmd" -ArgumentList "run","tauri","dev" -WorkingDirectory $project -WindowStyle Minimized
