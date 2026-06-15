import type { ChatMessage } from '../components/ChatView';
import type { Device, RecentTask } from '../components/DevicesView';
import type { Task } from '../components/TasksView';
import type { LocalPeerStatus, NodeSnapshotDto, RecentTaskDto, SendTaskData } from '../types/agswarm';

export function deviceFromSnapshot(snapshot: NodeSnapshotDto, fallbackNodeId: string): Device {
  const nodeId = String(snapshot?.node_id || fallbackNodeId);
  const peer = snapshot?.peer_node || {};
  const adapters = Array.isArray(snapshot?.adapters) ? snapshot.adapters : [];
  const capabilities = Array.isArray(peer?.capabilities) ? peer.capabilities : [];
  const recentTasks = Array.isArray(snapshot?.recent_tasks) ? snapshot.recent_tasks : [];
  return {
    id: nodeId,
    name: String(peer?.device_label || snapshot?.node_id || nodeId),
    type: 'desktop',
    os: capabilities.includes('pi-agent') ? 'Pi Agent Harness' : 'AgSwarm Node',
    status: snapshot?.status === 'online' || snapshot?.status === 'idle' ? 'online' : 'idle',
    ipAddress: String(peer?.endpoint || snapshot?.nats_url || nodeId),
    storage: `${snapshot?.queue_depth || 0} queued`,
    networkType: 'Ethernet',
    backgroundTasks: [
      `adapters: ${adapters.length ? adapters.join(', ') : 'unknown'}`,
      `capabilities: ${capabilities.length ? capabilities.join(', ') : 'none'}`,
    ],
    recentTasks: recentTasks.map(normalizeRecentTask).filter(Boolean) as RecentTask[],
  };
}

export function deviceFromLocalPeerStatus(
  status: LocalPeerStatus | null,
  context: { nodeId: string; natsUrl: string; deviceLabel: string; enablePi: boolean },
): Device {
  const nodeId = status?.nodeId || context.nodeId;
  const capabilities = context.enablePi
    ? ['echo-client', 'interactive-file-stream', 'pi-agent']
    : ['echo-client', 'interactive-file-stream'];
  return {
    id: nodeId,
    name: context.deviceLabel || nodeId,
    type: 'desktop',
    os: context.enablePi ? 'Pi Agent Harness' : 'AgSwarm Node',
    status: status?.nodeRunning ? 'online' : 'offline',
    ipAddress: status?.natsUrl || context.natsUrl,
    storage: status?.natsManaged ? 'managed NATS' : 'external NATS',
    networkType: 'Ethernet',
    backgroundTasks: [
      `local peer: ${status?.nodeRunning ? 'running' : 'stopped'}`,
      `nats: ${status?.natsRunning || !status?.natsManaged ? 'available' : 'stopped'}`,
      `capabilities: ${capabilities.join(', ')}`,
    ],
  };
}

export function mergeDiscoveredWithLocal(
  discovered: Device[],
  status: LocalPeerStatus | null,
  context: { nodeId: string; natsUrl: string; deviceLabel: string; enablePi: boolean },
): Device[] {
  return upsertDevice(discovered, deviceFromLocalPeerStatus(status, context));
}

export function upsertDevice(devices: Device[], device: Device): Device[] {
  const index = devices.findIndex(item => item.id === device.id);
  if (index === -1) {
    return [device, ...devices];
  }
  return devices.map((item, itemIndex) => itemIndex === index ? {
    ...item,
    ...device,
    activeTask: item.activeTask,
    backgroundTasks: device.backgroundTasks?.length ? device.backgroundTasks : item.backgroundTasks,
    recentTasks: device.recentTasks?.length ? device.recentTasks : item.recentTasks,
  } : item);
}

export function normalizeRecentTask(raw: unknown): RecentTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as RecentTaskDto;
  const taskId = String(item.task_id || '');
  if (!taskId) return null;
  return {
    task_id: taskId,
    adapter: String(item.adapter || 'echo'),
    status: String(item.status || 'running'),
    created_at: item.created_at ? String(item.created_at) : undefined,
    started_at: item.started_at ? String(item.started_at) : null,
    finished_at: item.finished_at ? String(item.finished_at) : null,
    input_text: item.input_text ? String(item.input_text) : '',
    user_message: item.user_message ? String(item.user_message) : null,
    last_event_type: item.last_event_type ? String(item.last_event_type) : null,
    result: item.result ? String(item.result) : null,
  };
}

export function taskFromRecentTask(task: RecentTask, device: Device): Task {
  const type = task.adapter === 'pi' ? 'Agent' : task.adapter === 'latex_mcp' ? 'LaTeX' : 'Echo';
  return {
    id: task.task_id,
    type,
    target: device.name,
    direction: 'incoming',
    status: task.status === 'succeeded' ? 'completed' : task.status === 'failed' || task.status === 'canceled' ? 'failed' : 'running',
    time: formatTaskTime(task.finished_at || task.started_at || task.created_at),
    detail: task.input_text || task.user_message || `${task.adapter} task`,
    result: task.result || task.user_message || undefined,
  };
}

export function mergeTasks(existing: Task[], incoming: Task[]): Task[] {
  const byId = new Map(existing.map(task => [task.id, task]));
  for (const task of incoming) {
    byId.set(task.id, { ...byId.get(task.id), ...task });
  }
  return Array.from(byId.values()).sort((a, b) => Number(b.time === 'Just now') - Number(a.time === 'Just now'));
}

export function mergeIncomingTaskMessages(existing: ChatMessage[], incoming: Task[]): ChatMessage[] {
  const seen = new Set(existing.filter(message => message.id.startsWith('incoming-')).map(message => message.id.replace('incoming-', '')));
  const additions = incoming
    .filter(task => !seen.has(task.id))
    .map(task => {
      const chat = task.type === 'Echo' ? parseChatEnvelope(task.result || task.detail) : null;
      return task.type === 'Echo'
        ? {
            id: `incoming-${task.id}`,
            role: 'system' as const,
            content: chat ? `${chat.fromLabel}: ${chat.text}` : task.result || task.detail,
          }
        : {
            id: `incoming-${task.id}`,
            role: 'system' as const,
            content: `Incoming ${task.type} task ${task.status === 'completed' ? 'completed' : task.status}.`,
            taskProposal: {
              direction: 'incoming' as const,
              targetDeviceId: 'local-incoming',
              targetDeviceName: task.target,
              taskType: task.type,
              payload: task.detail,
              status: task.status === 'completed' ? 'completed' as const : 'running' as const,
              result: task.result,
            },
          };
    });
  return additions.length ? [...existing, ...additions] : existing;
}

export function parseChatEnvelope(value: string | undefined): { fromId: string; fromLabel: string; text: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind !== 'agswarm.chat') return null;
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (!text.trim()) return null;
    const fromId = typeof parsed.fromId === 'string' && parsed.fromId.trim() ? parsed.fromId : 'peer';
    const fromLabel = typeof parsed.fromLabel === 'string' && parsed.fromLabel.trim() ? parsed.fromLabel : fromId;
    return { fromId, fromLabel, text };
  } catch {
    return null;
  }
}

export function taskDetail(taskData: SendTaskData): string {
  if (taskData.type === 'Agent') {
    return `Skill: ${taskData.skill || 'safe_default'}\n${taskData.payload}`;
  }
  if (taskData.type === 'File') {
    return taskData.fileName || taskData.payload || 'Uploading file';
  }
  return taskData.payload.substring(0, 160) + (taskData.payload.length > 160 ? '...' : '');
}

export function formatTaskTime(value?: string | null): string {
  if (!value) return 'Just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Just now';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
