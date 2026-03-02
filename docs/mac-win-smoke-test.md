# Mac/Win Smoke Test (NATS + CLI)

This document describes a testable cross-machine flow:

1. Windows machine runs `nats-server` and `workflow` node.
2. Mac machine runs `workflow` CLI client and submits tasks to Windows node.

## 1) Windows setup (server + node)

In `D:\yin\project\workflow`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_uv_env.ps1
powershell -ExecutionPolicy Bypass -File scripts/install_nats_server.ps1
```

Start NATS LAN mode:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start_nats.ps1 -Config configs/nats-lan.conf
```

In another terminal, start node:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start_node.ps1 -NodeId node-win -NatsUrl "nats://workflow:ChangeMe_123456@<WIN_IP>:4222" -LogLevel DEBUG -LogFile "tmp/test-logs/node-win.app.log"
```

Optional: enable runtime skills config on node:

```powershell
$env:WORKFLOW_SKILLS_CONFIG = "configs/skills.example.json"
powershell -ExecutionPolicy Bypass -File scripts/start_node.ps1 -NodeId node-win -NatsUrl "nats://workflow:ChangeMe_123456@<WIN_IP>:4222" -LogLevel DEBUG -LogFile "tmp/test-logs/node-win.app.log"
```

Optional (latex task):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start_node.ps1 `
  -NodeId node-win `
  -NatsUrl "nats://workflow:ChangeMe_123456@<WIN_IP>:4222" `
  -LatexWorkspace "D:\yin\project\test_flie\case4_progress_report_20260228_102104" `
  -LatexServerCwd "D:\yin\project\latex-mcp"
```

## 2) Mac setup (client)

Clone repo on Mac and install:

```bash
uv venv .venv
uv pip install --python .venv/bin/python -e ".[nats]"
source .venv/bin/activate
export PYTHONPATH=src
```

Set NATS URL to Windows host:

```bash
export WORKFLOW_NATS_URL="nats://workflow:ChangeMe_123456@<WIN_IP>:4222"
```

## 3) Cross-machine tests from Mac

Check node snapshot:

```bash
python -m workflow_cli --log-level DEBUG --log-file ./tmp/test-logs/client-mac.app.log node-snapshot --nats-url "$WORKFLOW_NATS_URL" --node-id node-win
```

Submit echo task:

```bash
python -m workflow_cli --log-level DEBUG --log-file ./tmp/test-logs/client-mac.app.log submit-echo --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --text "hello from mac"
```

Submit echo task with explicit skills:

```bash
python -m workflow_cli --log-level DEBUG --log-file ./tmp/test-logs/client-mac.app.log submit-echo --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --text "hello from mac with skills" --skills safe_default
```

Upload a file to Windows node:

```bash
python -m workflow_cli upload-file --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --source-path ./README.md
```

Upload a directory recursively:

```bash
python -m workflow_cli upload-dir --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --source-dir ./assets --remote-dir mac-assets
```

Download returned directory from Windows node:

```bash
python -m workflow_cli download-dir --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --source-dir "mac-assets" --output-dir ./tmp/downloads/mac-assets --overwrite
```

Large directory mode:

```bash
python -m workflow_cli download-dir --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --source-dir "mac-assets" --output-dir ./tmp/downloads/mac-assets --list-page-size 200 --max-parallelism 8 --continue-on-error --overwrite
```

Download returned artifact from Windows node:

```bash
python -m workflow_cli download-file --nats-url "$WORKFLOW_NATS_URL" --node-id node-win --source-path "D:\\yin\\project\\test_flie\\case4_progress_report_20260228_102104\\build_case4_nats_macwin\\case4_alignment_focus_plots_20260228_102104.pdf" --output-path ./tmp/downloads/case4-from-win.pdf --overwrite
```

Submit latex compile task (path must exist on Windows node):

```bash
python -m workflow_cli submit-latex \
  --nats-url "$WORKFLOW_NATS_URL" \
  --node-id node-win \
  --workspace "D:\\yin\\project\\test_flie\\case4_progress_report_20260228_102104" \
  --latex-mcp-dir "D:\\yin\\project\\latex-mcp" \
  --main-tex "case4_alignment_focus_plots_20260228_102104.tex" \
  --engine pdflatex \
  --output-subdir build_case4_nats_macwin \
  --latex-bin-dir "C:\\Users\\21598\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64"
```

## 4) One-command regression from Mac

Use the new regression script (runs `echo + upload-dir + download-dir + download-file + latex` and writes JSON report):

```bash
export WORKFLOW_NATS_URL="nats://workflow:ChangeMe_123456@<WIN_IP>:4222"
export WORKFLOW_TARGET_NODE="node-win"
export WORKFLOW_TASK_SKILLS="safe_default,latex_compile"
export WORKFLOW_CONNECT_TIMEOUT_SEC="8"
export WORKFLOW_DOWNLOAD_MAX_PARALLELISM="8"
export WORKFLOW_DOWNLOAD_LIST_PAGE_SIZE="200"
export WORKFLOW_REGRESSION_REPEAT="3"
export WORKFLOW_REGRESSION_REPEAT_INTERVAL_SEC="2"
export WORKFLOW_REGRESSION_PASS_RATE_THRESHOLD="0.66"
export WORKFLOW_LATEX_WORKSPACE="D:\\yin\\project\\test_flie\\case4_progress_report_20260228_102104"
export WORKFLOW_LATEX_MCP_DIR="D:\\yin\\project\\latex-mcp"
export WORKFLOW_CASE4_MAIN_TEX="case4_alignment_focus_plots_20260228_102104.tex"
export WORKFLOW_LATEX_BIN_DIR="C:\\Users\\21598\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64"
bash scripts/smoke_mac_client.sh
```

If LaTeX variables are not set, script auto-runs `echo + upload-dir + download-dir + download-file` and marks latex as skipped.
If node snapshot fails, script now fails fast and still writes a report.

Direct python usage:

```bash
python scripts/regression_mac_win.py \
  --nats-url "$WORKFLOW_NATS_URL" \
  --node-id "$WORKFLOW_TARGET_NODE" \
  --skills "$WORKFLOW_TASK_SKILLS" \
  --connect-timeout-sec 8 \
  --repeat 3 \
  --repeat-interval-sec 2 \
  --pass-rate-threshold 0.66 \
  --download-max-parallelism 8 \
  --download-list-page-size 200 \
  --latex-workspace "$WORKFLOW_LATEX_WORKSPACE" \
  --latex-mcp-dir "$WORKFLOW_LATEX_MCP_DIR" \
  --main-tex "$WORKFLOW_CASE4_MAIN_TEX" \
  --latex-bin-dir "$WORKFLOW_LATEX_BIN_DIR"
```

Repeated mode report includes:

1. per-run raw results (`runs[]`),
2. run-level pass rate,
3. scenario-level pass rate and average duration.

## 5) Expected result

1. Echo task returns `ok: true`.
2. Uploaded file/dir appears under `.workflow_node_data/node-win/incoming` on Windows.
3. LaTeX task returns terminal event with either:
   - success and `pdf_path` / `preview_image_path`, or
   - error with `task.user_message` and detailed MCP diagnostics.
4. `download-dir` can pull uploaded directory to Mac local path.
5. `download-file` can pull generated file to Mac local path.
6. Regression JSON report is generated under `tmp/test-reports/`.
