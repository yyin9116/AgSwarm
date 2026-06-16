import type { Device } from '../components/DevicesView';
import type { AgentPlan, TaskDraft, TaskType } from '../types/agswarm';

const TASK_TRIGGER_PATTERN = /(?:\b(?:send|dispatch|run|execute|compile|upload|download|copy|transfer|device|node|peer|latex|file|agent task)\b|任务|发送|派发|执行|编译|上传|下载|设备|节点)/i;
type RawAgentPlan = Partial<TaskDraft> | { intent?: 'reply'; reply?: string };

export function shouldPlanTask(prompt: string, hasFile: boolean): boolean {
  if (hasFile) return true;
  return TASK_TRIGGER_PATTERN.test(prompt);
}

export function parseAgentPlan(text: string, originalPrompt: string): AgentPlan {
  const parsed = parseJsonPlan(text);
  if (parsed) {
    if (parsed.intent === 'orchestrate') {
      return normalizeDraft(parsed, originalPrompt);
    }
    if (parsed.intent === 'reply') {
      return { intent: 'reply', reply: String(parsed.reply || text) };
    }
  }

  const heuristic = inferTaskDraft(originalPrompt);
  if (heuristic) return heuristic;
  return { intent: 'reply', reply: text || 'Ready to orchestrate tasks across your devices.' };
}

export function selectTaskTarget({
  draft,
  devices,
  localNodeId,
}: {
  draft: TaskDraft;
  devices: Device[];
  localNodeId: string;
}): Device | null {
  if (!devices.length) return null;
  const targetId = draft.targetDeviceId?.toLowerCase();
  if (targetId) {
    const byId = devices.find(device => device.id.toLowerCase() === targetId);
    if (byId) return byId;
  }

  const targetName = draft.targetDeviceName?.toLowerCase();
  if (targetName) {
    const byName = devices.find(device => device.name.toLowerCase().includes(targetName));
    if (byName) return byName;
  }

  const type = draft.targetDeviceType.toLowerCase();
  const remoteDevices = devices.filter(device => device.id !== localNodeId);
  const candidates = remoteDevices.length ? remoteDevices : devices;
  return candidates.find(device => matchesDevice(device, type)) || candidates[0] || null;
}

export function taskDraftToMarkdown({
  draft,
  target,
  status,
  result,
}: {
  draft: TaskDraft;
  target: Device;
  status: 'created' | 'dispatching' | 'running' | 'completed' | 'failed';
  result?: string;
}): string {
  const lines = [
    `### ${draft.title || taskTitle(draft)}`,
    '',
    `- Status: ${status}`,
    `- Target: ${target.name} (${target.id})`,
    `- Type: ${draft.taskType}`,
  ];
  if (draft.reason) lines.push(`- Reason: ${draft.reason.trim()}`);
  if (draft.payload.trim()) {
    lines.push('', '#### Payload', '', formatMarkdownBody(draft.payload));
  }
  if (result?.trim()) {
    lines.push('', '#### Result', '', formatMarkdownBody(result));
  }
  return lines.join('\n');
}

function parseJsonPlan(text: string): RawAgentPlan | null {
  try {
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeDraft(parsed: Partial<TaskDraft>, originalPrompt: string): TaskDraft {
  return {
    intent: 'orchestrate',
    targetDeviceType: String(parsed.targetDeviceType || 'desktop'),
    targetDeviceId: parsed.targetDeviceId ? String(parsed.targetDeviceId) : undefined,
    targetDeviceName: parsed.targetDeviceName ? String(parsed.targetDeviceName) : undefined,
    taskType: normalizeTaskType(String(parsed.taskType || 'Agent')),
    payload: String(parsed.payload || originalPrompt).trim(),
    title: parsed.title ? String(parsed.title) : undefined,
    reason: parsed.reason ? String(parsed.reason) : undefined,
  };
}

function inferTaskDraft(prompt: string): TaskDraft | null {
  const lower = prompt.toLowerCase();
  if (!TASK_TRIGGER_PATTERN.test(prompt)) return null;
  return {
    intent: 'orchestrate',
    targetDeviceType: inferTargetDeviceType(lower),
    taskType: inferTaskType(lower),
    payload: prompt,
    title: 'Task draft',
  };
}

function inferTargetDeviceType(lowerPrompt: string): string {
  if (lowerPrompt.includes('iphone') || lowerPrompt.includes('ios')) return 'ios';
  if (lowerPrompt.includes('android')) return 'android';
  if (lowerPrompt.includes('mac')) return 'mac';
  if (lowerPrompt.includes('windows') || lowerPrompt.includes('pc')) return 'windows';
  if (lowerPrompt.includes('mobile') || lowerPrompt.includes('手机')) return 'mobile';
  return 'desktop';
}

function inferTaskType(lowerPrompt: string): TaskType {
  if (lowerPrompt.includes('latex') || lowerPrompt.includes('tex') || lowerPrompt.includes('编译')) return 'LaTeX';
  if (lowerPrompt.includes('file') || lowerPrompt.includes('upload') || lowerPrompt.includes('上传')) return 'File';
  if (lowerPrompt.includes('echo') || lowerPrompt.includes('message') || lowerPrompt.includes('发送')) return 'Echo';
  return 'Agent';
}

function normalizeTaskType(value: string): TaskType {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'echo') return 'Echo';
  if (normalized === 'latex') return 'LaTeX';
  if (normalized === 'file') return 'File';
  return 'Agent';
}

function matchesDevice(device: Device, requestedType: string): boolean {
  if (!requestedType) return false;
  const haystack = [device.id, device.name, device.type, device.os, ...(device.backgroundTasks || [])]
    .join(' ')
    .toLowerCase();
  return haystack.includes(requestedType);
}

function taskTitle(draft: TaskDraft): string {
  if (draft.taskType === 'LaTeX') return 'LaTeX compile task';
  if (draft.taskType === 'File') return 'File transfer task';
  if (draft.taskType === 'Echo') return 'Message task';
  return 'AgSwarm AI task';
}

function formatMarkdownBody(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return looksLikeMarkdownBlock(trimmed) ? trimmed : `\`\`\`text\n${trimmed}\n\`\`\``;
}

function looksLikeMarkdownBlock(value: string): boolean {
  return /(^|\n)(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s|\|.+\|)/.test(value);
}
