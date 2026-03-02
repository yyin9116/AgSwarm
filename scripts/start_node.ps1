Param(
  [string]$NodeId = "node-a",
  [string]$NatsUrl = "nats://127.0.0.1:4222",
  [int]$MaxConcurrency = 2,
  [int]$DefaultRetries = 1,
  [string]$LatexWorkspace = "",
  [string]$LatexServerCwd = "",
  [string]$SkillsConfig = "",
  [string]$LogLevel = "INFO",
  [string]$LogFile = "tmp/test-logs/node.app.log",
  [switch]$ForceStart,
  [switch]$Background,
  [string]$OutLog = "tmp/test-logs/node.out.log",
  [string]$ErrLog = "tmp/test-logs/node.err.log"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (!(Test-Path $python)) {
  throw "Python not found: $python. Run scripts/setup_uv_env.ps1 first."
}

$env:PYTHONPATH = "src"
if ($LatexWorkspace) {
  $env:WORKFLOW_LATEX_WORKSPACE = $LatexWorkspace
}
if ($LatexServerCwd) {
  $env:WORKFLOW_LATEX_SERVER_CWD = $LatexServerCwd
}
if ($SkillsConfig) {
  $env:WORKFLOW_SKILLS_CONFIG = $SkillsConfig
}

$running = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like "python*" -and
  $_.CommandLine -like "*workflow_cli*" -and
  $_.CommandLine -like "* node *" -and
  $_.CommandLine -like "*--node-id $NodeId*" -and
  $_.CommandLine -like "*--nats-url $NatsUrl*"
}

if ($running -and -not $ForceStart) {
  $pids = ($running | Select-Object -ExpandProperty ProcessId) -join ","
  Write-Host "Node already running for node_id=$NodeId nats_url=$NatsUrl. PID=$pids"
  Write-Host "Use -ForceStart to start another instance intentionally."
  exit 0
}

$args = @(
  "-m", "workflow_cli",
  "--log-level", $LogLevel,
  "--log-file", $LogFile,
  "node",
  "--node-id", $NodeId,
  "--nats-url", $NatsUrl,
  "--max-concurrency", "$MaxConcurrency",
  "--default-retries", "$DefaultRetries"
)
if ($LatexWorkspace) {
  $args += @("--latex-workspace", $LatexWorkspace)
}
if ($LatexServerCwd) {
  $args += @("--latex-server-cwd", $LatexServerCwd)
}
if ($SkillsConfig) {
  $args += @("--skills-config", $SkillsConfig)
}

if ($Background) {
  $outPath = Join-Path $repoRoot $OutLog
  $errPath = Join-Path $repoRoot $ErrLog
  New-Item -ItemType Directory -Force -Path (Split-Path $outPath -Parent) | Out-Null
  New-Item -ItemType Directory -Force -Path (Split-Path $errPath -Parent) | Out-Null
  $proc = Start-Process -FilePath $python -ArgumentList $args -WorkingDirectory $repoRoot -NoNewWindow -PassThru -RedirectStandardOutput $outPath -RedirectStandardError $errPath
  Write-Host "Node started in background. PID=$($proc.Id)"
  Write-Host "stdout: $outPath"
  Write-Host "stderr: $errPath"
  exit 0
}

Write-Host "Starting node in foreground:"
Write-Host "  node_id=$NodeId"
Write-Host "  nats_url=$NatsUrl"
Write-Host "  log_level=$LogLevel"
Write-Host "  log_file=$LogFile"
& $python @args
