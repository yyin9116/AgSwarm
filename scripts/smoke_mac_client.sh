#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$REPO_ROOT/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python not found: $PYTHON_BIN"
  echo "Set PYTHON_BIN or create .venv first."
  exit 1
fi

export PYTHONPATH="${PYTHONPATH:-$REPO_ROOT/src}"

NATS_URL="${WORKFLOW_NATS_URL:-nats://127.0.0.1:4222}"
NODE_ID="${WORKFLOW_TARGET_NODE:-node-win}"
SKILLS="${WORKFLOW_TASK_SKILLS:-safe_default}"
CONNECT_TIMEOUT_SEC="${WORKFLOW_CONNECT_TIMEOUT_SEC:-8}"
DOWNLOAD_MAX_PARALLELISM="${WORKFLOW_DOWNLOAD_MAX_PARALLELISM:-4}"
DOWNLOAD_LIST_PAGE_SIZE="${WORKFLOW_DOWNLOAD_LIST_PAGE_SIZE:-500}"
REPEAT="${WORKFLOW_REGRESSION_REPEAT:-1}"
REPEAT_INTERVAL_SEC="${WORKFLOW_REGRESSION_REPEAT_INTERVAL_SEC:-0}"
PASS_RATE_THRESHOLD="${WORKFLOW_REGRESSION_PASS_RATE_THRESHOLD:-1.0}"

LATEX_WORKSPACE="${WORKFLOW_LATEX_WORKSPACE:-}"
LATEX_MCP_DIR="${WORKFLOW_LATEX_MCP_DIR:-}"
MAIN_TEX="${WORKFLOW_CASE4_MAIN_TEX:-}"
LATEX_BIN_DIR="${WORKFLOW_LATEX_BIN_DIR:-}"
ENGINE="${WORKFLOW_CASE4_ENGINE:-pdflatex}"

ARGS=(
  "--nats-url" "$NATS_URL"
  "--node-id" "$NODE_ID"
  "--skills" "$SKILLS"
  "--connect-timeout-sec" "$CONNECT_TIMEOUT_SEC"
  "--download-max-parallelism" "$DOWNLOAD_MAX_PARALLELISM"
  "--download-list-page-size" "$DOWNLOAD_LIST_PAGE_SIZE"
  "--repeat" "$REPEAT"
  "--repeat-interval-sec" "$REPEAT_INTERVAL_SEC"
  "--pass-rate-threshold" "$PASS_RATE_THRESHOLD"
)

if [[ -n "$LATEX_WORKSPACE" && -n "$LATEX_MCP_DIR" && -n "$MAIN_TEX" ]]; then
  ARGS+=(
    "--latex-workspace" "$LATEX_WORKSPACE"
    "--latex-mcp-dir" "$LATEX_MCP_DIR"
    "--main-tex" "$MAIN_TEX"
    "--engine" "$ENGINE"
  )
  if [[ -n "$LATEX_BIN_DIR" ]]; then
    ARGS+=("--latex-bin-dir" "$LATEX_BIN_DIR")
  fi
else
  ARGS+=("--skip-latex")
fi

"$PYTHON_BIN" "$REPO_ROOT/scripts/regression_mac_win.py" "${ARGS[@]}"
