Param(
  [string]$Config = "configs/nats-dev.conf"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$configPath = Join-Path $repoRoot $Config

if (!(Test-Path $configPath)) {
  throw "Config not found: $configPath"
}

$exe = Get-ChildItem -Path (Join-Path $repoRoot "tools/nats-server") -Recurse -Filter "nats-server.exe" |
  Select-Object -First 1

if ($null -eq $exe) {
  throw "nats-server.exe not found under tools/nats-server. Please download it first."
}

Write-Host "Starting NATS server:"
Write-Host "  exe: $($exe.FullName)"
Write-Host "  cfg: $configPath"

& $exe.FullName -c $configPath
