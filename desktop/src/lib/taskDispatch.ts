import { runAgSwarmCli, runAgSwarmCliWithPiStream } from './agswarmApi';
import type { CliResponse, SendTaskData } from '../types/agswarm';

export interface RunTaskCommandInput {
  taskData: SendTaskData;
  target: string;
  natsUrl: string;
  model: string;
  latexMcpDir: string;
  sourceNodeId: string;
  sourceDeviceLabel: string;
}

export async function runTaskCommand({
  taskData,
  target,
  natsUrl,
  model,
  latexMcpDir,
  sourceNodeId,
  sourceDeviceLabel,
}: RunTaskCommandInput): Promise<CliResponse> {
  if (taskData.type === 'Echo') {
    return runAgSwarmCli({
      command: 'submit-echo',
      natsUrl,
      nodeId: target,
      text: taskData.chatEnvelope
        ? JSON.stringify({
            kind: 'agswarm.chat',
            fromId: sourceNodeId,
            fromLabel: sourceDeviceLabel || sourceNodeId,
            text: taskData.payload,
          })
        : taskData.payload,
      skills: taskData.skill,
      waitTimeoutSec: 20,
    });
  }

  if (taskData.type === 'Agent') {
    return runAgSwarmCliWithPiStream({
      command: 'submit-pi',
      natsUrl,
      nodeId: target,
      model,
      prompt: taskData.payload,
      skills: taskData.skill || 'safe_default',
      timeoutMs: 120_000,
      waitTimeoutSec: 60,
      streamToken: `pi-stream-${crypto.randomUUID()}`,
    }, () => undefined);
  }

  if (taskData.type === 'LaTeX') {
    const sourcePath = taskData.sourcePath || getFilePath(taskData.file);
    if (!latexMcpDir.trim()) {
      throw new Error('LaTeX MCP directory is required in Settings before dispatching LaTeX tasks.');
    }
    return runAgSwarmCli({
      command: 'submit-latex',
      natsUrl,
      nodeId: target,
      sourcePath,
      sourceText: sourcePath ? undefined : taskData.payload,
      workspace: sourcePath ? dirname(sourcePath) : undefined,
      latexMcpDir,
      mainTex: sourcePath ? basename(sourcePath) : undefined,
      skills: taskData.skill,
      timeoutMs: 600_000,
      waitTimeoutSec: 900,
    });
  }

  if (taskData.type === 'File') {
    const sourcePath = taskData.sourcePath || getFilePath(taskData.file);
    if (!sourcePath) {
      throw new Error('The selected file did not expose a local path to Tauri; choose a file from the desktop app file picker.');
    }
    return runAgSwarmCli({
      command: 'upload-file',
      natsUrl,
      nodeId: target,
      sourcePath,
      remoteName: taskData.fileName,
    });
  }

  return assertNever(taskData.type);
}

export function summarizeCliResult(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (record.status) {
      const output = resultOutput(record.result);
      return `${String(record.status)}${output ? `: ${output}` : ''}`;
    }
    if (record.ok === false) {
      return typeof record.error === 'string' ? record.error : 'Command failed';
    }
    if (record.result) {
      return typeof record.result === 'string' ? record.result : JSON.stringify(record.result);
    }
  }
  return JSON.stringify(payload);
}

function resultOutput(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const output = (value as Record<string, unknown>).output;
  return typeof output === 'string' ? output : '';
}

function getFilePath(file?: File): string | undefined {
  const path = file ? (file as unknown as { path?: string; webkitRelativePath?: string }).path : undefined;
  if (path && path.startsWith('/')) {
    return path;
  }
  return undefined;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function dirname(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function assertNever(value: never): never {
  throw new Error(`Unsupported task type: ${String(value)}`);
}
