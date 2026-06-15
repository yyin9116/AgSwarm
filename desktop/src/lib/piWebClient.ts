import { startPiWeb } from './agswarmApi';
import { isTauri } from '@tauri-apps/api/core';

export const PI_WEB_BASE_URL = 'http://127.0.0.1:8504';
const PI_WEB_LOCAL_API_PREFIX = '/api/machines/local';

export type PiWebSessionInfo = {
  id: string;
  cwd: string;
  path: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  archived?: boolean;
};

export type PiWebMessagePage = {
  messages: unknown[];
  start: number;
  total: number;
};

export type PiWebSessionStatus = {
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  queuedMessages: Array<{ kind: 'steer' | 'followUp'; text: string }>;
  messageCount?: number;
  model?: { provider?: string; id?: string; name?: string };
  thinkingLevel?: string;
  tokens?: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
};

export type PiWebSlashCommand = {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill' | 'builtin';
};

export type PiWebSessionActivity = {
  sessionId: string;
  phase: 'active' | 'idle' | 'error';
  label: string;
  detail?: string;
  at: string;
};

export type PiWebSessionEvent =
  | { type: 'message.append'; message: unknown }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.thinking.delta'; text: string }
  | { type: 'tool.start'; toolName: string; toolCallId: string; summary: string; args?: unknown }
  | { type: 'tool.update'; toolName: string; toolCallId: string; text: string; content?: unknown; details?: unknown }
  | { type: 'tool.end'; toolName: string; toolCallId: string; text: string; isError: boolean; content?: unknown; details?: unknown }
  | { type: 'shell.start'; command: string; excludeFromContext?: boolean }
  | { type: 'shell.chunk'; chunk: string }
  | { type: 'shell.end'; output?: string; exitCode?: number | null; cancelled?: boolean; truncated?: boolean; isError?: boolean }
  | { type: 'agent.start' }
  | { type: 'agent.end' }
  | { type: 'message.end'; message?: unknown }
  | { type: 'status.update'; status: PiWebSessionStatus }
  | { type: 'activity.update'; activity: PiWebSessionActivity }
  | { type: 'command.output'; level: 'info' | 'success' | 'error'; message: string }
  | { type: 'session.error'; message: string }
  | { type: 'session.name'; sessionId: string; name?: string }
  | { type: 'pi.event'; eventType: string };

export async function ensurePiWebReady(): Promise<void> {
  const status = await startPiWeb();
  if (status.ok && status.running) {
    return;
  }
  if (await canReachPiWebRuntime()) {
    return;
  }
  throw new Error(status.message || 'AgSwarm AI runtime did not start.');
}

export async function listPiWebSessions(cwd: string): Promise<PiWebSessionInfo[]> {
  return piWebJson<PiWebSessionInfo[]>(`/sessions?cwd=${encodeURIComponent(cwd)}`);
}

export async function startPiWebSession(cwd: string): Promise<PiWebSessionInfo> {
  return piWebJson<PiWebSessionInfo>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd }),
  });
}

export async function getPiWebMessages(session: PiWebSessionInfo, limit = 100): Promise<PiWebMessagePage> {
  return piWebJson<PiWebMessagePage>(`/sessions/${encodeURIComponent(session.id)}/messages?cwd=${encodeURIComponent(session.cwd)}&limit=${limit}`);
}

export async function getPiWebStatus(session: PiWebSessionInfo): Promise<PiWebSessionStatus> {
  return piWebJson<PiWebSessionStatus>(`/sessions/${encodeURIComponent(session.id)}/status?cwd=${encodeURIComponent(session.cwd)}`);
}

export async function listPiWebCommands(session: PiWebSessionInfo): Promise<PiWebSlashCommand[]> {
  return piWebJson<PiWebSlashCommand[]>(`/sessions/${encodeURIComponent(session.id)}/commands?cwd=${encodeURIComponent(session.cwd)}`);
}

export async function sendPiWebPrompt(session: PiWebSessionInfo, text: string): Promise<void> {
  await piWebJson<{ accepted: true }>(`/sessions/${encodeURIComponent(session.id)}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, text }),
  });
}

export async function runPiWebCommand(session: PiWebSessionInfo, text: string): Promise<unknown> {
  return piWebJson<unknown>(`/sessions/${encodeURIComponent(session.id)}/commands/run`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, text }),
  });
}

export function createPiWebSessionSocket(
  session: PiWebSessionInfo,
  onEvent: (event: PiWebSessionEvent) => void,
  onClose?: () => void,
): WebSocket {
  const socket = new WebSocket(`${piWebSocketBaseUrl()}${PI_WEB_LOCAL_API_PREFIX}/sessions/${encodeURIComponent(session.id)}/events?cwd=${encodeURIComponent(session.cwd)}`);
  socket.onmessage = async event => {
    const parsed = await parsePiWebEvent(event.data);
    if (parsed) onEvent(parsed);
  };
  socket.onclose = () => onClose?.();
  return socket;
}

async function piWebJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${piWebHttpBaseUrl()}${PI_WEB_LOCAL_API_PREFIX}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

async function canReachPiWebRuntime(): Promise<boolean> {
  try {
    const response = await fetch(`${piWebHttpBaseUrl()}${PI_WEB_LOCAL_API_PREFIX}/runtime`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Boolean(payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok !== false);
  } catch {
    return false;
  }
}

function piWebHttpBaseUrl(): string {
  return isTauri() ? PI_WEB_BASE_URL : '';
}

function piWebSocketBaseUrl(): string {
  if (isTauri()) return PI_WEB_BASE_URL.replace(/^http/, 'ws');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

async function parsePiWebEvent(value: unknown): Promise<PiWebSessionEvent | null> {
  try {
    const raw = await webSocketPayloadText(value);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as PiWebSessionEvent;
    }
  } catch {
    return null;
  }
  return null;
}

async function webSocketPayloadText(value: unknown): Promise<unknown> {
  if (typeof value === 'string') return value;
  if (value instanceof Blob) return value.text();
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return value;
}
