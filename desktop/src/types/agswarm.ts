export type TaskType = 'Echo' | 'LaTeX' | 'Agent' | 'File';

export type AgentPlan =
  | {
      intent: 'orchestrate';
      targetDeviceType: string;
      targetDeviceId?: string;
      targetDeviceName?: string;
      taskType: TaskType;
      payload: string;
      title?: string;
      reason?: string;
    }
  | {
      intent: 'reply';
      reply: string;
    };

export type TaskDraft = Extract<AgentPlan, { intent: 'orchestrate' }>;

export type SendTaskData = {
  type: TaskType;
  target?: string;
  payload: string;
  chatEnvelope?: boolean;
  skill?: string;
  file?: File;
  fileName?: string;
  fileSize?: string;
  sourcePath?: string;
};

export type CliCommand =
  | 'node-snapshot'
  | 'discover-nodes'
  | 'pi-commands'
  | 'submit-echo'
  | 'submit-pi'
  | 'submit-latex'
  | 'upload-file'
  | 'peer-ping'
  | 'peer-command';

export type CliResponse<TStdout = unknown> = {
  ok: boolean;
  stdout: TStdout;
  stderr: string;
  exitCode: number;
  argv: string[];
};

export type CliRequest = {
  command: CliCommand;
  natsUrl: string;
  nodeId?: string;
  deviceId?: string;
  text?: string;
  prompt?: string;
  model?: string;
  skills?: string;
  sourcePath?: string;
  sourceText?: string;
  remoteName?: string;
  workspace?: string;
  latexMcpDir?: string;
  mainTex?: string;
  engine?: string;
  outputSubdir?: string;
  peerCommand?: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  waitTimeoutSec?: number;
  streamToken?: string;
};

export type AgentChatRequest = {
  providerUrl: string;
  apiKey?: string;
  model: string;
  messages: Array<Record<string, string>>;
  temperature?: number;
  stream?: boolean;
};

export type AgentChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export type LocalPeerRequest = {
  natsUrl: string;
  nodeId: string;
  deviceLabel?: string;
  deviceTags?: string;
  capabilities?: string;
  enablePi?: boolean;
  piCli?: string;
  piModel?: string;
  piProvider?: string;
  piCwd?: string;
  startNats?: boolean;
};

export type RuntimeConfig = {
  nodeId?: string;
  deviceLabel?: string;
  natsUrl?: string;
  repoRoot?: string;
};

export type FrontendDebugLogRequest = {
  label: string;
  payload: Record<string, unknown>;
};

export type StageChatAttachmentRequest = {
  sourcePath: string;
  workspaceRoot: string;
};

export type SaveChatAttachmentRequest = {
  name: string;
  workspaceRoot: string;
  bytes: number[];
};

export type StagedChatAttachment = {
  name: string;
  sourcePath: string;
  stagedPath: string;
  relativePath: string;
  sizeBytes: number;
  copied: boolean;
};

export type LocalPeerStatus = {
  ok: boolean;
  nodeId?: string;
  natsUrl?: string;
  nodeRunning: boolean;
  natsRunning: boolean;
  natsManaged: boolean;
  message: string;
  nodeExitCode?: number;
  natsExitCode?: number;
};

export type PiWebStatus = {
  ok: boolean;
  running: boolean;
  url: string;
  port: number;
  message: string;
  serverExitCode?: number;
  sessiondExitCode?: number;
};

export type PiCommandInfo = {
  name: string;
  description?: string;
  source: 'builtin' | 'skill' | 'prompt' | 'extension' | 'model';
  value?: string;
};

export type PiCommandsResponse = {
  ok: boolean;
  commands: PiCommandInfo[];
  models: PiCommandInfo[];
  skills: PiCommandInfo[];
  diagnostics?: Array<Record<string, unknown>>;
};

export type DesktopAgentToolName = 'workspace_info' | 'shell' | 'python';

export type DesktopAgentToolRequest = {
  tool: DesktopAgentToolName;
  command?: string;
  script?: string;
  cwd?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
};

export type DesktopAgentToolResponse = {
  ok: boolean;
  tool: DesktopAgentToolName;
  cwd: string;
  command?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
  meta?: Record<string, unknown>;
};

export type PeerNodeDto = {
  host_layer?: unknown;
  transport?: unknown;
  endpoint?: unknown;
  device_id?: unknown;
  device_label?: unknown;
  device_tags?: unknown;
  capabilities?: unknown;
};

export type RecentTaskDto = {
  task_id?: unknown;
  adapter?: unknown;
  status?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  input_text?: unknown;
  user_message?: unknown;
  last_event_type?: unknown;
  result?: unknown;
};

export type NodeSnapshotDto = {
  node_id?: unknown;
  nats_url?: unknown;
  status?: unknown;
  adapters?: unknown;
  queue_depth?: unknown;
  peer_node?: PeerNodeDto;
  recent_tasks?: unknown;
};

export type DiscoverNodesResponse = {
  ok?: boolean;
  count?: number;
  nodes?: NodeSnapshotDto[];
};
