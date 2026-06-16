import { Box, Group, Text, ThemeIcon } from '@mantine/core';
import { Check, Wrench } from 'lucide-react';
import type { ReactActivityMessageRenderer, ReactToolCallRenderer } from '@copilotkit/react-core/v2';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type PiActivityContent = {
  title?: string;
  status?: string;
  stage?: string;
  detail?: string;
};

export function createPiActivityRenderer(agentId: string): ReactActivityMessageRenderer<PiActivityContent> {
  return {
    activityType: 'agswarm.pi.status',
    agentId,
    content: objectSchema<PiActivityContent>(),
    render: ({ content }) => {
      const summary = activitySummary(content);
      if (!summary || content.stage === 'completed') return null;
      return (
        <PiStatusFrame
          title={content.title || 'AgSwarm AI'}
          status={content.status || 'running'}
          summary={summary}
          detail={content}
          tone={content.stage === 'tool_complete' ? 'done' : 'running'}
        />
      );
    },
  };
}

export function createPiToolRenderer(agentId: string): ReactToolCallRenderer<Record<string, unknown>> {
  return {
    name: '*',
    agentId,
    args: objectSchema<Record<string, unknown>>(),
    render: ({ name, status, args, result }) => {
      const isDone = status === 'complete';
      return (
        <PiStatusFrame
          title={toolTitle(name)}
          status={status}
          summary={toolSummary(name, status, args, result)}
          detail={{ tool: name, status, args, result }}
          tone={isDone ? 'done' : 'running'}
        />
      );
    },
  };
}

function PiStatusFrame({
  title,
  status,
  summary,
  detail,
  tone = status === 'complete' ? 'done' : 'running',
}: {
  title: string;
  status: string;
  summary: string;
  detail: unknown;
  tone?: 'running' | 'done' | 'neutral';
}) {
  const isDone = tone === 'done' || status === 'complete';
  return (
    <Box className={`agswarm-pi-status ${isDone ? 'is-done' : 'is-running'}`}>
      <details>
        <summary>
          <Group gap="xs" wrap="nowrap" className="agswarm-pi-status-summary">
            <ThemeIcon size="sm" radius="xl" variant="subtle" color={isDone ? 'teal' : 'gray'}>
              {isDone ? <Check size={12} /> : <Wrench size={12} />}
            </ThemeIcon>
            <Text size="xs" fw={500} truncate>
              {title}
            </Text>
            {summary && (
              <Text size="xs" c="dimmed" truncate>
                {summary}
              </Text>
            )}
          </Group>
        </summary>
        <pre aria-label="Tool call details">{formatDetail(detail)}</pre>
      </details>
    </Box>
  );
}

type RendererSchema<T> = StandardSchemaV1<unknown, T> & {
  safeParse: (value: unknown) => { success: true; data: T };
};

function objectSchema<T>(): RendererSchema<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'agswarm',
      validate(value: unknown) {
        return { value: normalizeObject<T>(value) };
      },
    },
    safeParse(value: unknown) {
      return { success: true as const, data: normalizeObject<T>(value) };
    },
  };
}

function normalizeObject<T>(value: unknown): T {
  return value && typeof value === 'object' ? value as T : {} as T;
}

function activitySummary(content: PiActivityContent): string {
  if (content.detail) return content.detail;
  if (content.stage) return readableStage(content.stage);
  return '';
}

function toolTitle(name: string): string {
  if (name.includes('dispatch_task')) return '派发 AgSwarm 任务';
  if (name.includes('workspace_info')) return '读取工作区信息';
  if (name.includes('python')) return '运行 Python 脚本';
  if (name.includes('shell')) return '执行终端命令';
  if (name.includes('search') || name.includes('find')) return '搜索内容';
  if (name.includes('tool_result')) return '工具返回结果';
  return `调用 ${name}`;
}

function toolSummary(name: string, status: string, args: Record<string, unknown>, result?: unknown): string {
  if (status === 'complete') return completedToolLabel(name, result);
  const reason = stringValue(args.reason);
  if (reason) return reason;
  const command = stringValue(args.command);
  if (command) return summarizeCommand(command);
  const target = stringValue(args.targetName) || stringValue(args.target);
  if (target) return `正在发送到 ${target}`;
  return toolTitle(name);
}

function completedToolLabel(name: string, result: unknown): string {
  const resultText = stringValue(result);
  if (/read|open|cat/i.test(name)) return '已读取';
  if (/search|find|grep|rg|glob/i.test(name)) return '已搜索';
  if (/exec|shell|command|bash|run/i.test(name)) return '已执行命令';
  if (/write|edit|patch/i.test(name)) return '已修改';
  if (resultText) return '已完成';
  return '已调用';
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (/wttr\.in/i.test(normalized)) return '正在查询天气';
  if (/python/i.test(normalized)) return '正在运行脚本';
  if (/curl/i.test(normalized)) return '正在请求网络';
  return '正在执行命令';
}

function readableStage(stage: string): string {
  const labels: Record<string, string> = {
    planning: '正在规划下一步',
    remote_pi: '正在连接 AgSwarm AI',
    tool_planning: '正在选择工具',
    tool_running: '正在运行工具',
    task_dispatch: '正在派发任务',
    turn_start: 'AgSwarm AI 开始思考',
    error: '执行遇到错误',
  };
  return labels[stage] || stage;
}

function statusLabel(status: string): string {
  if (status === 'complete') return '完成';
  if (status === 'executing' || status === 'running') return '进行中';
  if (status === 'inProgress') return '准备中';
  return status;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatDetail(value: unknown): string {
  return formatTraceLines(value).join('\n') || 'No extra detail.';
}

function formatTraceLines(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') {
    const text = String(value).trim();
    return text ? [`${prefix}${text}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => formatTraceLines(item, `${prefix}${index + 1}. `));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
    if (raw === null || raw === undefined || raw === '') return [];
    const label = readableDetailKey(key);
    if (typeof raw === 'object') {
      const nested = formatTraceLines(raw);
      return nested.length ? [`${prefix}${label}:`, ...nested.map(line => `  ${line}`)] : [];
    }
    return [`${prefix}${label}: ${String(raw)}`];
  });
}

function readableDetailKey(key: string): string {
  const labels: Record<string, string> = {
    tool: '工具',
    status: '状态',
    args: '参数',
    result: '结果',
    command: '命令',
    cwd: '工作目录',
    ok: '是否成功',
    exitCode: '退出码',
    durationMs: '耗时',
    stderr: '错误输出',
    stdout: '标准输出',
    target: '目标',
    targetName: '目标设备',
    reason: '原因',
    type: '类型',
  };
  return labels[key] || key.replace(/([A-Z])/g, ' $1').toLowerCase();
}
