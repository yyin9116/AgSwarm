# Workflow 交接文档（更新于 2026-03-02）

## 0. 主线阶段判断（当前到哪里）

当前处于 **Phase-2：MVP 联调可用，进入跨机稳定性与产品化阶段**。

已完成：

1. Runtime + Node Daemon + NATS Bridge + Client SDK 闭环。
2. 文件上传协议（含断点续传）与目录递归上传，下载回传已支持文件级与目录级。
3. LaTeX MCP 任务链路（成功/失败路径都可回传消息）。
4. 桌面客户端 MVP（任务创建/结果预览/历史/MCP 配置/设置）。
5. 桌面主界面已按 `prototype/prototype.pen` 对齐为三栏结构（Nodes / Create Task / Queue+Artifacts），并采用多 Tab（Task Center / Task Detail / Results / History / MCP / Settings）。
6. Agent skills 机制（默认/显式/关键词触发 + adapter 覆盖）。

下一主线焦点：

1. `mac -> win` 稳定跨机回归。
2. 下载回传补齐批量策略与跨机稳定性。
3. 桌面端任务时间线与通知中心增强。
4. 发布签名与 CI/CD 完整发布链路。

## 1. 项目目标

构建可在 macOS / Windows 上运行的多端 workflow 控制系统，支持：

1. 文件/文件夹拖拽投递。
2. 指令下发到指定节点。
3. 节点侧 Agent 调用 MCP 执行任务。
4. 结果回传（文件/截图/日志）。
5. 节点状态与资源可观测。
6. 任意节点可发送或接收任务。

## 2. 当前已落地能力

### 2.1 Runtime / Node / Transport

1. `workflow_runtime`：`TaskEnvelope/Event`、`Runtime`、Adapter 基类。
2. `workflow_node_daemon`：任务队列、并发、重试、取消、超时、状态快照。
3. `workflow_transport`：抽象传输层 + `NatsTransportProvider`。
4. `workflow_control_client`：任务提交、节点快照、事件订阅、文件上传/下载。
5. `workflow_cli`：`node` / `node-snapshot` / `submit-echo` / `submit-latex` / `upload-file` / `upload-dir` / `download-file` / `download-dir`。
6. `workflow_cli agent-check`：可快速检查节点 agent 是否可接单（`can_accept_tasks/agent_ready`）及 adapter 是否满足要求。

### 2.2 数据面与错误回传

1. 文件上传协议：`prepare -> chunk -> commit`。
2. 文件下载协议：`download.prepare -> download.chunk`。
3. 目录下载协议：`download.list (paged) -> per-file download.prepare/download.chunk`。
4. 支持断点续传、并行分片上传。
5. 支持目录上传（保留子目录结构）。
6. 任务失败、重试、取消时可回传 `task.user_message`。
7. 客户端终态等待逻辑已防止终态后消息丢失。

### 2.3 日志与可观测性

1. 新增统一日志模块：`src/workflow_logging.py`。
2. 支持 `WORKFLOW_LOG_LEVEL/WORKFLOW_LOG_FILE` 或 CLI 参数控制。
3. 已接入 CLI、客户端、NATS 传输、daemon、bridge。

### 2.4 桌面客户端（MVP）

目录：`src/workflow_desktop/`（PySide6 + qasync）

已实现页面：

1. `Task Center`：节点列表 + 任务创建 + 队列日志（含 Echo / LaTeX 任务发起）。
2. `Task Detail`：选中任务的时间线 + 完整结果 JSON。
3. `Results`：产物路径列表、图片预览、打开路径/目录、复制路径。
4. `History`：任务历史筛选与定位。
5. `MCP Config`：本地 MCP 服务配置增删改查与健康检查（格式/本地命令可执行性）。
6. `Settings`：NATS/节点列表/轮询参数/MCP 配置路径的运行时应用与持久化。
7. `Quick Operations`：支持“Re-run Selected Task”与“Export Event Stream (.ndjson)”。
8. Node snapshot 已扩展 agent 配置可观测字段：`adapters`、`skills_loaded`、`skills_source_path`、`skills_count`、`can_accept_tasks`、`agent_ready`。
9. `Task Center -> Online Nodes` 已增加 `Agent Check` 按钮与 `required adapters` 输入，可在桌面端直接检查节点是否可接单并显示缺失能力。
10. `Task Detail` 已增加状态徽标、错误码徽标（含基础 code->label 映射）与用户消息摘要，失败任务定位更快。
11. Queue 侧已增加失败告警块（红色），展示最近失败任务与首条错误摘要。
12. 错误码映射与提取逻辑已抽到 `src/workflow_runtime/error_codes.py`，CLI 与 Desktop 共享。
13. Queue 失败告警支持一键跳转到对应任务的 `Task Detail`。
14. CLI 的 `upload/download` 命令已接入统一 `error_summary`，失败时输出结构化 JSON 错误（不再直接抛整段 traceback）。
15. Queue 失败告警支持复制失败详情（JSON）与导出失败上下文（`.json`）用于排障和异地协作。
16. 新增 `Notifications` Tab：聚合关键告警（任务失败、agent-check 异常、导出完成等），支持复制选中/复制全部/清空。
17. 通知中心已加入短窗口去重策略（同类事件合并计数），减少重复告警刷屏。
18. 通知中心已支持 `level/category/search/unread` 过滤与 `Mark All Read` 已读管理。
19. 通知中心点击未读项会即时置为已读并展示详情 JSON，排障链路更直接。
20. 系统托盘最小闭环已接入：窗口关闭时默认最小化到托盘，托盘菜单支持恢复窗口与退出应用。
21. 通知策略已接入 `Settings`：最大缓存条数、去重窗口秒数、自动标记已读开关，支持保存/重载。
22. 通知中心已新增 `Mark Selected Read`，可在关闭自动已读后进行单条已读管理。
23. Queue 失败告警已新增 `Retry Failed Task`，可直接重试最近失败任务（复用原请求参数并记录重试来源）。
24. `Quick Operations` 已新增 `Retry Failed Batch`：支持按任务类型/错误码筛选批量重试失败任务（默认跳过下载类任务）。
25. `History` 页已新增恢复信息面板：展示 `rerun_of/rerun_trigger` 与来源任务状态、错误码，便于排查重试链路。
26. 批量重试策略已接入 `Settings`：最大批量上限、重试间隔秒数、跳过任务类型，支持保存/重载并实时生效。
27. 重试策略已支持负载感知路由（按节点快照择优）与退避重试（按尝试次数和 base 间隔指数退避）。
28. 重试记录已包含 `rerouted_from` 与 attempt 元数据，便于在历史页追踪恢复路径。
29. Windows 打包脚本已补齐 PySide6/qasync 收集参数，`dist/workflow-desktop/workflow-desktop.exe --help` 可正常运行。
30. 修复 Windows 上传链路稳定性问题：`nats_bridge` 文件提交阶段对 `replace/unlink` 增强容错与短重试，消除 `WinError 32/2` 导致的上传偶发失败。
31. 新增本地 Phase-2 基线脚本：`scripts/phase2_local_baseline.py`（自动拉起 nats + node + regression 并输出报告）。
32. Node snapshot 新增 MCP 能力摘要字段：`capability_summary` 与 `mcp_services`。
33. Desktop `Online Nodes` 与 `Agent Check` 已展示 MCP 服务摘要。
34. Desktop 自动更新改为 Tauri signed updater：Settings 支持手动检查、下载、安装并重启；Release workflow 需要 `TAURI_SIGNING_PRIVATE_KEY` 生成 `.sig` 与 `latest.json`，缺失时发布失败。
35. 应用图标链路已接入：`scripts/generate_app_icon.py` 生成 `assets/icons/app-icon.(png/ico/icns)`，运行时窗口/托盘与打包产物图标已替换。
36. 局域网自动发现已接入（Node UDP 广播 + Desktop UDP 监听）：Desktop 可自动合并发现节点，并在当前 NATS 为 loopback 时自动切换到发现到的 LAN NATS URL（可在 Settings 关闭）。
37. Desktop->Node 配置同步协议已接入：节点支持 `config.sync` 请求并持久化配置快照；snapshot/status 已包含 `config_sync_revision/config_sync_digest/config_synced_by/config_synced_at`。
38. Desktop 设置页已新增语言切换（`en-US/zh-CN`）与配置同步开关/间隔；`Apply Runtime` 后立即生效并持久化。
39. 桌面主界面三栏已加入纵向滚动容器，并下调默认窗口尺寸，缓解 macOS 下“上下显示不全”问题。
40. 配置同步冲突策略已接入（`desktop_wins/node_wins/manual`），并在节点列表增加 `Sync Config` 手动同步按钮，支持冲突时人工覆盖。

说明：

1. MCP 配置持久化到本地 JSON（默认 `~/.workflow-desktop/mcp-services.json`）。
2. Settings 持久化到本地 JSON（默认 `~/.workflow-desktop/settings.json`）。
3. 可通过 `--mcp-config-path` 与 `--settings-path` 覆盖路径。

### 2.5 构建与发布（Win + Mac）

1. 本地构建脚本：`scripts/build_desktop.py`（PyInstaller 打包；Windows/Linux 输出 zip，macOS 默认输出 zip + dmg）。
2. GitHub Actions：`.github/workflows/desktop-build-release.yml`。
3. 触发方式：
   - `workflow_dispatch`：手动构建。
   - tag `v*`：构建并自动发布 Release 产物（zip/dmg）。

### 2.6 Skills（节点侧 Agent 扩展）

1. 新增 `src/workflow_runtime/skills.py`，支持 JSON skills catalog。
2. `Runtime` 已支持加载 skills：
   - `WORKFLOW_SKILLS_CONFIG` 环境变量。
   - `workflow_cli node --skills-config <path>`。
3. 任务可通过 `metadata.skills` / `context.skills` 指定技能（逗号或列表）。
4. 选择规则：
   - 默认技能（`default=true`）。
   - 显式指定技能。
   - 关键词自动触发（`auto_when_any_keywords`）。
5. 生效方式：
   - 追加 `instructions` 到 adapter options。
   - 支持 adapter 级 `model/options` 覆盖。
6. 运行时事件：
   - 成功：`task.skills.applied`。
   - 失败：`task.skills.error`（不中断任务）。
7. 配置与文档：
   - 示例：`configs/skills.example.json`。
   - 说明：`docs/skills-config.md`。

### 2.7 跨机回归脚本（Mac -> Win）

1. 新增跨机回归脚本：`scripts/regression_mac_win.py`。
2. 新增 Mac 包装脚本：`scripts/smoke_mac_client.sh`。
3. 场景覆盖：`echo`、`upload-dir`、`download-dir`、`download-file`、`latex`（可按参数跳过 latex）。
4. 结果产物：`tmp/test-reports/mac_win_regression_*.json`。
5. 回归脚本支持多轮重复与通过率阈值（`--repeat` / `--pass-rate-threshold`），并输出 scenario 级统计。

## 3. 关键文档

1. `docs/nats-dev-quickstart.md`
2. `docs/mac-win-smoke-test.md`
3. `docs/desktop-client-tech-selection.md`
4. `docs/desktop-client-dev.md`
5. `docs/skills-config.md`
6. `docs/project-structure.md`
7. `docs/mainline-roadmap.md`
8. `docs/phase-overview.md`
9. `docs/phase2-checklist.md`

## 4. 实测进展

1. `python -m compileall src examples` 通过。
2. 本地 NATS + node + client 联调通过。
3. 文件上传、目录上传、断点续传通过。
4. 文件下载回传（`download-file`）本地联调通过，SHA256 校验通过。
5. 目录下载回传（`download-dir`）本地联调通过。
6. 目录下载批量策略已支持（`list-page-size` 分页 + `max-parallelism` 并发下载 + `continue-on-error`）。
7. `latex-mcp` 示例：
   - `case4_alignment_focus_plots_20260228_102104.tex` 成功，产出 PDF 与预览 PNG。
   - `case4_paper_progress_report_20260228_102104.tex` 失败，正确回传错误信息。
8. 跨机回归脚本本地模拟通过（`echo/upload-dir/download-dir/download-file/latex-skip`）。
9. 桌面端入口可运行参数解析：`python -m workflow_desktop --help`。
10. 本地分页回传联调通过（`list_page_size=7` 强制分页，37 文件目录下载完整一致）。
11. 桌面端主线改造后启动自检通过（含样式对齐与 Quick Operations）。
12. 单元测试通过：`set PYTHONPATH=src && python -m unittest discover -s tests -p "test_*.py" -v`（覆盖共享错误码逻辑、CLI 结构化错误输出、回归脚本多轮统计汇总）。
13. Windows 打包验证通过：`.venv\\Scripts\\python.exe scripts/build_desktop.py --clean --name workflow-desktop`，产物 `dist-artifacts/workflow-desktop-windows-x64.zip` 已生成。
14. 打包产物入口验证通过：`dist/workflow-desktop/workflow-desktop.exe --help` 可输出参数帮助（无 `PySide6 is not installed` 报错）。
15. 本地 Phase-2 基线验证通过：`.venv\\Scripts\\python.exe scripts/phase2_local_baseline.py --python .venv\\Scripts\\python.exe --repeat 2 --pass-rate-threshold 1.0 --skip-latex`，报告 `tmp/test-reports/phase2_local_baseline_20260301_234317.json`。

## 5. 当前未完成项

1. 跨机 E2E（mac -> win）尚未在真实双机环境完成固定轮次固化（本地单机基线已通过）。
2. 跨机 LaTeX 场景（`--skip-latex` 关闭）尚未形成固定样本报告。
3. 跨机失败归因记录模板尚未沉淀（网络/环境/MCP/协议分类）。
4. 构建签名未接入（Windows code sign / macOS notarization）。
5. 打包体积与插件裁剪策略未优化（当前 `--collect-all PySide6` 体积较大，后续可按模块精简）。

## 6. 下一步建议（优先级）

1. 跑通 `mac -> win` 全链路（CLI + Desktop 双路径）。
2. 下载回传补齐批量策略与跨机稳定性，并做结果二次分发。
3. 桌面端继续增强时间线可视化、高级通知编排与策略化重试编排（按错误码/节点负载/退避策略）。
4. 增加错误码映射与用户提示规范（`task.user_message` -> UI）。
5. 接入签名与发布安全链路。

## 7. 根目录结构说明

根目录结构与模块职责已单独整理：`docs/project-structure.md`。


