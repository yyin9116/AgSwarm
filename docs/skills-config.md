# Skills Config（Agent Runtime）

## 1. 目标

给节点侧 runtime 增加轻量 skills 机制，避免改动 adapter 库代码，支持：

1. 默认技能（`default`）。
2. 按任务显式指定技能（`metadata.skills` / `context.skills`）。
3. 基于关键词自动触发（`auto_when_any_keywords`）。
4. 按 adapter 定制模型与 options（`adapter_overrides`）。

## 2. 配置文件

示例文件：`configs/skills.example.json`

格式：

```json
{
  "skills": [
    {
      "id": "safe_default",
      "name": "Safe Default",
      "description": "Default guardrails",
      "enabled": true,
      "default": true,
      "instructions": "..."
    }
  ]
}
```

字段说明：

1. `id`：技能唯一标识。
2. `enabled`：是否启用。
3. `default`：是否默认应用到每个任务。
4. `instructions`：注入到 `task.adapter.options.instructions`。
5. `auto_when_any_keywords`：任一关键词命中即自动启用。
6. `adapter_overrides.<adapter_name>.model`：覆盖模型。
7. `adapter_overrides.<adapter_name>.options`：深度合并到 adapter options。

## 3. 节点侧启用

方式 1：环境变量（推荐）

```bash
set WORKFLOW_SKILLS_CONFIG=configs/skills.example.json
python -m workflow_cli node --node-id node-a --nats-url nats://127.0.0.1:4222
```

方式 2：CLI 参数

```bash
python -m workflow_cli node --node-id node-a --nats-url nats://127.0.0.1:4222 --skills-config configs/skills.example.json
```

## 4. 任务侧指定 skills

CLI：

```bash
python -m workflow_cli submit-echo --node-id node-a --skills safe_default
python -m workflow_cli submit-latex --node-id node-a --workspace D:\data --latex-mcp-dir D:\yin\project\latex-mcp --main-tex main.tex --skills safe_default,latex_compile
```

Desktop：

1. Task Center 新增 `Skills` 输入框（逗号分隔）。
2. 发送 Echo/LaTeX 任务时会透传到 `TaskEnvelope.metadata.skills`。

## 5. 事件与元数据

1. runtime 成功应用 skills 后会发事件：`task.skills.applied`。
2. 任务元数据写入：
   - `metadata.applied_skills`
   - `metadata.skills_source`
3. 应用失败会发事件：`task.skills.error`，并继续执行任务（不中断）。
