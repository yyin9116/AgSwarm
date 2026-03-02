Param(
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$toolsDir = Join-Path $repoRoot "tools/nats-server"
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

if ($Version -eq "latest") {
  $api = "https://api.github.com/repos/nats-io/nats-server/releases/latest"
} else {
  $api = "https://api.github.com/repos/nats-io/nats-server/releases/tags/$Version"
}

$release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "workflow-setup" }
$asset = $release.assets | Where-Object { $_.name -like "*windows-amd64.zip" } | Select-Object -First 1
if ($null -eq $asset) {
  throw "Windows amd64 asset not found in release: $($release.tag_name)"
}

$zipPath = Join-Path $toolsDir $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force

$exe = Get-ChildItem -Path $toolsDir -Recurse -Filter "nats-server.exe" | Select-Object -First 1
if ($null -eq $exe) {
  throw "nats-server.exe not found after extract."
}

Set-Content -Path (Join-Path $toolsDir "VERSION.txt") -Value ("tag={0}`nasset={1}`nurl={2}" -f $release.tag_name, $asset.name, $asset.browser_download_url) -Encoding ASCII

Write-Host "Installed nats-server:"
Write-Host "  tag: $($release.tag_name)"
Write-Host "  exe: $($exe.FullName)"
