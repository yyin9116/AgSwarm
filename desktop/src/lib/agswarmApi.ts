import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentProviderTestResult,
  CliRequest,
  CliResponse,
  DesktopAgentToolRequest,
  DesktopAgentToolResponse,
  FrontendDebugLogRequest,
  LocalPeerRequest,
  LocalPeerStatus,
  PiCommandsResponse,
  PiWebStatus,
  RuntimeConfig,
  SaveChatAttachmentRequest,
  StageChatAttachmentRequest,
  StagedChatAttachment,
} from '../types/agswarm';

const hasTauriRuntime = () => isTauri();
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const PREVIEW_PROVIDER_URL = viteEnv.VITE_AGENT_PROVIDER_URL || 'http://127.0.0.1:15721';
const PREVIEW_PROVIDER_PROXY_URL = '/__agswarm_provider';
const PREVIEW_PROVIDER_API_KEY = viteEnv.VITE_AGENT_API_KEY || 'local-dev-key';
const PREVIEW_PROVIDER_MODEL = viteEnv.VITE_AGENT_MODEL || 'gpt-5.5';

let previewPeerRequest: Pick<LocalPeerRequest, 'nodeId' | 'natsUrl' | 'deviceLabel'> = {
  nodeId: 'preview-node',
  natsUrl: 'nats://127.0.0.1:4222',
};

export async function runAgSwarmCli<TStdout = unknown>(request: CliRequest): Promise<CliResponse<TStdout>> {
  if (!hasTauriRuntime()) {
    return mockCliResponse<TStdout>(request);
  }
  return invoke<CliResponse<TStdout>>('agswarm_cli', { request });
}

export async function runAgSwarmCliWithPiStream<TStdout = unknown>(
  request: CliRequest,
  onStreamEvent: (event: PiStreamEvent) => void,
): Promise<CliResponse<TStdout>> {
  if (!hasTauriRuntime()) {
    return mockCliResponse<TStdout>(request, onStreamEvent);
  }
  const streamToken = request.streamToken || crypto.randomUUID();
  await writeFrontendDebugLog({
    label: 'pi-stream-listen-start',
    payload: { streamToken, command: request.command, nodeId: request.nodeId },
  }).catch(() => undefined);

  let unlisten: (() => void) | null = null;
  let listenSettled = false;
  const listenPromise = listen<PiStreamPayload>('agswarm-pi-stream', event => {
    if (event.payload?.streamToken !== streamToken) return;
    if (event.payload.kind === 'event') {
      onStreamEvent(event.payload.payload as PiStreamEvent);
    }
  }).then(unlistenFn => {
    listenSettled = true;
    unlisten = unlistenFn;
    void writeFrontendDebugLog({
      label: 'pi-stream-listen-ready',
      payload: { streamToken, command: request.command, nodeId: request.nodeId },
    }).catch(() => undefined);
  }).catch(error => {
    listenSettled = true;
    void writeFrontendDebugLog({
      label: 'pi-stream-listen-error',
      payload: {
        streamToken,
        command: request.command,
        nodeId: request.nodeId,
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
  });

  await Promise.race([listenPromise, delay(180)]);
  if (!listenSettled) {
    await writeFrontendDebugLog({
      label: 'pi-stream-listen-deferred',
      payload: {
        streamToken,
        command: request.command,
        nodeId: request.nodeId,
      },
    }).catch(() => undefined);
  }

  try {
    await writeFrontendDebugLog({
      label: 'pi-stream-invoke-start',
      payload: { streamToken, command: request.command, nodeId: request.nodeId },
    }).catch(() => undefined);
    return await invoke<CliResponse<TStdout>>('agswarm_cli', {
      request: {
        ...request,
        streamToken,
      },
    });
  } finally {
    unlisten?.();
  }
}

export async function runAgentProviderChat(request: AgentChatRequest): Promise<AgentChatResponse> {
  if (!hasTauriRuntime()) {
    return requestPreviewProviderChat(request);
  }
  return invoke<AgentChatResponse>('agent_provider_chat', { request });
}

export async function testAgentProvider(request: AgentChatRequest): Promise<AgentProviderTestResult> {
  if (!hasTauriRuntime()) {
    return {
      ok: true,
      category: 'ok',
      message: 'Preview mode can reach the configured model service proxy.',
      model: request.model,
      providerUrl: request.providerUrl,
      durationMs: 0,
    };
  }
  return invoke<AgentProviderTestResult>('test_agent_provider', { request });
}

export type PiStreamEvent = {
  type?: string;
  payload?: Record<string, unknown>;
  task_id?: string;
  ts?: string;
};

type PiStreamPayload = {
  streamToken?: string;
  kind?: string;
  payload?: unknown;
};

function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, timeoutMs);
  });
}

export async function streamAgentProviderChat(
  request: AgentChatRequest,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = previewProviderEndpoint(request.providerUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey || PREVIEW_PROVIDER_API_KEY}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.5,
      stream: true,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`provider returned ${response.status}`);
  }
  if (!response.body) {
    const payload = await response.json();
    const text = String(payload?.choices?.[0]?.message?.content || '');
    if (text) onDelta(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const delta = parseProviderStreamLine(line);
      if (!delta) continue;
      fullText += delta;
      onDelta(delta);
    }
  }
  return fullText;
}

export async function runDesktopAgentTool(request: DesktopAgentToolRequest): Promise<DesktopAgentToolResponse> {
  if (!hasTauriRuntime()) {
    return requestPreviewDesktopTool(request);
  }
  return invoke<DesktopAgentToolResponse>('desktop_agent_tool', { request });
}

function parseProviderStreamLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return '';
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const payload = JSON.parse(data);
    return String(payload?.choices?.[0]?.delta?.content || payload?.choices?.[0]?.message?.content || '');
  } catch {
    return '';
  }
}

export async function startLocalPeer(request: LocalPeerRequest): Promise<LocalPeerStatus> {
  if (!hasTauriRuntime()) {
    previewPeerRequest = request;
    return mockLocalPeerStatus(request);
  }
  return invoke<LocalPeerStatus>('start_local_peer', { request });
}

export async function getLocalPeerStatus(): Promise<LocalPeerStatus> {
  if (!hasTauriRuntime()) {
    return mockLocalPeerStatus(previewPeerRequest);
  }
  return invoke<LocalPeerStatus>('local_peer_status');
}

export async function startPiWeb(): Promise<PiWebStatus> {
  if (!hasTauriRuntime()) {
    return {
      ok: false,
      running: false,
      url: 'http://127.0.0.1:8504',
      port: 8504,
      message: 'AgSwarm AI runtime is only started by the desktop app.',
    };
  }
  return invoke<PiWebStatus>('start_pi_web');
}

export async function getPiWebStatus(): Promise<PiWebStatus> {
  if (!hasTauriRuntime()) {
    return {
      ok: false,
      running: false,
      url: 'http://127.0.0.1:8504',
      port: 8504,
      message: 'AgSwarm AI runtime status is only available in the desktop app.',
    };
  }
  return invoke<PiWebStatus>('pi_web_status');
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (!hasTauriRuntime()) {
    return {};
  }
  return invoke<RuntimeConfig>('runtime_config');
}

export async function getSystemDeviceName(): Promise<string> {
  if (!hasTauriRuntime()) {
    return 'Preview Workstation';
  }
  return invoke<string>('system_device_name');
}

export async function getPiCommands(request: {
  natsUrl: string;
  skills?: string;
  workspace?: string;
}): Promise<PiCommandsResponse> {
  const response = await runAgSwarmCli<PiCommandsResponse>({
    command: 'pi-commands',
    natsUrl: request.natsUrl,
    skills: request.skills,
    workspace: request.workspace,
    waitTimeoutSec: 2,
  });
  if (!response.ok) {
    throw new Error(response.stderr || 'failed to load AgSwarm AI commands');
  }
  return response.stdout;
}

export async function writeFrontendDebugLog(request: FrontendDebugLogRequest): Promise<void> {
  if (!hasTauriRuntime()) {
    console.info('[agswarm:frontend-debug]', request.label, request.payload);
    return;
  }
  await invoke<void>('frontend_debug_log', { request });
}

export async function stageChatAttachment(request: StageChatAttachmentRequest): Promise<StagedChatAttachment> {
  if (!hasTauriRuntime()) {
    const name = request.sourcePath.split(/[\\/]/).filter(Boolean).pop() || 'attachment';
    return {
      name,
      sourcePath: request.sourcePath,
      stagedPath: request.sourcePath,
      relativePath: name,
      sizeBytes: 0,
      copied: false,
    };
  }
  return invoke<StagedChatAttachment>('stage_chat_attachment', { request });
}

export async function saveChatAttachment(request: SaveChatAttachmentRequest): Promise<StagedChatAttachment> {
  if (!hasTauriRuntime()) {
    return {
      name: request.name,
      sourcePath: request.name,
      stagedPath: request.name,
      relativePath: request.name,
      sizeBytes: request.bytes.length,
      copied: true,
    };
  }
  return invoke<StagedChatAttachment>('save_chat_attachment', { request });
}

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    // Vite browser previews do not have a Tauri window object.
  }
}

function mockLocalPeerStatus(request: Pick<LocalPeerRequest, 'nodeId' | 'natsUrl'>): LocalPeerStatus {
  return {
    ok: true,
    nodeId: request.nodeId,
    natsUrl: request.natsUrl,
    nodeRunning: true,
    natsRunning: true,
    natsManaged: false,
    message: 'Preview runtime is using mock device data.',
  };
}

async function mockCliResponse<TStdout>(
  request: CliRequest,
  onStreamEvent?: (event: PiStreamEvent) => void,
): Promise<CliResponse<TStdout>> {
  const previewNodeId = request.nodeId || previewPeerRequest.nodeId || 'preview-node';
  const selfNode = {
    node_id: previewNodeId,
    status: 'idle',
    adapters: ['echo', 'latex_mcp', 'pi'],
    queue_depth: 0,
    peer_node: {
      endpoint: request.natsUrl,
      device_id: previewNodeId,
      device_label: previewPeerRequest.deviceLabel || 'Preview Workstation',
      capabilities: ['echo-client', 'interactive-file-stream', 'pi-agent'],
    },
    recent_tasks: [],
  };
  const peerNode = {
    node_id: 'studio-agent',
    status: 'idle',
    adapters: ['echo'],
    queue_depth: 0,
    peer_node: {
      endpoint: request.natsUrl,
      device_id: 'studio-agent',
      device_label: 'Studio Agent',
      capabilities: ['echo-client', 'interactive-file-stream'],
    },
    recent_tasks: [],
  };
  const isPiPreview = request.command === 'submit-pi';
  const piOutput = isPiPreview ? browserPreviewPiUnavailable(request, onStreamEvent) : '';
  const stdout = request.command === 'discover-nodes'
    ? { ok: true, count: 2, nodes: [selfNode, peerNode] }
    : request.command === 'node-snapshot'
      ? selfNode
      : request.command === 'pi-commands'
        ? {
            ok: true,
            commands: [
              { name: '/model', value: '/model ', description: 'Select model', source: 'builtin' },
              { name: '/skill:frontend-ui-engineering', value: '/skill:frontend-ui-engineering ', description: 'Use frontend UI engineering skill', source: 'skill' },
              { name: '/new', value: '/new', description: 'Start a new pi session', source: 'builtin' },
            ],
            models: [
              { name: '/model local-openai/gpt-5.5', value: '/model local-openai/gpt-5.5', description: 'Preview model', source: 'model' },
            ],
            skills: [],
            diagnostics: [],
          }
      : isPiPreview
        ? {
            ok: true,
            status: 'unavailable',
            assistant_text: piOutput,
            events: [
              {
                type: 'agent.end',
                payload: {
                  messages: [
                    { role: 'user', content: request.prompt || request.text || '' },
                    { role: 'assistant', content: piOutput },
                  ],
                },
              },
              {
                type: 'adapter.error',
                payload: { message: piOutput },
              },
            ],
            result: {
              output: piOutput,
            },
          }
      : { ok: true, status: 'succeeded', result: { output: 'Preview command completed.' } };

  return {
    ok: true,
    stdout: stdout as TStdout,
    stderr: '',
    exitCode: 0,
    argv: [request.command],
  };
}

function browserPreviewPiUnavailable(
  request: CliRequest,
  onStreamEvent?: (event: PiStreamEvent) => void,
): string {
  const nodeId = request.nodeId || 'preview-node';
  const message = [
    '当前是在浏览器预览里打开聊天页，不能调用桌面 Tauri 的 submit-pi IPC。',
    `为避免绕过 AgSwarm AI，预览模式不会直连模型服务生成回复。`,
    `请在 AgSwarm Client 桌面应用中发送消息；桌面运行时会把请求提交到 ${nodeId} 的 PiAdapter。`,
  ].join('\n');
  onStreamEvent?.({
    type: 'adapter.error',
    payload: { message },
  });
  return message;
}

async function requestPreviewProviderChat(request: AgentChatRequest): Promise<AgentChatResponse> {
  const endpoint = previewProviderEndpoint(request.providerUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey || PREVIEW_PROVIDER_API_KEY}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.5,
    }),
  });
  if (!response.ok) {
    throw new Error(`provider returned ${response.status}`);
  }
  return response.json();
}

async function requestPreviewDesktopTool(request: DesktopAgentToolRequest): Promise<DesktopAgentToolResponse> {
  const response = await fetch('/__agswarm_desktop_tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || `desktop tool returned ${response.status}`);
  }
  return payload as DesktopAgentToolResponse;
}

function previewProviderEndpoint(providerUrl: string): string {
  try {
    const parsed = new URL(providerUrl);
    const localProvider = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    const base = localProvider ? PREVIEW_PROVIDER_PROXY_URL : providerUrl.replace(/\/$/, '');
    return `${base}/v1/chat/completions`;
  } catch {
    return `${PREVIEW_PROVIDER_PROXY_URL}/v1/chat/completions`;
  }
}
