# 主线开发路线图（2026-03-01）

## 1. 阶段状态

1. Phase-1（已完成）：单机控制面与数据面闭环。
2. Phase-2（进行中）：跨机联调稳定性 + 桌面客户端 MVP 完整可用。
3. Phase-3（未开始）：高级通知策略/托盘恢复、签名发布、生产部署规范。

## 2. 已完成基线

1. NATS 控制面：task submit / event stream / node snapshot。
2. 文件传输：prepare/chunk/commit + 断点续传 + 目录上传。
3. runtime + daemon：并发、重试、取消、超时、用户消息回传。
4. LaTeX MCP：成功/失败路径可观测。
5. Desktop MVP：Task Center、Task Detail、Results、History、MCP Config、Settings。
6. Skills：runtime 侧 catalog 注入（默认/显式/关键词触发/adapter override）。

## 3. 当前阻塞与风险

1. `mac -> win` 跨机回归样本不足，稳定性未形成基准。
2. 下行数据面已实现文件级与目录级能力，批量策略与跨机稳定性仍需强化。
3. 多 MCP 组合调度尚未做系统验证。
4. 桌面端托盘最小闭环、通知策略基础配置与失败任务重试（单任务+批量策略配置+负载路由+退避）已接入，但跨机稳定性基线仍未固化。
5. 构建产物无代码签名，发布链路安全性不足。

## 4. 建议下一个开发批次（按优先级）

1. `P0`：跨机回归脚本化（已落地增强版脚本，待持续回归）
   - 已有：`scripts/regression_mac_win.py` + `scripts/smoke_mac_client.sh`。
   - 已有：`scripts/phase2_local_baseline.py`（自动拉起 nats+node+regression 的本地基线脚本）。
   - 已有：支持 `--repeat` 多轮回归、`--pass-rate-threshold` 门槛和 scenario 级统计。
   - 目标：固定 5 组场景（echo / upload-dir / download-dir / download-file / latex）在 Mac->Win 可重复通过。
2. `P0`：下载回传协议（已落地文件级+目录级+分页列表+并发批量策略，待跨机稳定性强化）
   - 已有：`workflow_cli download-file`、`workflow_cli download-dir`、Desktop `Download Artifact`。
   - 已有：`download-dir --list-page-size`、`download-dir --max-parallelism`、`download-dir --continue-on-error`。
   - 目标：支持 node -> controller 文件/目录/截图拉取，打通完整闭环。
3. `P1`：桌面端任务可视化增强
   - 已有：任务时间线展示、`Re-run Selected Task`、`Export Event Stream (.ndjson)`、节点侧 `Agent Check`（可接单/能力缺失检查）。
   - 已有：`Task Detail` 错误码徽标与用户消息映射、Queue 最近失败告警摘要（支持跳转详情、复制和导出失败上下文）。
   - 已有：Queue 最近失败告警支持一键重试最近失败任务（`Retry Failed Task`）。
   - 已有：`Quick Operations` 支持按任务类型/错误码筛选的 `Retry Failed Batch`，并支持策略配置（最大批量/间隔/跳过类型/路由模式/尝试次数/退避基线）。
   - 已有：`History` 页恢复信息面板（`rerun_of/rerun_trigger` + 来源任务状态/错误码）。
   - 已有：`Notifications` 通知中心基础版（关键事件聚合、去重计数、分级过滤、已读管理、复制、清空、详情查看、单条已读）。
   - 已有：通知策略基础配置（最大缓存、去重窗口、自动已读）并已接入 `Settings` 持久化。
   - 已有：错误码提取与映射共享模块（CLI/Desktop 共用），CLI 传输命令已接入统一 `error_summary`。
   - 目标：通知规则可配置化、托盘策略细化与任务恢复机制完善。
4. `P1`：MCP 能力感知
   - 目标：在节点快照中展示已注册 MCP 能力摘要。
5. `P2`：发布签名与供应链
   - 目标：Windows 签名 + macOS notarization 自动化。

## 5. 交付标准（Definition of Done）

1. CLI 与 Desktop 均可触发并验证场景通过。
2. 文档有对应更新（handover + quickstart + smoke test）。
3. 关键路径有日志定位信息（node/client/desktop 三侧）。
4. 至少一次 compile/smoke 验证通过并留痕。
