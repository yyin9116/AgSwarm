# Workflow 阶段总览（Phase Overview）

更新时间：2026-03-01

## 1. 当前阶段结论

1. 当前处于 `Phase-2`。
2. 阶段定义：`MVP 联调可用，进入跨机稳定性与产品化阶段`。
3. 总体状态：核心链路可用，跨机稳定性与发布工程化未完成。

## 2. 三阶段定义

### Phase-1（已完成）

目标：

1. 单机控制面与数据面闭环可跑通。
2. 基础任务分发、事件回传、文件传输具备可用形态。

已完成要点：

1. NATS 控制面：`task submit / event stream / node snapshot`。
2. Runtime + Node Daemon：并发、重试、取消、超时、用户消息。
3. 文件传输：`prepare/chunk/commit`、断点续传、目录上传。
4. LaTeX MCP 成功/失败路径可观测。

### Phase-2（进行中）

目标：

1. `mac -> win` 跨机回归稳定。
2. 桌面客户端 MVP 完整可用并具备基础排障能力。
3. 形成可复用的调试、日志、错误结构化输出。

已完成：

1. Desktop 多 Tab MVP：`Task Center / Task Detail / Results / History / MCP / Settings`。
2. `Agent Check`（可接单/能力缺失检查）。
3. Task Detail 错误码徽标与用户消息摘要。
4. Queue 失败告警：摘要、跳转详情、复制失败详情、导出失败上下文。
5. CLI 传输命令失败结构化输出：统一 `error_summary`。
6. 共享错误模块：`src/workflow_runtime/error_codes.py`（CLI/Desktop 共用）。
7. 单元测试落地：`tests/test_error_codes.py`、`tests/test_cli_error_summary.py`。
8. 通知中心基础版：关键事件聚合、短窗口去重计数、分级过滤、已读管理、复制、清空、详情查看。
9. 跨机回归脚本支持多轮重复、通过率阈值与 scenario 级统计汇总。
10. Desktop 系统托盘最小闭环：关闭窗口最小化到托盘，托盘菜单支持恢复与退出。
11. Desktop 失败任务一键重试：Queue 告警支持 `Retry Failed Task`，可复用原请求参数重试。
12. Desktop 批量重试能力：`Retry Failed Batch` 支持按任务类型/错误码筛选，且策略（上限/间隔/跳过类型/路由模式/尝试次数/退避基线）可配置，`History` 提供恢复信息面板。
13. 本地 Phase-2 稳定性基线脚本已落地：`scripts/phase2_local_baseline.py`，可自动拉起 nats+node 并输出回归报告。
14. Windows 上传稳定性修复：文件提交阶段对 `replace/unlink` 增强容错，修复 `WinError 32/2` 偶发失败。

未完成（Phase-2 收尾项）：

1. 跨机 E2E 稳定性基线（真实 mac->win 样本量、重复通过率、失败归因）尚未固化。
2. 多 MCP 组合场景未系统验证。
3. 桌面通知中心基础版与托盘最小闭环已上线，通知策略基础配置与失败任务重试（单任务+批量策略配置+负载路由+退避）已支持；跨机稳定性基线仍待固化。

### Phase-3（未开始）

目标：

1. 生产化能力补齐：高级通知策略/托盘、发布签名、供应链、部署规范。
2. 质量与发布流程工程化（可审计、可复现、可回滚）。

范围：

1. 下载回传策略进一步强化（批量/异常恢复/跨机长稳）。
2. 通知中心、系统托盘、任务恢复/重试编排。
3. Windows 签名 + macOS notarization 自动化。
4. 生产部署与运维规范（监控、日志留存、版本策略）。

## 3. 阶段验收标准（DoD）

### Phase-1 DoD（已达成）

1. 本地端到端链路可跑通。
2. 基础上传下载与任务执行可观测。

### Phase-2 DoD（进行中）

1. CLI + Desktop 在跨机场景可重复通过核心回归集。
2. 关键失败路径有结构化错误与用户可见提示。
3. 文档、日志、回归报告可支撑交接和定位。

### Phase-3 DoD（未达成）

1. 发布产物签名/公证自动化完成。
2. 系统通知与任务恢复机制上线。
3. 形成稳定的版本发布与回滚规范。

## 4. 当前风险清单（按优先级）

1. `mac -> win` 跨机回归样本不足，稳定性指标未固化。
2. 多 MCP 组合调度未形成系统验证矩阵。
3. Desktop 仍缺高级通知编排与跨机稳定性指标固化（托盘目前为最小闭环）。
4. Desktop 打包体积偏大（当前为确保稳定使用 `collect-all PySide6`），后续需做插件裁剪。
5. 签名与供应链流程尚未接入。

## 5. 下一里程碑（建议）

1. 先完成跨机回归基线：固定场景、固定次数、固定报告模板。
2. 推进 Desktop 任务恢复机制与高级通知编排。
3. 优化 Windows/Mac 打包体积与插件收敛策略，保持可分发稳定性。
4. 启动签名与发布自动化（先 Windows，后 macOS）。

## 6. 关联文档

1. `docs/handover.md`
2. `docs/mainline-roadmap.md`
3. `docs/phase2-checklist.md`
4. `docs/nats-dev-quickstart.md`
5. `docs/desktop-client-dev.md`
6. `docs/mac-win-smoke-test.md`
