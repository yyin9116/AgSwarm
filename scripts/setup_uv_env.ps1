Param(
  [string]$VenvPath = ".venv"
)

$ErrorActionPreference = "Stop"

Write-Host "[1/2] Creating uv virtual environment at $VenvPath"
uv venv $VenvPath

Write-Host "[2/2] Installing project dependencies with NATS extra"
uv pip install --python "$VenvPath\Scripts\python.exe" -e ".[nats]"

Write-Host "Done. Activate with: $VenvPath\Scripts\activate"
