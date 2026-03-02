# 开源组件补充方案（ZMQ / NATS / Ray / Agent 执行层）

## 1. 结论（和当前项目的匹配）

你的调研内容可以形成强补充，但建议按“分层可替换”接入，而不是一次性全量引入。

推荐优先级：

1. **通信层首选 NATS（MVP）**：最快补齐跨机任务队列、节点状态广播、任务事件流。
2. **通信层备选 ZMQ（极简 P2P）**：适合无中心节点场景，但需要我们补齐发现、鉴权、重试语义。
3. **调度层暂不引入 Ray**：等出现真实“跨机 Python 计算吞吐瓶颈”再接入。
4. **执行层沿用当前 Adapter 架构**：可插 OpenInterpreter / browser-use / MCP，不改 daemon 主逻辑。

## 2. 与当前代码的映射

当前已存在：

1. `workflow_node_daemon`：本地队列、并发、重试、取消、状态快照。
2. `workflow_runtime`：`TaskEnvelope/Event` + Adapter 插件点。

可直接扩展为：

1. `transport`（新模块）：负责跨机收发。
2. `scheduler`（轻量）：负责节点空闲感知和派发。
3. `adapter`（已有）：负责执行 OpenInterpreter / browser-use / MCP 工具链。

## 3. 组件对比（针对本项目）

### 3.1 ZeroMQ

适配度：中

优点：

1. 无 broker，部署轻。
2. 模式灵活（Pub/Sub、Push/Pull、Req/Rep）。
3. 延迟低，适合局域网。

短板：

1. 不自带服务发现、持久化队列、完整任务确认语义。
2. 安全与鉴权要自己搭（CURVE/密钥分发）。
3. 运维与调试成本会随着节点增长上升。

建议：

1. 适合做“纯 P2P 极简版”。
2. 若采用，必须补：任务 ACK、重投、节点心跳、离线缓存。

### 3.2 NATS

适配度：高

优点：

1. 单二进制，部署轻量。
2. 天然适配事件总线、任务队列、节点状态广播。
3. 可快速实现“谁空闲谁消费”的队列模型。

短板：

1. 引入中心服务（虽然很轻）。
2. 纯局域网 P2P 美学上不如 ZMQ“无中心”。

建议：

1. 作为 MVP 首选通信层。
2. 先用 Core NATS；后续需要持久化再评估 JetStream。

### 3.3 Ray

适配度：中（当前阶段）

优点：

1. 对 Python 分布式计算和资源调度很强。
2. 支持“按资源约束调度任务到空闲机器”。

短板：

1. 相比 NATS/ZMQ 更重，学习与运维开销更大。
2. 与我们已有 daemon 调度可能产生职责重叠。

建议：

1. 当前不作为主干。
2. 保留为“计算密集任务子系统”扩展（例如批量渲染/训练）。

## 4. Agent 执行层补充（你给的 OpenInterpreter / browser-use）

与你当前架构兼容性：高。

做法：

1. 在 `workflow_runtime/adapters/` 新增：
- `openinterpreter_adapter.py`
- `browser_use_adapter.py`

2. 复用已有协议：
- 输入 `TaskEnvelope`
- 输出统一 `Event`（`adapter.started/token/completed/error`）

3. MCP 集成策略：
- 每台节点维护本地 MCP registry（已在 spec 定义）。
- Adapter 启动时先查本机 MCP 能力，再执行任务。

## 5. 推荐落地路线（最小改动）

### 阶段 A（先做）

1. 新增传输抽象接口：`TransportProvider`。
2. 先实现 `NatsTransportProvider`。
3. Daemon 增加“远程 submit + 远程 event stream”。

### 阶段 B

1. 增加 `OpenInterpreterAdapter`（或 browser-use 二选一先打通）。
2. 跑通“主端发指令 -> 远端执行 -> 回传日志/产物元数据”。

### 阶段 C

1. 如有必要新增 `ZmqTransportProvider` 作为无中心备选。
2. 如出现计算吞吐瓶颈，再引入 Ray 承担计算子任务。

## 6. 与现有 Spec 的补充关系

这套建议不替代现有 `workflow-control-spec.md`，而是提供“实现路径分叉”：

1. 主路径：`LocalSend 风格传输 + 自研调度`。
2. 补充路径：`NATS 事件总线（更快落地）`。
3. 高级路径：`Ray 作为计算子系统（后置）`。

本质是统一到同一个 `TaskEnvelope/Event/Adapter` 边界，避免技术栈绑定。
