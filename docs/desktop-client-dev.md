# 桌面客户端开发与构建说明（Win/Mac）

## 1. 开发运行

安装依赖：

```bash
uv venv .venv
# Windows (PowerShell)
uv pip install --python .venv\\Scripts\\python.exe -e ".[desktop,nats]"

# macOS (bash/zsh)
uv pip install --python .venv/bin/python -e ".[desktop,nats]"
```

启动客户端：

```bash
# Windows
set PYTHONPATH=src
python -m workflow_desktop --nats-url nats://127.0.0.1:4222 --nodes node-a,node-win --log-level DEBUG --log-file tmp/test-logs/desktop.app.log

# macOS
# export PYTHONPATH=src
# python -m workflow_desktop --nats-url nats://127.0.0.1:4222 --nodes node-a,node-win --log-level DEBUG --log-file tmp/test-logs/desktop.app.log
```

## 2. 当前 MVP 功能

页面：

1. `Task Center`：节点列表、拖拽输入、上传、Echo/LaTeX 任务发起。
2. `Task Detail`：选中任务的时间线 + 完整结果 JSON。
   - 含状态徽标、错误码徽标和用户消息摘要（便于失败定位）。
3. `Results`：产物路径列表、图片预览、打开路径/目录、复制路径、远端产物下载（文件/目录自动识别）。
4. `History`：任务历史筛选与快速定位。
5. `Notifications`：集中展示告警/错误通知，支持复制、清空和详情查看。
6. `MCP Config`：本地 MCP 服务增删改查、保存、健康检查。
7. `Settings`：NATS/节点列表/轮询间隔/MCP 配置路径运行时应用与持久化。

能力：

1. 节点状态轮询（node snapshot）。
2. 文件/目录上传（复用已有上传协议）。
3. Echo 任务发起。
4. LaTeX 任务发起（调用 `latex_mcp` adapter）。
5. Skills 透传（Task Center 的 `Skills` 输入框，逗号分隔）。
6. 日志输出（界面日志 + 文件日志）。
7. 节点 `Agent Check`（检查 `can_accept_tasks/agent_ready/skills_loaded` 与 required adapters 缺失项）。
8. Queue 失败告警块（显示最近失败任务与首条错误摘要）。
9. Queue 告警支持一键跳转到对应失败任务的 `Task Detail`。
10. 错误码映射来自共享模块 `workflow_runtime.error_codes`（与 CLI 一致）。
11. Queue 告警支持复制失败详情（JSON）和导出失败上下文（`.json`）。
12. 通知中心支持聚合关键事件（任务失败、agent-check 异常、导出完成等）。
13. 通知中心支持短窗口去重（同类事件合并计数 `xN`），降低告警噪音。
14. 通知中心支持 `level/category/search/unread` 过滤与 `Mark All Read` 已读管理。
15. 点击未读通知会即时标记为已读，并在右侧详情区展示完整 JSON 上下文。
16. 系统托盘最小闭环已接入：关闭窗口默认最小化到托盘，托盘菜单可恢复窗口或退出应用。
17. 通知策略可在 `Settings` 配置并持久化：`Notification Max Items`、`Notification Dedupe Window (sec)`、`Notification Auto Mark Read`。
18. 通知中心新增 `Mark Selected Read`，当关闭自动已读时可手动管理单条通知状态。
19. Queue 失败告警支持 `Retry Failed Task`，可直接对最近失败任务执行重试（复用原请求参数）。
20. `Quick Operations` 新增 `Retry Failed Batch`，支持按任务类型/错误码筛选批量重试失败任务（默认跳过下载类任务）。
21. `History` 页新增恢复信息面板，展示 `rerun_of/rerun_trigger` 与来源任务状态、错误码。
22. 批量重试策略支持在 `Settings` 配置并持久化：`Retry Batch Max Limit`、`Retry Batch Interval (sec)`、`Retry Batch Skip Kinds`。
23. 重试策略支持负载感知路由与退避重试：`Retry Reroute Mode`、`Retry Attempts Per Task`、`Retry Backoff Base (sec)`。
24. 重试记录会携带 `rerouted_from`、`rerun_attempt/rerun_max_attempts`，可在 `History` 恢复面板查看链路。
25. Windows 打包脚本已补齐 `PySide6/qasync` 收集参数，产物 `workflow-desktop.exe --help` 可正常运行。

本地配置：

1. MCP 配置默认路径：`~/.workflow-desktop/mcp-services.json`
2. Settings 默认路径：`~/.workflow-desktop/settings.json`
3. 可通过 CLI 参数覆盖：
   - `--mcp-config-path`
   - `--settings-path`

## 3. 本地打包

安装构建依赖：

```bash
# Windows
uv pip install --python .venv\\Scripts\\python.exe -e ".[desktop,desktop-build,nats]"

# macOS
uv pip install --python .venv/bin/python -e ".[desktop,desktop-build,nats]"
```

执行：

```bash
python scripts/build_desktop.py --clean --name workflow-desktop
```

macOS 生成 `.dmg`（默认开启，可显式指定）：

```bash
python scripts/build_desktop.py --clean --name workflow-desktop --dmg
```

产物目录：

1. `dist/`：PyInstaller 原始产物。
2. `dist-artifacts/`：发布产物目录。
3. Windows/Linux：默认产出 `.zip`。
4. macOS：默认产出 `.zip + .dmg`（可通过 `--no-dmg` 关闭 `.dmg`）。

## 4. 自动 CI/CD（Win + Mac）

工作流文件：`.github/workflows/desktop-build-release.yml`

触发方式：

1. `workflow_dispatch`：手动构建。
2. push tag `v*`：自动构建并发布 GitHub Release 附件（zip/dmg）。

## 5. 发布注意事项

1. macOS 线下分发建议补签名与 notarization。
2. Windows 线下分发建议补 code signing 证书。
