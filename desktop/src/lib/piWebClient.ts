import { startPiWeb } from './agswarmApi';
import { isTauri } from '@tauri-apps/api/core';

export const PI_WEB_BASE_URL = 'http://127.0.0.1:8504';
const PI_WEB_LOCAL_API_PREFIX = '/api/machines/local';
let piWebReadyPromise: Promise<void> | null = null;
const PI_WEB_READY_TIMEOUT_MS = 90_000;
const PI_WEB_READY_POLL_MS = 700;

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

export type PiWebSessionModel = {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: unknown;
};

export type PiWebThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type PiWebCommandOption = {
  value: string;
  label: string;
  description?: string;
};

export type PiWebCommandResult =
  | { type: 'done'; message?: string; session?: PiWebSessionInfo; promptDraft?: string }
  | { type: 'unsupported'; message: string }
  | { type: 'select'; requestId: string; title: string; options: PiWebCommandOption[]; promptDraft?: string };

export type PiWebAuthProviderOption = {
  id: string;
  name: string;
  authType: 'oauth' | 'api_key';
  status: {
    configured: boolean;
    source?: string;
    label?: string;
  };
};

export type PiWebOAuthFlowState = {
  flowId: string;
  providerId: string;
  providerName: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  auth?: { url: string; instructions?: string };
  prompt?: { requestId: string; message: string; placeholder?: string; allowEmpty?: boolean; kind: 'prompt' | 'manual' };
  select?: { requestId: string; message: string; options: PiWebCommandOption[] };
  progress: string[];
  error?: string;
};

export type PiWebProject = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
};

export type PiWebWorkspace = {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitRepo: boolean;
  isGitWorktree: boolean;
};

export type PiWebWorkspaceContext = {
  project: PiWebProject;
  workspace: PiWebWorkspace;
};

export type PiWebFileTreeEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modifiedAt?: string;
};

export type PiWebFileSuggestion = {
  path: string;
  kind: 'tracked' | 'untracked' | 'other';
};

export type PiWebFileTreeResponse = {
  path: string;
  entries: PiWebFileTreeEntry[];
  scannedAt: string;
  truncated: boolean;
};

export type PiWebFileContentResponse = {
  path: string;
  language?: string;
  mediaType?: 'image';
  mimeType?: string;
  encoding: 'utf8';
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
};

export type PiWebGitStatusResponse = {
  isGitRepo: boolean;
  hash: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: Array<{
    path: string;
    oldPath?: string;
    index: string;
    workingTree: string;
  }>;
};

export type PiWebGitDiffResponse = {
  path?: string;
  staged: boolean;
  hash: string;
  diff: string;
  truncated: boolean;
};

export type PiWebTerminalInfo = {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
  commandRunId?: string;
};

export type PiWebTerminalCommandRun = {
  id: string;
  origin: string;
  projectId: string;
  workspaceId: string;
  terminalId: string;
  title: string;
  command: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  exitCode?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, string>;
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
  if (piWebReadyPromise) return piWebReadyPromise;
  piWebReadyPromise = ensurePiWebReadyOnce().catch(error => {
    piWebReadyPromise = null;
    throw error;
  });
  return piWebReadyPromise;
}

async function ensurePiWebReadyOnce(): Promise<void> {
  if (await canReachPiWebRuntime()) {
    return;
  }
  const status = await startPiWeb();
  if ((status.ok && status.running) || await waitForPiWebRuntime(PI_WEB_READY_TIMEOUT_MS)) {
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

export async function listPiWebModels(session: PiWebSessionInfo): Promise<PiWebSessionModel[]> {
  const response = await piWebJson<{ models: PiWebSessionModel[] }>(`/sessions/${encodeURIComponent(session.id)}/models?cwd=${encodeURIComponent(session.cwd)}`);
  return response.models;
}

export async function setPiWebModel(session: PiWebSessionInfo, provider: string, modelId: string): Promise<PiWebSessionStatus> {
  return piWebJson<PiWebSessionStatus>(`/sessions/${encodeURIComponent(session.id)}/model`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, provider, modelId }),
  });
}

export async function listPiWebThinkingLevels(session: PiWebSessionInfo): Promise<PiWebThinkingLevel[]> {
  const response = await piWebJson<{ levels: PiWebThinkingLevel[] }>(`/sessions/${encodeURIComponent(session.id)}/thinking-levels?cwd=${encodeURIComponent(session.cwd)}`);
  return response.levels;
}

export async function setPiWebThinkingLevel(session: PiWebSessionInfo, level: PiWebThinkingLevel): Promise<PiWebSessionStatus> {
  return piWebJson<PiWebSessionStatus>(`/sessions/${encodeURIComponent(session.id)}/thinking-level`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, level }),
  });
}

export async function sendPiWebPrompt(session: PiWebSessionInfo, text: string, streamingBehavior?: 'steer' | 'followUp'): Promise<void> {
  await piWebJson<{ accepted: true }>(`/sessions/${encodeURIComponent(session.id)}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, text, ...(streamingBehavior ? { streamingBehavior } : {}) }),
  });
}

export async function sendPiWebShellInput(session: PiWebSessionInfo, text: string): Promise<void> {
  await piWebJson<{ accepted: true }>(`/sessions/${encodeURIComponent(session.id)}/shell`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, text }),
  });
}

export async function abortPiWebSession(session: PiWebSessionInfo): Promise<void> {
  await piWebJson<{ aborted: true }>(`/sessions/${encodeURIComponent(session.id)}/abort`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd }),
  });
}

export async function runPiWebCommand(session: PiWebSessionInfo, text: string): Promise<PiWebCommandResult> {
  return piWebJson<PiWebCommandResult>(`/sessions/${encodeURIComponent(session.id)}/commands/run`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, text }),
  });
}

export async function respondToPiWebCommand(session: PiWebSessionInfo, requestId: string, value: string): Promise<PiWebCommandResult> {
  return piWebJson<PiWebCommandResult>(`/sessions/${encodeURIComponent(session.id)}/commands/respond`, {
    method: 'POST',
    body: JSON.stringify({ cwd: session.cwd, requestId, value }),
  });
}

export async function listPiWebAuthProviders(mode: 'login' | 'logout' = 'login', authType?: 'oauth' | 'api_key'): Promise<PiWebAuthProviderOption[]> {
  const params = new URLSearchParams({ mode });
  if (authType) params.set('authType', authType);
  const response = await piWebJson<{ providers: PiWebAuthProviderOption[] }>(`/auth/providers?${params.toString()}`);
  return response.providers;
}

export async function savePiWebApiKey(providerId: string, key: string): Promise<unknown> {
  return piWebJson<unknown>('/auth/api-key', {
    method: 'POST',
    body: JSON.stringify({ providerId, key }),
  });
}

export async function logoutPiWebProvider(providerId: string): Promise<unknown> {
  return piWebJson<unknown>('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ providerId }),
  });
}

export async function startPiWebOAuth(providerId: string): Promise<PiWebOAuthFlowState> {
  return piWebJson<PiWebOAuthFlowState>('/auth/oauth', {
    method: 'POST',
    body: JSON.stringify({ providerId }),
  });
}

export async function getPiWebOAuthFlow(flowId: string): Promise<PiWebOAuthFlowState> {
  return piWebJson<PiWebOAuthFlowState>(`/auth/oauth/${encodeURIComponent(flowId)}`);
}

export async function respondPiWebOAuth(flowId: string, requestId: string, value: string): Promise<PiWebOAuthFlowState> {
  return piWebJson<PiWebOAuthFlowState>(`/auth/oauth/${encodeURIComponent(flowId)}/respond`, {
    method: 'POST',
    body: JSON.stringify({ requestId, value }),
  });
}

export async function cancelPiWebOAuth(flowId: string): Promise<PiWebOAuthFlowState> {
  return piWebJson<PiWebOAuthFlowState>(`/auth/oauth/${encodeURIComponent(flowId)}/cancel`, { method: 'POST' });
}

export async function listPiWebProjects(): Promise<PiWebProject[]> {
  return piWebJson<PiWebProject[]>('/projects');
}

export async function addPiWebProject(path: string, name?: string): Promise<PiWebProject> {
  return piWebJson<PiWebProject>('/projects', {
    method: 'POST',
    body: JSON.stringify({ path, ...(name ? { name } : {}) }),
  });
}

export async function listPiWebWorkspaces(projectId: string): Promise<PiWebWorkspace[]> {
  return piWebJson<PiWebWorkspace[]>(`/projects/${encodeURIComponent(projectId)}/workspaces`);
}

export async function resolvePiWebWorkspace(cwd: string): Promise<PiWebWorkspaceContext> {
  const projects = await listPiWebProjects();
  let project = projects.find(item => normalizePathForCompare(item.path) === normalizePathForCompare(cwd));
  if (!project) {
    project = await addPiWebProject(cwd);
  }
  const workspaces = await listPiWebWorkspaces(project.id);
  const workspace = workspaces.find(item => normalizePathForCompare(item.path) === normalizePathForCompare(cwd))
    || workspaces.find(item => item.isMain)
    || workspaces[0];
  if (!workspace) throw new Error(`No PI WEB workspace found for ${cwd}`);
  return { project, workspace };
}

export async function getPiWebFileTree(context: PiWebWorkspaceContext, path = ''): Promise<PiWebFileTreeResponse> {
  return piWebJson<PiWebFileTreeResponse>(workspacePath(context, `/tree?path=${encodeURIComponent(path)}`));
}

export async function readPiWebFile(context: PiWebWorkspaceContext, path: string): Promise<PiWebFileContentResponse> {
  return piWebJson<PiWebFileContentResponse>(workspacePath(context, `/file?path=${encodeURIComponent(path)}`));
}

export async function listPiWebFileSuggestions(
  cwd: string,
  query: string,
  options: { kind?: PiWebFileSuggestion['kind']; scope?: 'tracked' | 'all' } = {},
): Promise<PiWebFileSuggestion[]> {
  const params = new URLSearchParams({ cwd, q: query });
  if (options.kind) params.set('kind', options.kind);
  if (options.scope) params.set('scope', options.scope);
  return piWebJson<PiWebFileSuggestion[]>(`/files?${params.toString()}`);
}

export async function getPiWebGitStatus(context: PiWebWorkspaceContext): Promise<PiWebGitStatusResponse> {
  return piWebJson<PiWebGitStatusResponse>(workspacePath(context, '/git/status'));
}

export async function getPiWebGitDiff(context: PiWebWorkspaceContext, path?: string, staged = false): Promise<PiWebGitDiffResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (staged) params.set('staged', 'true');
  const query = params.toString();
  return piWebJson<PiWebGitDiffResponse>(workspacePath(context, `/git/diff${query ? `?${query}` : ''}`));
}

export async function listPiWebTerminals(context: PiWebWorkspaceContext): Promise<PiWebTerminalInfo[]> {
  return piWebJson<PiWebTerminalInfo[]>(workspacePath(context, '/terminals'));
}

export async function createPiWebTerminal(context: PiWebWorkspaceContext, name?: string): Promise<PiWebTerminalInfo> {
  return piWebJson<PiWebTerminalInfo>(workspacePath(context, '/terminals'), {
    method: 'POST',
    body: JSON.stringify({ ...(name ? { name } : {}) }),
  });
}

export async function runPiWebTerminalCommand(
  context: PiWebWorkspaceContext,
  input: { title: string; command: string; metadata?: Record<string, string>; origin?: string },
): Promise<PiWebTerminalCommandRun> {
  return piWebJson<PiWebTerminalCommandRun>(workspacePath(context, '/terminal-command-runs'), {
    method: 'POST',
    body: JSON.stringify({
      origin: input.origin || 'agswarm-chat',
      title: input.title,
      command: input.command,
      metadata: input.metadata || {},
    }),
  });
}

export async function getPiWebTerminalCommandRun(runId: string): Promise<PiWebTerminalCommandRun> {
  return piWebJson<PiWebTerminalCommandRun>(`/terminal-command-runs/${encodeURIComponent(runId)}`);
}

export async function cancelPiWebTerminalCommandRun(runId: string): Promise<PiWebTerminalCommandRun> {
  return piWebJson<PiWebTerminalCommandRun>(`/terminal-command-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
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

async function waitForPiWebRuntime(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachPiWebRuntime()) return true;
    await delay(PI_WEB_READY_POLL_MS);
  }
  return false;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, timeoutMs));
}

function piWebHttpBaseUrl(): string {
  return isTauri() ? PI_WEB_BASE_URL : '';
}

function piWebSocketBaseUrl(): string {
  if (isTauri()) return PI_WEB_BASE_URL.replace(/^http/, 'ws');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function workspacePath(context: PiWebWorkspaceContext, suffix: string): string {
  return `/projects/${encodeURIComponent(context.project.id)}/workspaces/${encodeURIComponent(context.workspace.id)}${suffix}`;
}

function normalizePathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '');
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
