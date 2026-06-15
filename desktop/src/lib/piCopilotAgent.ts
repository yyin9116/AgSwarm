import { AbstractAgent, EventType } from '@ag-ui/client';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/client';
import { Observable } from 'rxjs';
import { runAgSwarmCliWithPiStream, writeFrontendDebugLog } from './agswarmApi';
import type { PiStreamEvent } from './agswarmApi';
import { normalizeMarkdownContent } from './markdownNormalize';
import { collapseRepeatedText, normalizeForRepeat } from './textDedupe';
import type { Device } from '../components/DevicesView';
import type { CliResponse, SendTaskData } from '../types/agswarm';

export interface PiCopilotAgentConfig {
  agentId?: string;
  natsUrl: string;
  nodeId: string;
  model: string;
  skills?: string;
  getDevices: () => Device[];
  localNodeId: string;
  localDeviceLabel: string;
  latexMcpDir: string;
  piCwd: string;
  dispatchTask: (taskData: SendTaskData, options?: { targetDeviceName?: string }) => Promise<CliResponse>;
}

export class PiCopilotAgent extends AbstractAgent {
  private config: PiCopilotAgentConfig;

  constructor(config: PiCopilotAgentConfig, initialMessages?: Message[]) {
    super({
      agentId: config.agentId || 'pi',
      description: 'AgSwarm AgSwarm AI',
      initialMessages,
    });
    this.config = config;
  }

  clone(): PiCopilotAgent {
    return new PiCopilotAgent(this.config, [...this.messages]);
  }

  updateConfig(config: PiCopilotAgentConfig) {
    this.config = config;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      const abortController = new AbortController();
      const runId = input.runId || crypto.randomUUID();
      const threadId = input.threadId || this.threadId || 'agswarm-pi-thread';
      const messageId = `pi-${crypto.randomUUID()}`;
      const activityMessageId = `pi-activity-${crypto.randomUUID()}`;
      const reasoningMessageId = `reasoning-${crypto.randomUUID()}`;
      let emittedAssistantText = '';

      const emit = (event: BaseEvent) => {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT && event.messageId === messageId) {
          emittedAssistantText += event.delta;
        }
        subscriber.next(event);
      };

      emit({
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        input: {
          ...input,
          threadId,
          runId,
        },
      });
      const trace: AgentTraceEmitter = {
        runId,
        threadId,
        activityMessageId,
        messageId,
        reasoningMessageId,
        emit,
        signal: abortController.signal,
        assistantStarted: false,
        reasoningStarted: false,
        streamedReasoning: false,
        emittedToolCallIds: new Set<string>(),
        emittedToolResultIds: new Set<string>(),
        pendingToolCallNames: new Map<string, string>(),
        openToolCallIds: new Set<string>(),
        closedToolCallIds: new Set<string>(),
        completedToolCounts: new Map<string, number>(),
        lastToolCallId: undefined,
        textPhase: 'unknown',
        pendingTextBuffer: '',
      };

      const prompt = latestUserText(input.messages || this.messages);
      void writeFrontendDebugLog({
        label: 'pi-agent-run',
        payload: {
          runId,
          threadId,
          messageCount: (input.messages || this.messages).length,
          promptPreview: prompt.slice(0, 240),
          targetNodeId: this.config.nodeId,
        },
      }).catch(() => undefined);

      this.runPiTurn(prompt, trace)
        .then(async turn => {
          if (abortController.signal.aborted) return;
          flushPendingTextBuffer(trace, 'reasoning');
          endReasoningIfOpen(trace);
          if (turn.status === 'failed') {
            emitActivitySnapshot(emit, activityMessageId, {
              title: 'AgSwarm AI',
              status: 'error',
              stage: 'error',
              detail: turn.text || 'AgSwarm AI command failed.',
            });
          }
          if (turn.text.trim() && normalizeForRepeat(turn.text) !== normalizeForRepeat(emittedAssistantText)) {
            await emitTextDeltas({
              text: stripAlreadyEmittedText(turn.text, emittedAssistantText),
              trace,
              signal: abortController.signal,
            });
          } else if (!emittedAssistantText.trim()) {
            await emitTextDeltas({
              text: normalizeMarkdownContent('AgSwarm AI finished without a text result.'),
              trace,
              signal: abortController.signal,
            });
          }
          if (abortController.signal.aborted) return;
          closeOpenToolCalls(trace);
          endAssistantIfOpen(trace);
          emit({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            result: turn,
          });
          streamedAssistantTextByMessage.delete(messageId);
          subscriber.complete();
        })
        .catch(error => {
          if (abortController.signal.aborted) return;
          flushPendingTextBuffer(trace, 'reasoning');
          endReasoningIfOpen(trace);
          closeOpenToolCalls(trace);
          endAssistantIfOpen(trace);
          emit({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : String(error),
            code: 'agswarm_pi_error',
          });
          streamedAssistantTextByMessage.delete(messageId);
          subscriber.error(error);
        });

      return () => {
        flushPendingTextBuffer(trace, 'reasoning');
        endReasoningIfOpen(trace);
        closeOpenToolCalls(trace);
        endAssistantIfOpen(trace);
        streamedAssistantTextByMessage.delete(messageId);
        abortController.abort();
      };
    });
  }

  private async runPiTurn(prompt: string, trace: AgentTraceEmitter): Promise<PiTurnResult> {
    const mentionTarget = resolveMentionTarget(prompt, this.config.getDevices(), this.config.localNodeId);
    const routedPrompt = mentionTarget ? stripMention(prompt, mentionTarget) : prompt;
    const targetNodeId = mentionTarget?.id || this.config.nodeId;
    const targetLabel = mentionTarget?.name || targetNodeId;

    const response = await runAgSwarmCliWithPiStream({
      command: 'submit-pi',
      natsUrl: this.config.natsUrl,
      nodeId: targetNodeId,
      model: this.config.model,
      prompt: routedPrompt,
      skills: this.config.skills || 'safe_default',
      timeoutMs: 120_000,
      waitTimeoutSec: 60,
      streamToken: `pi-stream-${crypto.randomUUID()}`,
    }, event => {
      emitPiStreamEvent(trace, event);
    });
    emitPiResponseTrace(trace, response);
    return {
      text: summarizePiResponse(response),
      toolCount: countPiToolEvents(response),
      status: piResponseStatus(response),
      streamed: false,
    };
  }
}

type AgentTraceEmitter = {
  runId: string;
  threadId: string;
  activityMessageId: string;
  messageId: string;
  reasoningMessageId: string;
  emit: (event: BaseEvent) => void;
  signal: AbortSignal;
  assistantStarted: boolean;
  reasoningStarted: boolean;
  streamedReasoning: boolean;
  emittedToolCallIds: Set<string>;
  emittedToolResultIds: Set<string>;
  pendingToolCallNames: Map<string, string>;
  openToolCallIds: Set<string>;
  closedToolCallIds: Set<string>;
  completedToolCounts: Map<string, number>;
  lastToolCallId?: string;
  textPhase: 'unknown' | 'reasoning' | 'answer';
  pendingTextBuffer: string;
};

const streamedAssistantTextByMessage = new Map<string, string>();

type PiTurnResult = {
  text: string;
  toolCount: number;
  status: 'succeeded' | 'failed';
  streamed?: boolean;
};

function emitPiStreamEvent(trace: AgentTraceEmitter, event: PiStreamEvent) {
  if (trace.signal.aborted) return;
  const type = String(event?.type || '');
  const payload = event?.payload || {};
  if (type === 'agent.token') {
    const thinking = textFromEventPayload(payload.thinking);
    if (thinking) {
      emitReasoningDelta(trace, thinking);
    }
    const toolCall = payload.tool_call;
    const text = shouldRenderTokenText(payload, thinking)
      ? tokenTextFromEventPayload(payload.text)
      : '';
    if (text) {
      emitPhasedTextToken(trace, text, payload.phase);
    }
    if (shouldEmitTokenToolCall(toolCall)) {
      emitToolCall(trace, toolCall);
    }
    return;
  }
  if (type === 'agent.turn_start') {
    return;
  }
  if (type === 'agent.message_start') {
    flushPendingTextBuffer(trace, 'reasoning');
    trace.textPhase = 'reasoning';
    trace.pendingTextBuffer = '';
    return;
  }
  if (type === 'agent.message_end') {
    flushPendingTextBuffer(trace, 'reasoning');
    trace.textPhase = 'unknown';
    return;
  }
  if (type === 'agent.tool_start') {
    flushPendingTextBuffer(trace, 'reasoning');
    if (!normalizeToolName(payload.tool)) return;
    emitToolCall(trace, {
      id: stableToolExecutionId(payload),
      name: normalizeToolName(payload.tool) || 'pi.tool',
      arguments: payload.params || {},
    });
    return;
  }
  if (type === 'agent.tool_update') {
    return;
  }
  if (type === 'agent.tool_end') {
    const toolCallId = stableToolExecutionId(payload) || trace.lastToolCallId || stableToolCallId(payload);
    emitToolResult(trace, {
      toolCallId,
      toolName: trace.pendingToolCallNames.get(toolCallId) || normalizeToolName(payload.tool) || 'pi.tool',
      content: payload.result || payload.output || '工具调用完成。',
    });
    return;
  }
  if (type === 'adapter.completed') {
    return;
  }
  if (type === 'adapter.error') {
    traceActivity(trace, 'error', textFromEventPayload(payload.message) || 'pi reported an adapter error.');
  }
}

function emitPhasedTextToken(trace: AgentTraceEmitter, text: string, phase: unknown) {
  const normalizedPhase = typeof phase === 'string' ? phase : '';
  if (normalizedPhase === 'final_answer') {
    flushPendingTextBuffer(trace, 'reasoning');
    trace.textPhase = 'answer';
    emitAssistantDelta(trace, text);
    return;
  }
  if (normalizedPhase === 'commentary' || normalizedPhase === 'reasoning') {
    trace.textPhase = 'reasoning';
    emitReasoningDelta(trace, text);
    return;
  }
  emitClassifiedTextToken(trace, text);
}

function emitPiResponseTrace(trace: AgentTraceEmitter, response: CliResponse) {
  const stdout = response.stdout as any;
  const events = Array.isArray(stdout?.events) ? stdout.events : [];
  for (const event of events) {
    if (trace.signal.aborted) return;
    if (event?.type === 'agent.end') {
      emitAgentEndTrace(trace, event);
    }
  }
}

function emitAgentEndTrace(trace: AgentTraceEmitter, event: any) {
  const messages = event?.payload?.messages;
  if (!Array.isArray(messages)) {
    emitFinalAnswerFromAgentEnd(trace, event);
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (role === 'toolresult') {
      const toolCallId = String(message.toolCallId || message.tool_call_id || stableToolCallId(message));
      emitToolResult(trace, {
        toolCallId,
        toolName: String(message.toolName || message.tool_name || trace.pendingToolCallNames.get(toolCallId) || 'pi.tool'),
        content: message.content,
      });
      continue;
    }
    if (role && role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const partRecord = part as Record<string, unknown>;
      const type = String(partRecord.type || '').toLowerCase();
      if (type === 'toolcall') {
        emitToolCall(trace, part);
      }
    }
  }
  emitFinalAnswerFromAgentEnd(trace, event);
}

function emitFinalAnswerFromAgentEnd(trace: AgentTraceEmitter, event: any) {
  flushPendingTextBuffer(trace, 'reasoning');
  const finalText = finalAnswerFromAgentEnd(event);
  if (isMeaningfulPiText(finalText)) {
    const delta = nextAssistantDelta(trace, normalizeMarkdownContent(finalText));
    if (delta) {
      ensureAssistantStarted(trace);
      trace.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: trace.messageId,
        delta,
      });
    }
  }
}

function emitClassifiedTextToken(trace: AgentTraceEmitter, text: string) {
  if (!text) return;
  if (trace.textPhase === 'reasoning') {
    if (looksLikeReasoningText(text)) {
      emitReasoningDelta(trace, text);
      return;
    }
    if (trace.pendingTextBuffer || isPotentialAnswerStart(text)) {
      trace.pendingTextBuffer += text;
      const classification = classifyStreamingText(trace.pendingTextBuffer);
      if (classification === 'wait') return;
      if (classification === 'answer') {
        trace.textPhase = 'answer';
        const buffered = trace.pendingTextBuffer;
        trace.pendingTextBuffer = '';
        emitAssistantDelta(trace, buffered);
        return;
      }
      const buffered = trace.pendingTextBuffer;
      trace.pendingTextBuffer = '';
      emitReasoningDelta(trace, buffered);
      return;
    }
    emitReasoningDelta(trace, text);
    return;
  }
  if (trace.textPhase === 'answer') {
    emitAssistantDelta(trace, text);
    return;
  }

  trace.pendingTextBuffer += text;
  const classification = classifyStreamingText(trace.pendingTextBuffer);
  if (classification === 'wait') return;
  trace.textPhase = classification;
  const buffered = trace.pendingTextBuffer;
  trace.pendingTextBuffer = '';
  if (classification === 'reasoning') {
    emitReasoningDelta(trace, buffered);
  } else {
    emitAssistantDelta(trace, buffered);
  }
}

function flushPendingTextBuffer(trace: AgentTraceEmitter, fallback: 'reasoning' | 'answer' = 'answer') {
  const buffered = trace.pendingTextBuffer;
  if (!buffered) return;
  trace.pendingTextBuffer = '';
  const classification = trace.textPhase === 'unknown'
    ? classifyStreamingText(buffered, { force: true })
    : trace.textPhase;
  trace.textPhase = classification === 'wait' ? fallback : classification;
  if (fallback === 'reasoning' && trace.textPhase === 'answer' && !looksLikeAnswerText(buffered)) {
    trace.textPhase = 'reasoning';
  }
  if (trace.textPhase === 'reasoning') {
    emitReasoningDelta(trace, buffered);
  } else {
    emitAssistantDelta(trace, buffered);
  }
}

function emitReasoningDelta(trace: AgentTraceEmitter, delta: string) {
  if (!delta.trim() && !trace.reasoningStarted) return;
  ensureReasoningStarted(trace);
  trace.streamedReasoning = true;
  trace.emit({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: trace.reasoningMessageId,
    delta,
  });
}

function emitAssistantDelta(trace: AgentTraceEmitter, text: string) {
  const delta = nextAssistantDelta(trace, text);
  if (!delta) return;
  ensureAssistantStarted(trace);
  trace.emit({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: trace.messageId,
    delta,
  });
}

function classifyStreamingText(
  value: string,
  options: { force?: boolean } = {},
): 'wait' | 'reasoning' | 'answer' {
  const text = value.trimStart();
  if (!text) return options.force ? 'answer' : 'wait';
  if (!options.force && text.length < 24 && !/[。.!！?\n]/.test(text)) return 'wait';
  if (looksLikeReasoningText(text)) return 'reasoning';
  if (looksLikeAnswerText(text)) return 'answer';
  return 'answer';
}

function isPotentialAnswerStart(value: string): boolean {
  if (looksLikeReasoningText(value)) return false;
  return /^[\s>*#-]*(明|今|后|可|当|根|这|已|好|画|文|你|需|常|如|把|上|北|深|杭|广|成|出|总|结|答)/.test(value);
}

function looksLikeAnswerText(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^(明天|今天|后天|可以|当然|根据|这是|已经|好的|你好|画好了|文件位置|已生成|生成完成|上海|北京|深圳|杭州|广州|成都|总体|结论|答案)/.test(text)) {
    return true;
  }
  if (/^(出门建议|气温|降雨|风|体感)[：:]/.test(text)) return true;
  return false;
}

function looksLikeReasoningText(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^(目标是|计划(?:很|是|：|:)|已确认|现在(?:查询|请求|直接|开始|调用)|我会先|先读取|为了避免|这个结果的日期标签不可信)/.test(text)) {
    return true;
  }
  if (/^(Finding|Providing|Planning|Inspecting|Reading|Searching|Running|Calling|I need to|I should|It seems like|Let's)\b/i.test(text)) {
    return true;
  }
  if (/^\*\*(Finding|Providing|Planning|Inspecting|Reading|Searching|Running|Calling)[^*]*\*\*/i.test(text)) {
    return true;
  }
  if (/^(the weather information|keeping the|provide an answer|need to provide)\b/i.test(text)) {
    return true;
  }
  if (/^(I|I'm|I've|I'll|my|the|this|that|there|it|it's|its|user|guidelines|although|maybe|probably|seems|should|would|could|need|want|asking|using|python|draw|vague|clarify|specific|provide|example|response|technical|concise|tool|tools|common|option|question|answer)\b/i.test(text)) {
    return true;
  }
  return false;
}

function emitToolCall(trace: AgentTraceEmitter, value: unknown) {
  if (trace.signal.aborted) return;
  endReasoningIfOpen(trace);
  const toolCall = normalizeToolCall(value);
  if (!toolCall.id || trace.emittedToolCallIds.has(toolCall.id)) return;
  trace.emittedToolCallIds.add(toolCall.id);
  trace.pendingToolCallNames.set(toolCall.id, toolCall.name);
  const argsDelta = stringifyToolArguments(toolCall.arguments);
  trace.openToolCallIds.add(toolCall.id);
  trace.lastToolCallId = toolCall.id;
  trace.emit({
    type: EventType.TOOL_CALL_START,
    toolCallId: toolCall.id,
    toolCallName: toolCall.name,
    parentMessageId: trace.messageId,
  });
  if (argsDelta) {
    trace.emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: toolCall.id,
      delta: argsDelta,
    });
  }
}

function emitToolResult(trace: AgentTraceEmitter, value: { toolCallId: string; toolName?: string; content: unknown }) {
  if (trace.signal.aborted || !value.toolCallId || trace.emittedToolResultIds.has(value.toolCallId)) return;
  trace.emittedToolResultIds.add(value.toolCallId);
  const toolName = value.toolName || trace.pendingToolCallNames.get(value.toolCallId) || 'pi.tool';
  const completedCount = (trace.completedToolCounts.get(toolName) || 0) + 1;
  trace.completedToolCounts.set(toolName, completedCount);
  if (!trace.emittedToolCallIds.has(value.toolCallId)) {
    emitToolCall(trace, {
      id: value.toolCallId,
      name: toolName,
      arguments: {},
    });
  }
  closeToolCall(trace, value.toolCallId);
  trace.emit({
    type: EventType.TOOL_CALL_RESULT,
    messageId: `pi-tool-result-${value.toolCallId}`,
    toolCallId: value.toolCallId,
    role: 'tool',
    content: formatToolResultContent(value.content),
  });
}

function closeToolCall(trace: AgentTraceEmitter, toolCallId: string) {
  if (!trace.openToolCallIds.has(toolCallId) || trace.closedToolCallIds.has(toolCallId)) return;
  trace.emit({
    type: EventType.TOOL_CALL_END,
    toolCallId,
  });
  trace.openToolCallIds.delete(toolCallId);
  trace.closedToolCallIds.add(toolCallId);
}

function closeOpenToolCalls(trace: AgentTraceEmitter) {
  for (const toolCallId of Array.from(trace.openToolCallIds)) {
    closeToolCall(trace, toolCallId);
  }
}

function shouldRenderTokenText(payload: Record<string, unknown>, thinking: string): boolean {
  const text = tokenTextFromEventPayload(payload.text);
  if (!text) return false;
  const toolCall = payload.tool_call;
  if (toolCall || thinking) return false;
  return true;
}

function shouldEmitTokenToolCall(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return !isPartialToolCall(value);
}

function isPartialToolCall(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const partialJson = typeof record.partialJson === 'string' ? record.partialJson.trim() : '';
  if (!partialJson) return false;
  try {
    JSON.parse(partialJson);
    return false;
  } catch {
    return true;
  }
}

function nextAssistantDelta(trace: AgentTraceEmitter, text: string): string {
  text = collapseRepeatedText(normalizeMarkdownContent(text));
  if (!text) return '';
  const previous = streamedAssistantTextByMessage.get(trace.messageId) || '';
  const normalizedPrevious = collapseRepeatedText(previous);
  if (!previous) {
    streamedAssistantTextByMessage.set(trace.messageId, text);
    return text;
  }
  if (
    text === normalizedPrevious
    || normalizedPrevious.endsWith(text)
    || normalizeForRepeat(text) === normalizeForRepeat(normalizedPrevious)
    || normalizeForRepeat(normalizedPrevious).endsWith(normalizeForRepeat(text))
  ) {
    streamedAssistantTextByMessage.set(trace.messageId, normalizedPrevious);
    return '';
  }
  if (text.startsWith(normalizedPrevious)) {
    const delta = text.slice(normalizedPrevious.length);
    streamedAssistantTextByMessage.set(trace.messageId, text);
    return delta;
  }
  const combined = collapseRepeatedText(normalizedPrevious + text);
  streamedAssistantTextByMessage.set(trace.messageId, combined);
  if (combined === normalizedPrevious) return '';
  if (combined.startsWith(normalizedPrevious)) return combined.slice(normalizedPrevious.length);
  return text;
}

function traceActivity(trace: AgentTraceEmitter, stage: string, detail: string) {
  if (trace.signal.aborted) return;
  emitActivitySnapshot(trace.emit, trace.activityMessageId, {
    title: 'AgSwarm AI',
    status: stage === 'tool_complete' ? 'completed' : 'running',
    stage,
    detail,
  });
}

function ensureAssistantStarted(trace: AgentTraceEmitter) {
  if (trace.signal.aborted || trace.assistantStarted) return;
  trace.assistantStarted = true;
  trace.emit({
    type: EventType.TEXT_MESSAGE_START,
    messageId: trace.messageId,
    role: 'assistant',
  });
}

function endAssistantIfOpen(trace: AgentTraceEmitter) {
  if (!trace.assistantStarted) return;
  trace.emit({
    type: EventType.TEXT_MESSAGE_END,
    messageId: trace.messageId,
  });
  trace.assistantStarted = false;
}

function ensureReasoningStarted(trace: AgentTraceEmitter) {
  if (trace.signal.aborted || trace.reasoningStarted) return;
  trace.reasoningStarted = true;
  trace.emit({
    type: EventType.REASONING_START,
    messageId: trace.reasoningMessageId,
  });
  trace.emit({
    type: EventType.REASONING_MESSAGE_START,
    messageId: trace.reasoningMessageId,
    role: 'reasoning',
  });
}

function endReasoningIfOpen(trace: AgentTraceEmitter) {
  if (!trace.reasoningStarted) return;
  trace.emit({
    type: EventType.REASONING_MESSAGE_END,
    messageId: trace.reasoningMessageId,
  });
  trace.emit({
    type: EventType.REASONING_END,
    messageId: trace.reasoningMessageId,
  });
  trace.reasoningStarted = false;
}

function emitActivitySnapshot(
  emit: (event: BaseEvent) => void,
  messageId: string,
  content: Record<string, unknown>,
) {
  emit({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: 'agswarm.pi.status',
    content,
    replace: true,
  });
}

async function emitTextDeltas({
  text,
  trace,
  signal,
}: {
  text: string;
  trace: AgentTraceEmitter;
  signal: AbortSignal;
}): Promise<void> {
  const remaining = stripAlreadyEmittedText(text, streamedAssistantTextByMessage.get(trace.messageId) || '');
  for (const delta of chunkText(remaining)) {
    if (signal.aborted) return;
    emitAssistantDelta(trace, delta);
    await delay(18);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function latestUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return textFromContent(message.content).trim();
    }
  }
  return '';
}

function textFromContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String(part.text || '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function summarizePiResponse(response: CliResponse): string {
  if (!response.ok) {
    return response.stderr || 'AgSwarm AI command failed.';
  }
  const stdout = response.stdout as any;
  const events = Array.isArray(stdout?.events) ? stdout.events : [];
  const agentEnd = [...events].reverse().find(event => event?.type === 'agent.end');
  const turnEnd = [...events].reverse().find(event => event?.type === 'agent.turn_end');
  const completed = [...events].reverse().find(event => event?.type === 'adapter.completed');

  const tokenText = events
    .filter(event => event?.type === 'agent.token')
    .map(event => tokenTextFromEventPayload(event?.payload?.text))
    .join('')
    .trim();
  const userMessage = Array.isArray(stdout?.user_messages)
    ? [...stdout.user_messages].reverse().map(messageFromUserMessage).find(Boolean)
    : '';

  const message = [
    textFromEventPayload(stdout?.assistant_text),
    finalAnswerFromEvents(events),
    finalAnswerFromAgentEnd(agentEnd),
    errorTextFromEvents(events),
    textFromEventPayload(turnEnd?.payload?.message),
    textFromEventPayload(completed?.payload?.output),
    textFromEventPayload(stdout?.result?.output),
    textFromEventPayload(stdout?.output),
    userMessage,
  ].find(isMeaningfulPiText);

  return normalizeMarkdownContent(collapseRepeatedText(message || ''));
}

function stripAlreadyEmittedText(text: string, emittedText: string): string {
  const normalizedText = collapseRepeatedText(normalizeMarkdownContent(text));
  const normalizedEmitted = collapseRepeatedText(normalizeMarkdownContent(emittedText));
  if (!normalizedText || !normalizedEmitted) return normalizedText || text;
  if (normalizedText === normalizedEmitted) return '';
  if (normalizedText.startsWith(normalizedEmitted)) return normalizedText.slice(normalizedEmitted.length).trimStart();
  const compactText = normalizeForRepeat(normalizedText);
  const compactEmitted = normalizeForRepeat(normalizedEmitted);
  if (compactText === compactEmitted || compactEmitted.endsWith(compactText)) return '';
  return normalizedText;
}

function piResponseStatus(response: CliResponse): 'succeeded' | 'failed' {
  if (!response.ok) return 'failed';
  const stdout = response.stdout as any;
  const status = String(stdout?.status || '').toLowerCase();
  if (['failed', 'error', 'timeout', 'cancelled', 'unavailable'].includes(status)) return 'failed';
  const events = Array.isArray(stdout?.events) ? stdout.events : [];
  if (errorTextFromEvents(events)) return 'failed';
  return events.some(event => event?.type === 'adapter.error') ? 'failed' : 'succeeded';
}

function isMeaningfulPiText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/^task completed successfully[\s.。!！]*$/i.test(normalized)) return false;
  if (/^(?:AgSwarm AI\s*)?(?:completed|finished|response ready)[\s.。!！]*$/i.test(normalized)) return false;
  if (/^AgSwarm AI\s+(?:completed|finished)\s+response ready[\s.。!！]*$/i.test(normalized)) return false;
  if (/^(?:completed|finished)\s+(?:completed|finished)\s+response ready[\s.。!！]*$/i.test(normalized)) return false;
  return true;
}

function errorTextFromEvents(events: any[]): string {
  for (const event of [...events].reverse()) {
    if (event?.type === 'adapter.error') {
      const message = textFromEventPayload(event?.payload?.message || event?.payload?.error);
      if (message) return `AgSwarm AI 执行失败：${message}`;
    }
    if (event?.type === 'agent.end') {
      const message = errorTextFromAgentEnd(event);
      if (message) return `AgSwarm AI 执行失败：${message}`;
    }
  }
  return '';
}

function errorTextFromAgentEnd(event: any): string {
  const messages = event?.payload?.messages;
  if (!Array.isArray(messages)) return '';
  for (const item of [...messages].reverse()) {
    const message = textFromEventPayload(item?.errorMessage || item?.error);
    if (message) return message;
    if (String(item?.stopReason || '') === 'error') {
      return 'AgSwarm AI stopped with an error before producing a response.';
    }
  }
  return '';
}

function finalAnswerFromEvents(events: any[]): string {
  for (const event of [...events].reverse()) {
    if (event?.type !== 'agent.end') continue;
    const text = finalAnswerFromAgentEnd(event);
    if (isMeaningfulPiText(text)) return text;
  }
  return '';
}

function finalAnswerFromAgentEnd(event: any): string {
  const messages = event?.payload?.messages;
  if (!Array.isArray(messages)) return '';
  for (const item of [...messages].reverse()) {
    const role = String(item?.role || '').toLowerCase();
    if (role && role !== 'assistant') continue;
    const finalText = textFromAssistantContent(item?.content, 'final_answer');
    if (finalText) return finalText;
  }
  for (const item of [...messages].reverse()) {
    const role = String(item?.role || '').toLowerCase();
    if (role && role !== 'assistant') continue;
    const text = textFromAssistantContent(item?.content);
    if (isMeaningfulPiText(text)) return text;
    const fallback = textFromEventPayload(item?.message || item?.text);
    if (isMeaningfulPiText(fallback)) return fallback;
  }
  return '';
}

function textFromAssistantContent(content: unknown, preferredPhase?: string): string {
  if (!Array.isArray(content)) return textFromEventPayload(content);
  const texts = content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      const type = String(record.type || '').toLowerCase();
      if (type && type !== 'text') return '';
      const signature = parseTextSignature(record.textSignature);
      if (preferredPhase) {
        if (signature?.phase !== preferredPhase) return '';
      } else if (signature?.phase && signature.phase !== 'final_answer') {
        return '';
      }
      const text = textFromEventPayload(record.text);
      if (!preferredPhase && (looksLikeReasoningText(text) || !looksLikeAnswerText(text))) return '';
      return text;
    })
    .filter(isMeaningfulPiText);
  if (texts.length) return texts.join('\n\n');
  return '';
}

function parseTextSignature(value: unknown): { phase?: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as { phase?: string } : null;
  } catch {
    return null;
  }
}

function textFromEventPayload(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(textFromEventPayload).filter(Boolean).join('\n').trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textFromEventPayload(record.text || record.content || record.message || record.output);
  }
  return '';
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenTextFromEventPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  return textFromEventPayload(value);
}

function formatToolActivity(value: unknown): string {
  const name = normalizeToolName(value);
  return name ? `正在调用 ${name}。` : '正在调用工具。';
}

function normalizeToolCall(value: unknown): { id: string; name: string; arguments: Record<string, unknown> } {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = String(record.id || record.toolCallId || stableToolCallId(record));
    const name = String(record.name || record.tool || record.toolName || record.command || 'pi.tool');
    const rawArgs = record.arguments ?? record.args ?? record.params ?? {};
    return {
      id,
      name: name.trim() || 'pi.tool',
      arguments: normalizeToolArguments(rawArgs),
    };
  }
  const name = normalizeToolName(value) || 'pi.tool';
  return {
    id: stableToolCallId({ name }),
    name,
    arguments: {},
  };
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value };
    } catch {
      return { value };
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function stringifyToolArguments(args: Record<string, unknown>): string {
  if (!Object.keys(args).length) return '{}';
  try {
    return JSON.stringify(args);
  } catch {
    return JSON.stringify({ value: String(args) });
  }
}

function stableToolCallId(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
  }
  return `pi-tool-${Math.abs(hash) || 1}`;
}

function stableToolExecutionId(payload: Record<string, unknown>): string {
  const tool = normalizeToolName(payload.tool);
  if (!tool) return '';
  return stableToolCallId({
    tool,
    params: payload.params || payload.arguments || payload.args || {},
  });
}

function readableToolAction(name: string, args: Record<string, unknown>): string {
  const title = toolTitleFromName(name);
  const path = stringArg(args, 'path') || stringArg(args, 'file') || stringArg(args, 'target');
  const command = stringArg(args, 'command') || stringArg(args, 'cmd');
  const query = stringArg(args, 'query') || stringArg(args, 'q') || stringArg(args, 'pattern');
  if (/read|open|cat/i.test(name) && path) return `正在读取 ${compactPath(path)}。`;
  if (/search|find|grep|rg|glob/i.test(name) && (query || path)) return `正在搜索 ${query || compactPath(path)}。`;
  if (/exec|shell|command|bash|run/i.test(name) && command) return `正在执行 ${summarizeCommand(command)}。`;
  if (/write|edit|patch/i.test(name) && path) return `正在修改 ${compactPath(path)}。`;
  return `正在${title}。`;
}

function summarizeCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (/wttr\.in/i.test(compact)) return '天气查询命令';
  if (/python/i.test(compact)) return 'Python 脚本';
  if (/curl/i.test(compact)) return '网络请求';
  return truncateForTrace(compact, 96);
}

function toolTitleFromName(name: string): string {
  if (/read|open|cat/i.test(name)) return '读取内容';
  if (/search|find|grep|rg|glob/i.test(name)) return '搜索内容';
  if (/exec|shell|command|bash|run/i.test(name)) return '执行命令';
  if (/write|edit|patch/i.test(name)) return '修改文件';
  if (/weather/i.test(name)) return '查询天气';
  return `调用 ${name}`;
}

function completedToolSummary(
  counts: Map<string, number>,
  latestToolName: string,
  latestCount: number,
  totalCompleted: number,
): string {
  if (counts.size <= 1) {
    return `${toolTitleFromName(latestToolName)}已调用${latestCount > 1 ? ` ${latestCount} 次` : ''}。`;
  }
  const parts = Array.from(counts.entries())
    .slice(-3)
    .map(([name, count]) => `${toolTitleFromName(name)}${count > 1 ? ` ${count} 次` : ''}`);
  return `已调用 ${totalCompleted} 个工具：${parts.join('、')}。`;
}

function formatToolResultContent(value: unknown): string {
  const text = textFromEventPayload(value);
  if (text) return truncateForTrace(text, 2400);
  try {
    return truncateForTrace(JSON.stringify(value ?? {}, null, 2), 2400);
  } catch {
    return String(value ?? '');
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function formatToolUpdate(value: unknown): string {
  const text = textFromEventPayload(value);
  if (!text) return '工具正在运行。';
  if (/search|find|rg|grep|glob|file|文件|搜索|查找/i.test(text)) return '正在搜索文件。';
  if (/read|open|cat|读取|打开/i.test(text)) return '正在读取内容。';
  if (/write|edit|patch|修改|写入/i.test(text)) return '正在修改文件。';
  if (/command|shell|exec|运行|执行/i.test(text)) return '正在执行命令。';
  return truncateForTrace(text, 160);
}

function messageFromUserMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return textFromEventPayload(record.message || record.text || record.content);
}

const MENTION_PATTERN = /@([^\s@,，:：]+)/g;

function resolveMentionTarget(prompt: string, devices: Device[], localNodeId: string): Device | null {
  const mentions = [...prompt.matchAll(MENTION_PATTERN)]
    .map(match => match[1]?.trim().toLowerCase())
    .filter(Boolean);
  if (!mentions.length) return null;
  const remoteDevices = devices.filter(device => device.id !== localNodeId);
  const candidates = remoteDevices.length ? remoteDevices : devices;
  for (const mention of mentions) {
    const match = candidates.find(device => {
      const id = device.id.toLowerCase();
      const name = device.name.toLowerCase();
      return id === mention
        || name === mention
        || id.startsWith(mention)
        || name.includes(mention);
    });
    if (match) return match;
  }
  return null;
}

function stripMention(prompt: string, device: Device): string {
  const aliases = [device.id, device.name]
    .filter(Boolean)
    .map(value => escapeRegExp(value.trim()))
    .filter(Boolean);
  if (!aliases.length) return prompt;
  const exactPattern = new RegExp(`@(?:${aliases.join('|')})\\b`, 'gi');
  const stripped = prompt.replace(exactPattern, '').replace(/\s{2,}/g, ' ').trim();
  return stripped || prompt;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeToolName(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.name || record.tool || record.command || '').trim();
  }
  return String(value).trim();
}

function truncateForTrace(value: unknown, maxLength = 1800): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... truncated ...`;
}

function countPiToolEvents(response: CliResponse): number {
  const stdout = response.stdout as any;
  const events = Array.isArray(stdout?.events) ? stdout.events : [];
  return events.filter(event => event?.type === 'agent.tool_start').length;
}

function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized.match(/[\s\S]{1,18}/g) || [];
}
