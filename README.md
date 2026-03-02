# Workflow（LAN 多端控制 + Agent/MCP）

## 当前状态（2026-03-01）

主线已完成到 **可联调 MVP**：

1. NATS 控制面与数据面（任务 + 文件上传/下载）已跑通。
2. 节点侧 runtime/daemon/bridge 已支持并发、重试、取消、状态上报。
3. CLI 与桌面端（PySide6）可发起 Echo/LaTeX 任务并查看结果。
4. Agent skills 配置已接入 runtime（默认/显式/关键词自动触发）。

未完成：跨机稳定性回归、下载回传、桌面端通知中心与托盘、签名发布。

## 快速入口

1. 交接与进展：`docs/handover.md`
2. NATS 启动与本地联调：`docs/nats-dev-quickstart.md`
3. Mac/Win 联调：`docs/mac-win-smoke-test.md`
4. Skills 配置：`docs/skills-config.md`
5. 桌面端开发：`docs/desktop-client-dev.md`
6. 根目录结构：`docs/project-structure.md`
7. 主线路线图：`docs/mainline-roadmap.md`

## 最短启动路径（本机）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_uv_env.ps1
powershell -ExecutionPolicy Bypass -File scripts/install_nats_server.ps1
powershell -ExecutionPolicy Bypass -File scripts/start_nats.ps1
```

新终端启动节点：

```powershell
$env:PYTHONPATH = "src"
python -m workflow_cli node --node-id node-a --nats-url nats://127.0.0.1:4222 --skills-config configs/skills.example.json
```

默认已开启局域网自动发现（UDP 广播），桌面端会自动看到节点；如需关闭：

```powershell
python -m workflow_cli node --node-id node-a --nats-url nats://127.0.0.1:4222 --disable-discovery
```

再开一个终端提交任务：

```powershell
$env:PYTHONPATH = "src"
python -m workflow_cli submit-echo --node-id node-a --nats-url nats://127.0.0.1:4222 --text "hello workflow" --skills safe_default
```

Mac->Win 一键回归（在 Mac 侧）：

```bash
bash scripts/smoke_mac_client.sh
```

## 桌面端自动打包发布（GitHub Release）

已配置工作流：`.github/workflows/desktop-build-release.yml`

触发方式：

1. 推送版本标签（推荐）：

```bash
git tag v0.2.0
git push origin v0.2.0
```

2. 或在 GitHub Actions 手动触发 `agswarm-desktop-release`。

产物说明：

1. macOS：默认仅发布 `AgSwarm-macos-arm64.dmg`（Apple Silicon, M1/M2/M3）
   - Intel Mac 如需安装包，建议在 Intel runner 或本地单独构建
2. Windows：`AgSwarm-windows-x64.zip`
3. 校验文件：`SHA256SUMS.txt`

获取路径：

1. GitHub 仓库 `Releases` 页面
2. 对应 tag 的 Assets 下载 `.dmg`
