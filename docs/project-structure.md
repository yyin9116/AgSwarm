# 项目根目录结构（2026-03-01）

用于快速定位主线代码、脚本与文档。仅列核心路径。

## 1. 根目录树（核心）

```text
workflow/
├─ .github/
│  └─ workflows/
│     └─ desktop-build-release.yml
├─ configs/
│  ├─ nats-dev.conf
│  ├─ nats-lan.conf
│  └─ skills.example.json
├─ docs/
│  ├─ handover.md
│  ├─ phase2-checklist.md
│  ├─ nats-dev-quickstart.md
│  ├─ mac-win-smoke-test.md
│  ├─ desktop-client-dev.md
│  ├─ desktop-client-tech-selection.md
│  ├─ skills-config.md
│  ├─ mainline-roadmap.md
│  └─ project-structure.md
├─ examples/
│  ├─ run_nats_node.py
│  ├─ run_nats_client.py
│  ├─ run_nats_case4_latex.py
│  └─ run_nats_file_resume_demo.py
├─ scripts/
│  ├─ setup_uv_env.ps1
│  ├─ install_nats_server.ps1
│  ├─ start_nats.ps1
│  ├─ start_node.ps1
│  ├─ smoke_cli_local.ps1
│  ├─ regression_mac_win.py
│  ├─ phase2_local_baseline.py
│  ├─ smoke_mac_client.sh
│  └─ build_desktop.py
├─ src/
│  ├─ workflow_runtime/
│  ├─ workflow_node_daemon/
│  ├─ workflow_transport/
│  ├─ workflow_control_client/
│  ├─ workflow_cli/
│  ├─ workflow_desktop/
│  └─ workflow_logging.py
├─ tmp/
│  └─ test-logs/
├─ workflow-control-spec.md
├─ ui-prd.md
├─ protocol.md
├─ pyproject.toml
└─ README.md
```

## 2. 模块职责

1. `src/workflow_runtime`：任务协议、adapter 抽象、skills 注入、runtime 执行。
2. `src/workflow_node_daemon`：队列调度、重试取消、节点状态、NATS bridge、文件接收。
3. `src/workflow_transport`：传输抽象与 NATS provider。
4. `src/workflow_control_client`：控制端 SDK（提交任务、订阅事件、上传文件/目录）。
5. `src/workflow_cli`：联调 CLI（node/submit/upload/snapshot）。
6. `src/workflow_desktop`：桌面控制端 MVP（Win/Mac）。

## 3. 说明

1. 根目录 `.git` 当前是 worktree 指针：`gitdir: D:/yin/project/workflow/workflow/.git`。
2. `workflow/` 子目录目前主要承载该 worktree 的 git 元数据，不作为业务代码目录。
3. 后续若做目录收敛，建议先在一个独立 PR 中处理，避免与功能改动混合。
