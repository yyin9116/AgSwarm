# Phase-2 Completion Checklist

更新时间：2026-03-01

## 已完成

1. Desktop 稳定性功能：
   - 通知中心（过滤/已读/去重）
   - 托盘最小闭环
   - 失败任务重试（单任务 + 批量）
   - 重试策略配置（上限/间隔/跳过类型/路由模式/尝试次数/退避基线）
2. 错误回传与可观测：
   - CLI 结构化 `error_summary`
   - Desktop 错误码徽标/失败告警/导出上下文
3. Windows 打包：
   - `scripts/build_desktop.py` 已补齐 PySide6/qasync 收集参数
   - `workflow-desktop.exe --help` 可正常运行
4. 本地回归基线：
   - `scripts/phase2_local_baseline.py` 可自动拉起 nats + node + regression
   - 最新报告：`tmp/test-reports/phase2_local_baseline_20260301_234317.json`（repeat=2, pass_rate=1.0, skip_latex）
5. 上传稳定性修复：
   - `nats_bridge` commit 阶段对 Windows 文件锁/临时文件时序增强容错（replace/unlink）

## 待完成（Phase-2 最后门槛）

1. 真实跨机基线固化（Mac -> Win）：
   - 至少一次 `repeat >= 10`
   - `pass_rate >= 0.9`（建议 `>= 0.95`）
   - 产出并归档报告到 `tmp/test-reports/mac_win_regression_*.json`
2. 跨机含 LaTeX 场景的稳定样本：
   - `--skip-latex` 关闭后至少 1 次完整通过报告
3. 失败归因闭环：
   - 对跨机回归中的失败样本形成固定归因记录（网络/环境/MCP/协议）

## 建议验收命令

```bash
python scripts/regression_mac_win.py \
  --nats-url nats://<lan-ip>:4222 \
  --node-id <win-node-id> \
  --repeat 10 \
  --repeat-interval-sec 0.5 \
  --pass-rate-threshold 0.9 \
  --report-path tmp/test-reports/mac_win_regression_phase2_gate.json
```
