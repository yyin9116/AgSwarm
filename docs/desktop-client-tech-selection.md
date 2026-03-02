# 桌面客户端技术选型讨论稿（v0.1）

更新时间：2026-02-28

## 1. 目标与约束

桌面客户端要满足：

1. macOS/Windows 双端可运行。
2. 支持拖拽文件/文件夹、任务发送、节点状态、任务日志、结果快捷操作。
3. 可复用现有 Python 实现（`workflow_control_client`、NATS、任务协议、日志体系）。
4. 开发复杂度可控，避免“改库级”二次开发。

## 2. 候选方案

### 方案 A：Electron + React + TypeScript + Python sidecar

优点：

1. 前端生态成熟，UI 开发快。
2. 拖拽、通知、剪贴板能力完善。

缺点：

1. 体积和内存占用大。
2. 需要维护 Node + Python 双运行时与 IPC。
3. 打包和签名链路更重。

### 方案 B：Tauri + React + TypeScript + Python sidecar

优点：

1. 包体更小、资源占用低于 Electron。
2. 前端体验好，便于实现 PRD 中复杂交互。

缺点：

1. 仍需 Web 前端 + Rust + Python 三层协同。
2. Python sidecar 管理、崩溃重启、路径兼容需要专门处理。

### 方案 C：PySide6 + qasync（纯 Python 桌面）

优点：

1. 与现有代码同语言，复用最高。
2. 可以直接调用 `workflow_control_client`，最短路径可交付。
3. 调试链路简单（一个进程模型即可跑 MVP）。

缺点：

1. UI 视觉与组件生态不如 Web 技术栈自由。
2. 若后续做复杂动画/皮肤，开发体验不如前端栈。

## 3. 推荐结论

建议采用 **两阶段策略**：

1. **阶段 1（当前）**：`PySide6 + qasync` 先交付桌面 MVP，优先跑通业务闭环。
2. **阶段 2（可选）**：若后续强交互/品牌化需求明显，再迁移 UI 到 Tauri（后端协议保持不变）。

理由：

1. 当前核心能力已在 Python 代码里（NATS、任务、上传、日志、MCP 适配），纯 Python UI 复用率最高。
2. 你当前目标是“尽快可联调可用”，不是先做高成本 UI 基建。
3. 迁移空间保留：后续只要把桌面 UI 改成前端壳，底层服务层协议可保持。

## 4. 建议程序结构（阶段 1）

建议新增模块：

1. `src/workflow_desktop/`
2. `src/workflow_desktop/app.py`（Qt 应用入口）
3. `src/workflow_desktop/state/`（节点、任务、日志状态）
4. `src/workflow_desktop/services/`（对接 `WorkflowControlClient`）
5. `src/workflow_desktop/views/`（任务中心、节点页、MCP 配置、历史）

运行模型：

1. UI 主线程：Qt 事件循环。
2. 网络与任务：`qasync` + `asyncio` 协程。
3. 后台通信：复用 `NatsTransportProvider`、`WorkflowControlClient`。

## 5. 与 Pencil 原型的映射

按现有 Pencil 蓝图与 `ui-prd.md`，优先做 3 个页面：

1. `任务中心`（三栏：节点/创建/任务）
2. `任务详情`（时间线 + 实时日志 + 产物）
3. `节点页`（资源与能力）

## 6. 首批依赖建议（阶段 1）

1. `PySide6`
2. `qasync`
3. （可选）`pydantic`（UI 状态模型）

## 7. 里程碑建议

M1（1-2 天）：

1. 应用壳 + 左中右三栏静态布局（对齐 Pencil）。
2. 接入节点快照轮询。

M2（2-3 天）：

1. 拖拽上传（文件/目录）+ `submit-echo`/`submit-latex`。
2. 任务队列与终态消息展示（含 `task.user_message`）。

M3（2 天）：

1. 产物列表与快捷操作（打开目录/复制路径）。
2. 日志面板与错误定位体验完善。

