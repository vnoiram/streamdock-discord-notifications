param(
  [string]$Configuration = "Release",
  [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

npm run package
dotnet publish helper/DiscordNotificationHelper.csproj -c $Configuration -r $Runtime --self-contained false -o dist/helper

$Manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
$ReleaseDir = Join-Path $Root "dist/release"
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
$Zip = Join-Path $ReleaseDir "streamdock-discord-notifications-$($Manifest.Version).zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }

Compress-Archive -Path @(
  "dist/stream-dock-discord-notifications.sdPlugin",
  "dist/helper"
) -DestinationPath $Zip

Write-Host "Wrote $Zip"
