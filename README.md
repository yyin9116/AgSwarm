# Workflow（LAN 多端控制 + Agent/MCP）

## 当前状态（2026-03-01）

主线已完成到 **可联调 MVP**：

1. NATS 控制面与数据面（任务 + 文件上传/下载）已跑通。
2. 节点侧 runtime/daemon/bridge 已支持并发、重试、取消、状态上报。
3. CLI 与 Tauri 桌面客户端可发起/展示多设备任务；旧 PySide6 桌面端仅保留为迁移期兼容面。
4. Agent skills 配置已接入 runtime（默认/显式/关键词自动触发）。
5. 节点快照现已暴露 AgSwarm Peer 能力信息，CLI 可通过现有 NATS 控制面向启用 `pi` adapter 的设备节点提交任务。

未完成：跨机稳定性回归、下载回传、桌面端通知中心与托盘、签名发布。

## 快速入口

1. 交接与进展：`docs/handover.md`
2. NATS 启动与本地联调：`docs/nats-dev-quickstart.md`
3. Mac/Win 联调：`docs/mac-win-smoke-test.md`
4. Skills 配置：`docs/skills-config.md`
5. 桌面端开发：`docs/desktop-client-dev.md`
6. 根目录结构：`docs/project-structure.md`
7. 主线路线图：`docs/mainline-roadmap.md`

本机双桌面客户端联调：

```bash
export PYTHONPATH=src
python scripts/smoke_two_desktop_clients.py \
  --report-path tmp/test-reports/two_desktop_smoke_latest.json

python scripts/launch_two_desktop_clients.py \
  --state-dir tmp/desktop-clients
```

`smoke_two_desktop_clients.py` 会自动拉起本地 NATS，创建两个主桌面客户端和一个后台干扰客户端，验证消息、任务请求、脚本执行、后台任务不抢占当前脚本绑定、中途重启恢复待回传结果、结果回传，并在关闭后重新加载两个主客户端的 conversation state，确认重启后状态仍是 `completed/returned`。
`launch_two_desktop_clients.py --reset-state` 可用于清空两个可见客户端的 settings、conversation 和 MCP 状态后重新联调。

Tauri 客户端（新前端）：

```bash
cd desktop
npm install
npm run lint
npm run build
npm run tauri:dev
```

默认本地 agent provider：

```bash
VITE_AGENT_PROVIDER_URL=http://127.0.0.1:15721
VITE_AGENT_MODEL=gpt-5.5
VITE_AGENT_API_KEY=local-dev-key
```

打包：

```bash
cd desktop
npm run tauri:build
```

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

Pi agent harness（`earendil-works/pi`）/ AgSwarm Peer 集成切片（内置 peer 节点发现 + NATS 控制面）：

```bash
PYTHONPATH=src python -m workflow_cli node \
  --node-id node-pi \
  --nats-url nats://127.0.0.1:4222 \
  --enable-pi \
  --pi-provider anthropic \
  --pi-model anthropic/claude-sonnet-4 \
  --peer-device-label "Pi edge worker" \
  --peer-device-tags edge,lab

PYTHONPATH=src python -m workflow_cli submit-pi \
  --device-id node-pi \
  --prompt "Summarize the uploaded files and propose next actions" \
  --file-root incoming \
  --skills safe_default
```

提交任务前可先检查 peer 通信层：

```bash
PYTHONPATH=src python -m workflow_cli peer-ping --device-id node-pi
```

也可以向 peer 发送轻量内置命令：

```bash
PYTHONPATH=src python -m workflow_cli peer-command \
  --device-id node-pi \
  describe \
  --payload '{"detail": true}'
```

带 `--device-id` 时，控制端会短暂监听节点状态并解析到具备对应能力的匹配节点；`peer-ping` 会向节点的 peer command subject 发 request/reply 控制消息，`submit-pi` 会解析到具备 `pi-agent` 能力的节点后再提交任务。Pi 运行时密钥应在节点进程环境中配置，不要通过任务参数或命令行转发。可通过 `python -m workflow_cli node-snapshot --node-id node-pi` 查看节点暴露的 `peer_node` 通信/能力信息。

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

发布说明（Release 页面正文）：

1. 若存在 `docs/releases/<tag>.md`（例如 `docs/releases/v0.2.6.md`），工作流会优先使用该文件作为 Release 说明。
2. 若不存在对应文件，则回退到 GitHub 自动生成说明。

产物说明：

1. macOS Apple Silicon：Tauri `.app.zip` / `.dmg`
2. macOS Intel：Tauri `.app.zip` / `.dmg`
3. Windows x64：Tauri NSIS `.exe` / MSI `.msi`（以 Tauri 当前产物为准）
4. Linux x64：Tauri AppImage / deb / rpm（以 Tauri 当前产物为准）
5. 校验文件：`SHA256SUMS.txt`

发布流水线会在每个平台 runner 上自动准备对应的 Node runtime sidecar
与 pi AgentSession bridge sidecar；缺失时对应平台构建会失败，不会回退到
绕过 pi 的 provider 或 Python bridge。

获取路径：

1. GitHub 仓库 `Releases` 页面
2. 对应 tag 的 Assets 下载目标平台安装包
