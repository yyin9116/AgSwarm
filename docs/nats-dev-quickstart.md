# NATS Dev Quickstart

## 1. Install dependencies

```bash
powershell -ExecutionPolicy Bypass -File scripts/setup_uv_env.ps1
```

Install local `nats-server` binary:

```bash
powershell -ExecutionPolicy Bypass -File scripts/install_nats_server.ps1
```

Activate venv (PowerShell):

```bash
.venv\Scripts\activate
```

## 2. Start NATS server

Default URL:

`nats://127.0.0.1:4222`

Use repository config (recommended):

```bash
powershell -ExecutionPolicy Bypass -File scripts/start_nats.ps1
```

LAN mode (with auth):

```bash
powershell -ExecutionPolicy Bypass -File scripts/start_nats.ps1 -Config configs/nats-lan.conf
```

## 3. Start a node process

```bash
set PYTHONPATH=src
set WORKFLOW_NODE_ID=node-a
python -m workflow_cli --log-level DEBUG --log-file tmp/test-logs/node.app.log node --node-id node-a --nats-url nats://127.0.0.1:4222
```

Enable skills config (optional):

```bash
set WORKFLOW_SKILLS_CONFIG=configs/skills.example.json
python -m workflow_cli --log-level DEBUG --log-file tmp/test-logs/node.app.log node --node-id node-a --nats-url nats://127.0.0.1:4222 --skills-config configs/skills.example.json
```

If you use `scripts/start_node.ps1`, duplicate starts for same `node_id + nats_url` are now blocked by default; pass `-ForceStart` only when you intentionally need multiple instances.

## 4. Start a control client

```bash
set PYTHONPATH=src
python -m workflow_cli --log-level DEBUG --log-file tmp/test-logs/client.app.log node-snapshot --node-id node-a --nats-url nats://127.0.0.1:4222
python -m workflow_cli --log-level DEBUG --log-file tmp/test-logs/client.app.log agent-check --node-id node-a --nats-url nats://127.0.0.1:4222 --require-adapters echo,latex_mcp
python -m workflow_cli --log-level DEBUG --log-file tmp/test-logs/client.app.log submit-echo --node-id node-a --nats-url nats://127.0.0.1:4222 --text "hello cli"
python -m workflow_cli --log-level DEBUG --log-file tmp/test-logs/client.app.log submit-echo --node-id node-a --nats-url nats://127.0.0.1:4222 --text "compile latex summary" --skills safe_default
```

Expected flow:

1. Client submits a task.
2. Node publishes status updates.
3. Client receives task events (`task.accepted`, `adapter.started`, `adapter.token`, `adapter.completed`).

## 5. Current scope

1. Control plane is available (task submit, status, event stream).
2. Data-plane file upload is available with `prepare -> chunk -> commit`.
3. Data-plane file download is available with `download.prepare -> download.chunk`.
4. Directory download is available with `download.list (paged) -> per-file download`.
5. Resume and out-of-order chunk handling are implemented in code via `transfer_id` + `missing_indexes`.
6. Directory upload is available (`workflow_cli upload-dir`).
7. Node snapshot includes agent readiness fields (`can_accept_tasks`, `agent_ready`, `adapters`, `skills_loaded`, `skills_source_path`).

## 6. File upload demo

```bash
set PYTHONPATH=src
python -m workflow_cli upload-file --node-id node-a --nats-url nats://127.0.0.1:4222 --source-path protocol.md --remote-name smoke/protocol-copy.md
```

Node-side files are stored in:

`.workflow_node_data/<node_id>/incoming`

## 7. Directory upload demo

```bash
set PYTHONPATH=src
python -m workflow_cli upload-dir --node-id node-a --nats-url nats://127.0.0.1:4222 --source-dir tmp/dir-upload-src --remote-dir smoke-dir
```

## 8. File download demo

Download file from node (absolute path or incoming-relative path):

```bash
set PYTHONPATH=src
python -m workflow_cli download-file --node-id node-a --nats-url nats://127.0.0.1:4222 --source-path smoke/protocol-copy.md --output-path tmp/downloads/protocol-copy.md --overwrite
```

Download directory from node:

```bash
set PYTHONPATH=src
python -m workflow_cli download-dir --node-id node-a --nats-url nats://127.0.0.1:4222 --source-dir smoke-dir --output-dir tmp/downloads/smoke-dir --overwrite
```

For large directories, increase parallelism:

```bash
set PYTHONPATH=src
python -m workflow_cli download-dir --node-id node-a --nats-url nats://127.0.0.1:4222 --source-dir smoke-dir --output-dir tmp/downloads/smoke-dir --max-parallelism 8 --continue-on-error --overwrite
```

Force small list pages (for protocol/debug validation):

```bash
set PYTHONPATH=src
python -m workflow_cli download-dir --node-id node-a --nats-url nats://127.0.0.1:4222 --source-dir smoke-dir --output-dir tmp/downloads/smoke-dir --list-page-size 7 --max-parallelism 8 --overwrite
```

The JSON result includes `list_pages` and `truncated` for list-phase diagnostics.

If `upload/download` commands fail, CLI now returns structured JSON with `error_summary` (for example `transfer.failed`) for easier UI/client consumption.

## 9. Resume upload demo

This script uploads half of the chunks first, then resumes with the same `transfer_id`:

```bash
set PYTHONPATH=src
set WORKFLOW_TARGET_NODE=node-a
python examples/run_nats_file_resume_demo.py
```

## 10. LaTeX case4 demo

Use `latex-mcp` to compile and preview case4 TeX input:

```bash
set PYTHONPATH=src
set WORKFLOW_TARGET_NODE=node-a
python examples/run_nats_case4_latex.py
```

Optional overrides:

```bash
set WORKFLOW_CASE4_DIR=D:\yin\project\test_flie\case4_progress_report_20260228_102104
set WORKFLOW_LATEX_MCP_DIR=D:\yin\project\latex-mcp
set WORKFLOW_CASE4_MAIN_TEX=case4_alignment_focus_plots_20260228_102104.tex
```

## 11. One-command local smoke

```bash
powershell -ExecutionPolicy Bypass -File scripts/smoke_cli_local.ps1 -NodeId node-a -NatsUrl nats://127.0.0.1:4222
```

## 12. Phase-2 local baseline (auto nats + node + regression)

```bash
.venv\Scripts\python.exe scripts/phase2_local_baseline.py --python .venv\Scripts\python.exe --repeat 2 --pass-rate-threshold 1.0 --skip-latex
```

This script auto-starts local `nats-server` + node daemon, runs `scripts/regression_mac_win.py`, writes a report to `tmp/test-reports/phase2_local_baseline_*.json`, and then stops background processes.

## 13. Debug log paths

1. Node app log: `tmp/test-logs/node.app.log`
2. Client app log: `tmp/test-logs/client.app.log`
3. Node stdout/stderr: `tmp/test-logs/node.out.log` / `tmp/test-logs/node.err.log`
4. NATS stdout/stderr: `tmp/test-logs/nats.out.log` / `tmp/test-logs/nats.err.log`

## 14. Unit tests

Run local unit tests (no extra dependency, stdlib `unittest`):

```bash
set PYTHONPATH=src
python -m unittest discover -s tests -p "test_*.py" -v
```

## 15. Cross-machine smoke test (Mac -> Windows)

See:

`docs/mac-win-smoke-test.md`

Cross-machine one-command script (run on Mac side):

`scripts/smoke_mac_client.sh`
