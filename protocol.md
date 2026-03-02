# Runtime Protocol (v0.2)

## Goal

Use a thin runtime with pluggable adapters. Keep task orchestration and scheduling in `workflow_node_daemon`, and keep model/tool execution in adapter implementations.

## 1. TaskEnvelope

```json
{
  "version": "1.0",
  "task_id": "8a69ccf3-6550-4f1b-b9ac-7d40fc36297b",
  "created_at": "2026-02-28T14:00:00Z",
  "adapter": {
    "name": "openai_agents",
    "model": "gpt-4.1-mini",
    "options": {
      "instructions": "You are a helpful assistant"
    }
  },
  "input_text": "Summarize today's standup risks",
  "controls": {
    "stream": true,
    "timeout_ms": 120000,
    "max_steps": 24
  },
  "context": {},
  "metadata": {}
}
```

Field notes:

1. `task_id`: globally unique task ID (UUID recommended).
2. `adapter.name`: adapter routing key (`openai_agents`, `pydantic_ai`, etc.).
3. `controls.timeout_ms`: runtime timeout budget.
4. `context`/`metadata`: extension fields for future routing and observability.

## 2. Event Envelope

All adapters emit normalized events via `EventSink`:

```json
{
  "version": "1.0",
  "event_id": "0eea84cd-c740-4968-81c7-4e6f1c1f4608",
  "task_id": "8a69ccf3-6550-4f1b-b9ac-7d40fc36297b",
  "sequence": 3,
  "type": "adapter.token",
  "ts": "2026-02-28T14:00:01Z",
  "payload": {
    "text": "partial output"
  }
}
```

MVP event types:

1. `task.accepted`
2. `adapter.started`
3. `adapter.token`
4. `adapter.completed`
5. `adapter.error`

Optional extension events:

1. `adapter.tool_call.started`
2. `adapter.tool_call.delta`
3. `adapter.tool_call.completed`
3. `task.progress`

## 3. Daemon Task State

Daemon status machine:

1. `pending`
2. `running`
3. `retrying`
4. `succeeded`
5. `failed`
6. `canceled`

Retry rule:

1. If outcome is failed and `attempts <= max_retries`, move to `retrying`.
2. Otherwise move to `failed`.

Cancel rule:

1. Cancellation can happen before start, before attempt, during run, or after run.
2. Terminal status is always `canceled` once cancel is accepted.

## 4. Snapshot Contracts

### 4.1 TaskSnapshot

```json
{
  "task_id": "...",
  "status": "succeeded",
  "attempts": 1,
  "max_retries": 1,
  "created_at": "...",
  "started_at": "...",
  "finished_at": "...",
  "error": null,
  "cancel_requested": false,
  "progress": 100,
  "current_step": null,
  "last_event_type": "adapter.completed",
  "last_error_code": null
}
```

### 4.2 NodeSnapshot

```json
{
  "status": "idle",
  "max_concurrency": 1,
  "active_tasks": 0,
  "queued_tasks": 0,
  "total_tasks": 1
}
```

## 5. Error Codes (MVP)

1. `adapter_not_found`
2. `missing_dependency`
3. `adapter_run_failed`
4. `runtime_timeout`
5. `runtime_exception`
6. `task_canceled`

## 6. Adapter Boundary

Runtime only depends on:

1. `TaskEnvelope`
2. `EventSink.emit(type, payload)`
3. `Adapter.run(task, sink)`

This keeps framework swap cost low (OpenAI Agents SDK / PydanticAI / mcp-agent).

## 7. Next Protocol Work

1. Add transport-level envelope for LAN delivery (`TaskEnvelope` + file manifests).
2. Add artifact event schema (`artifact.created`, `artifact.uploaded`).
3. Add progress step schema (`step`, `progress`, `eta_sec`, `resource_snapshot`).
4. Define WebSocket/NDJSON stream framing for controller UI.
