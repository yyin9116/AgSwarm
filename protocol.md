# Runtime Protocol (v0.1)

目标：基于“薄 Runtime + 可插拔 Adapter”，统一任务输入与事件输出，不把状态机和调度耦合进第三方框架。

## 1) TaskEnvelope

```json
{
  "version": "1.0",
  "task_id": "8a69ccf3-6550-4f1b-b9ac-7d40fc36297b",
  "created_at": "2026-02-28T14:00:00Z",
  "session": {
    "session_id": "sess-001",
    "user_id": "u-001",
    "trace_id": "trace-001"
  },
  "input": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "帮我总结今天的 standup 风险项"
      }
    ]
  },
  "controls": {
    "stream": true,
    "timeout_ms": 120000,
    "max_steps": 24
  },
  "adapter": {
    "name": "openai_agents",
    "model": "gpt-4.1-mini",
    "options": {
      "instructions": "你是一个工程团队助理。"
    }
  },
  "context": {
    "memory": {},
    "artifacts": []
  },
  "metadata": {}
}
```

字段约定：
- `task_id`：全局唯一任务 ID（建议 UUID v4）。
- `input.content`：允许多段内容，MVP 先支持 `type=text`。
- `controls.stream`：决定是否流式输出事件。
- `adapter.name`：由 Runtime 路由到具体 Adapter。

## 2) Adapter 事件协议

统一事件封装（所有 Adapter 必须输出）：

```json
{
  "version": "1.0",
  "event_id": "0eea84cd-c740-4968-81c7-4e6f1c1f4608",
  "task_id": "8a69ccf3-6550-4f1b-b9ac-7d40fc36297b",
  "sequence": 3,
  "type": "adapter.token",
  "ts": "2026-02-28T14:00:01Z",
  "payload": {}
}
```

事件类型（MVP）：
- `task.accepted`：Runtime 接受任务并完成基础校验。
- `adapter.started`：具体 Adapter 开始执行。
- `adapter.token`：增量文本（流式）。
- `adapter.tool_call.started`：发起工具调用。
- `adapter.tool_call.delta`：工具输出增量（可选）。
- `adapter.tool_call.completed`：工具调用结束。
- `adapter.completed`：任务正常完成，`payload.output` 为最终输出。
- `adapter.error`：执行失败，`payload` 包含 `code`/`message`。

## 3) 传输层建议

- `stdio`：本地 Agent/MCP 进程通信（低延迟、部署简单）。
- `Streamable HTTP`：远程服务流式返回事件。
- 事件序列化建议使用 `application/x-ndjson`（每行一个事件对象）。

## 4) 兼容性原则

- Runtime 不感知框架内部对象，仅处理 TaskEnvelope 与事件流。
- Adapter 内部可自由接入 OpenAI Agents SDK / PydanticAI / mcp-agent。
- 新增 Adapter 时，不改 Runtime 主干，只扩展注册表。

## 5) 当前实现状态

- `OpenAIAgentsAdapter`：已落地（`adapter.name = openai_agents`）。
- `PydanticAIAdapter`：已落地（`adapter.name = pydantic_ai`）。
- `mcp-agent`：预留接口，建议先做 PoC 后再并入默认发行版。

## 6) Daemon MVP（本仓当前实现）

- 新增 `WorkflowNodeDaemon`（`src/workflow_node_daemon/daemon.py`）：
  - 内存队列调度（`max_concurrency`）。
  - 任务提交、取消、状态查询、等待完成。
  - 超时控制（读取 `TaskEnvelope.controls.timeout_ms`）。
  - 失败重试（`default_retries` / `submit(..., max_retries=...)`）。
- 状态枚举：`pending -> running -> retrying -> (succeeded | failed | canceled)`。
- 每个任务保留事件历史，支持 `get_task_events(task_id)` 读取。
