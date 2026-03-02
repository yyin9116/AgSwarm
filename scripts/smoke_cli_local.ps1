Param(
  [string]$NodeId = "node-smoke",
  [string]$NatsUrl = "nats://127.0.0.1:4222",
  [string]$LatexWorkspace = "D:\yin\project\test_flie\case4_progress_report_20260228_102104",
  [string]$LatexMcpDir = "D:\yin\project\latex-mcp",
  [string]$LatexMainTex = "case4_alignment_focus_plots_20260228_102104.tex",
  [string]$LatexBinDir = "C:\Users\21598\AppData\Local\Programs\MiKTeX\miktex\bin\x64"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (!(Test-Path $python)) {
  throw "Python not found: $python"
}

$env:PYTHONPATH = "src"

Write-Host "[1/7] node-snapshot"
& $python -m workflow_cli node-snapshot --nats-url $NatsUrl --node-id $NodeId

Write-Host "[2/7] submit-echo"
& $python -m workflow_cli submit-echo --nats-url $NatsUrl --node-id $NodeId --text "smoke test from scripts/smoke_cli_local.ps1"

Write-Host "[3/7] upload-file"
& $python -m workflow_cli upload-file --nats-url $NatsUrl --node-id $NodeId --source-path protocol.md --remote-name "smoke/protocol-copy.md"

Write-Host "[4/7] download-file"
& $python -m workflow_cli download-file --nats-url $NatsUrl --node-id $NodeId --source-path "smoke/protocol-copy.md" --output-path "tmp/downloads/protocol-copy.md" --overwrite

New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot "tmp/dir-upload-src/sub") | Out-Null
Set-Content -Path (Join-Path $repoRoot "tmp/dir-upload-src/a.txt") -Value "alpha" -Encoding UTF8
Set-Content -Path (Join-Path $repoRoot "tmp/dir-upload-src/sub/b.txt") -Value "beta" -Encoding UTF8

Write-Host "[5/7] upload-dir"
& $python -m workflow_cli upload-dir --nats-url $NatsUrl --node-id $NodeId --source-dir "tmp/dir-upload-src" --remote-dir "smoke-dir"

Write-Host "[6/7] download-dir"
& $python -m workflow_cli download-dir --nats-url $NatsUrl --node-id $NodeId --source-dir "smoke-dir" --output-dir "tmp/downloads/smoke-dir" --overwrite

if ((Test-Path $LatexWorkspace) -and (Test-Path $LatexMcpDir)) {
  Write-Host "[7/7] submit-latex"
  & $python -m workflow_cli submit-latex --nats-url $NatsUrl --node-id $NodeId --workspace $LatexWorkspace --latex-mcp-dir $LatexMcpDir --main-tex $LatexMainTex --engine pdflatex --output-subdir build_case4_nats_cli_smoke --latex-bin-dir $LatexBinDir --wait-timeout-sec 1200
} else {
  Write-Host "[7/7] submit-latex skipped (workspace or latex-mcp dir not found)"
}

Write-Host "Smoke test finished."
