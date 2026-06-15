import { ActionIcon, Badge, Box, Group, Tooltip } from '@mantine/core';
import { ChevronLeft, ChevronRight, Copy, MessageSquareText, Plus, SendHorizontal, Wrench } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EventType } from '@ag-ui/client';
import type { AbstractAgent, BaseEvent, Message } from '@ag-ui/client';
import { ChatSessionManager } from './ChatSessionManager';
import type { Device } from './DevicesView';
import {
  createOrReuseEmptyChatSession,
  deleteChatSession,
  getSessionMessages,
  loadChatSessions,
  renameChatSession,
  saveChatSessions,
  upsertSessionMessages,
} from '../lib/chatSessionsStore';
import { getPiCommands, writeFrontendDebugLog } from '../lib/agswarmApi';
import { normalizeMarkdownContent } from '../lib/markdownNormalize';
import { PiCopilotAgent } from '../lib/piCopilotAgent';
import type { CliResponse, PiCommandInfo, SendTaskData } from '../types/agswarm';

interface PiGuiChatViewProps {
  agentId?: string;
  natsUrl: string;
  model: string;
  devices?: Device[];
  localNodeId: string;
  localDeviceLabel: string;
  latexMcpDir: string;
  piCwd: string;
  agentSkills: string;
  onDispatchTask: (taskData: SendTaskData, options?: { targetDeviceName?: string }) => Promise<CliResponse>;
}

type TimelineMessage = {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};

type TimelineReasoning = {
  kind: 'reasoning';
  id: string;
  text: string;
  status: 'running' | 'complete';
  createdAt: string;
};

type TimelineTool = {
  kind: 'tool';
  id: string;
  callId: string;
  toolName: string;
  label: string;
  status: 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  createdAt: string;
};

type TimelineActivity = {
  kind: 'activity';
  id: string;
  label: string;
  detail?: string;
  tone?: 'neutral' | 'error';
  createdAt: string;
};

type TimelineItem = TimelineMessage | TimelineReasoning | TimelineTool | TimelineActivity;

export function PiGuiChatView({
  agentId = 'pi',
  natsUrl,
  model,
  devices = [],
  localNodeId,
  localDeviceLabel,
  latexMcpDir,
  piCwd,
  agentSkills,
  onDispatchTask,
}: PiGuiChatViewProps) {
  const [sessionEnvelope, setSessionEnvelope] = useState(() => ({
    nodeId: localNodeId,
    state: loadChatSessions(localNodeId),
  }));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  const [piCommands, setPiCommands] = useState<PiCommandInfo[]>([]);
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const [liveItems, setLiveItems] = useState<TimelineItem[]>([]);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const latestSessionEnvelopeRef = useRef(sessionEnvelope);
  const latestDevicesRef = useRef(devices);
  const latestDispatchTaskRef = useRef(onDispatchTask);
  const activeSessionId = sessionEnvelope.state.activeSessionId;
  const activeSessionMessages = useMemo(
    () => getSessionMessages(sessionEnvelope.state, activeSessionId),
    [activeSessionId, sessionEnvelope.state],
  );
  const remoteDevices = useMemo(
    () => devices.filter(device => device.id !== localNodeId),
    [devices, localNodeId],
  );
  const targetDevice = useMemo(
    () => remoteDevices.find(isPiAgentDevice) || devices.find(isPiAgentDevice) || remoteDevices[0] || devices[0],
    [devices, remoteDevices],
  );
  const targetNodeId = targetDevice?.id || localNodeId;
  const targetLabel = targetDevice?.name || localDeviceLabel || targetNodeId;
  const isLocalTarget = targetNodeId === localNodeId;

  useEffect(() => {
    latestDevicesRef.current = devices;
  }, [devices]);

  useEffect(() => {
    latestDispatchTaskRef.current = onDispatchTask;
  }, [onDispatchTask]);

  const dispatchTask = useCallback(
    (taskData: SendTaskData, options?: { targetDeviceName?: string }) => latestDispatchTaskRef.current(taskData, options),
    [],
  );
  const getDevices = useCallback(() => latestDevicesRef.current, []);

  const agent = useMemo(() => new PiCopilotAgent({
    agentId,
    natsUrl,
    nodeId: targetNodeId,
    model,
    skills: agentSkills || 'safe_default',
    getDevices,
    localNodeId,
    localDeviceLabel,
    latexMcpDir,
    piCwd,
    dispatchTask,
  }, activeSessionMessages), [
    activeSessionId,
    agentId,
    agentSkills,
    dispatchTask,
    getDevices,
    latexMcpDir,
    localDeviceLabel,
    localNodeId,
    model,
    natsUrl,
    piCwd,
    targetNodeId,
  ]);

  useEffect(() => {
    setSessionEnvelope({ nodeId: localNodeId, state: loadChatSessions(localNodeId) });
  }, [localNodeId]);

  useEffect(() => {
    latestSessionEnvelopeRef.current = sessionEnvelope;
    if (sessionEnvelope.nodeId !== localNodeId) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveChatSessions(localNodeId, sessionEnvelope.state);
      saveTimerRef.current = null;
    }, 220);
  }, [localNodeId, sessionEnvelope]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      const latest = latestSessionEnvelopeRef.current;
      saveChatSessions(latest.nodeId || localNodeId, latest.state);
    };
  }, [localNodeId]);

  useEffect(() => {
    let cancelled = false;
    getPiCommands({ natsUrl, skills: agentSkills || 'safe_default', workspace: piCwd || undefined })
      .then(response => {
        if (cancelled) return;
        setPiCommands(dedupePiCommands([...(response.commands || []), ...(response.models || []), ...(response.skills || [])]));
      })
      .catch(error => {
        if (cancelled) return;
        console.warn('[agswarm] failed to load AgSwarm AI commands', error);
        setPiCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentSkills, natsUrl, piCwd]);

  useEffect(() => {
    setLiveItems([]);
    setErrorText('');
    setExpandedToolIds(new Set());
    window.setTimeout(() => composerRef.current?.focus(), 80);
  }, [activeSessionId]);

  useEffect(() => {
    scrollToBottom(paneRef.current);
  }, [activeSessionId, activeSessionMessages.length, liveItems.length]);

  useEffect(() => {
    const dump = (label = 'pi-gui-chat-dom') => {
      const snapshot = {
        activeSessionId,
        isRunning,
        itemCount: timelineItems.length,
        text: paneRef.current?.innerText.slice(0, 1800) || '',
      };
      void writeFrontendDebugLog({ label, payload: snapshot }).catch(() => undefined);
      return snapshot;
    };
    const debugWindow = window as typeof window & {
      __AGSWARM_DOM_SNAPSHOT__?: typeof dump;
    };
    debugWindow.__AGSWARM_DOM_SNAPSHOT__ = dump;
    return () => {
      if (debugWindow.__AGSWARM_DOM_SNAPSHOT__ === dump) delete debugWindow.__AGSWARM_DOM_SNAPSHOT__;
    };
  }, [activeSessionId, isRunning, liveItems.length]);

  const persistedItems = useMemo(() => messagesToTimeline(activeSessionMessages), [activeSessionMessages]);
  const timelineItems = useMemo(() => mergeTimelineItems(persistedItems, liveItems), [persistedItems, liveItems]);
  const filteredCommands = useMemo(() => {
    const query = composerText.trimStart().replace(/^\//, '').toLowerCase();
    return piCommands
      .filter(command => `${command.name} ${command.description || ''}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [composerText, piCommands]);

  const createSession = useCallback(() => {
    if (isCreatingSession) return;
    setIsCreatingSession(true);
    setSessionEnvelope(current => ({ ...current, state: createOrReuseEmptyChatSession(current.state) }));
    window.setTimeout(() => setIsCreatingSession(false), 220);
  }, [isCreatingSession]);

  const selectSession = useCallback((sessionId: string) => {
    setSessionEnvelope(current => current.state.activeSessionId === sessionId
      ? current
      : { ...current, state: { ...current.state, activeSessionId: sessionId } });
    if (window.matchMedia('(max-width: 768px)').matches) setSessionsOpen(false);
  }, []);

  const submit = useCallback(async () => {
    const text = composerText.trim();
    if (!text || isRunning) return;
    const userMessage: Message = {
      id: `user-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
    };
    const nextMessages = [...activeSessionMessages, userMessage];
    setComposerText('');
    setCommandPanelOpen(false);
    setErrorText('');
    setLiveItems([]);
    setIsRunning(true);
    setSessionEnvelope(current => ({
      ...current,
      state: upsertSessionMessages(current.state, activeSessionId, nextMessages),
    }));
    agent.setMessages(nextMessages);
    const live = createLiveTimelineSink(setLiveItems);
    try {
      const result = await agent.runAgent(undefined, {
        onEvent: ({ event }) => {
          live.apply(event);
        },
      });
      setSessionEnvelope(current => ({
        ...current,
        state: upsertSessionMessages(current.state, activeSessionId, result.newMessages),
      }));
      setLiveItems([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      setLiveItems(items => mergeTimelineItems(items, [{
        kind: 'activity',
        id: `error-${crypto.randomUUID()}`,
        label: 'AgSwarm AI 执行失败',
        detail: message,
        tone: 'error',
        createdAt: new Date().toISOString(),
      }]));
    } finally {
      setIsRunning(false);
      window.setTimeout(() => composerRef.current?.focus(), 80);
    }
  }, [activeSessionId, activeSessionMessages, agent, composerText, isRunning]);

  return (
    <Box className={`pi-gui-chat-shell ${sessionsOpen ? 'is-sessions-open' : 'is-sessions-collapsed'}`}>
      <button
        type="button"
        aria-label="Close chat sessions"
        className="pi-gui-chat-scrim"
        onClick={() => setSessionsOpen(false)}
      />
      <aside className="pi-gui-session-sidebar">
        <div className="pi-gui-sidebar-heading">
          <div className="pi-gui-device-name">{localDeviceLabel || localNodeId}</div>
          <div className="pi-gui-sidebar-subtitle">Chats</div>
        </div>
        <ChatSessionManager
          layout="sidebar"
          sessions={sessionEnvelope.state.sessions}
          activeSessionId={activeSessionId}
          onCreateSession={createSession}
          isCreatingSession={isCreatingSession}
          onSelectSession={selectSession}
          onRenameSession={(sessionId, title) => {
            setSessionEnvelope(current => ({ ...current, state: renameChatSession(current.state, sessionId, title) }));
          }}
          onDeleteSession={(sessionId) => {
            setSessionEnvelope(current => ({ ...current, state: deleteChatSession(current.state, sessionId) }));
          }}
        />
      </aside>

      <section className="pi-gui-main">
        <header className="pi-gui-header">
          <Tooltip label={sessionsOpen ? 'Hide chats' : 'Show chats'}>
            <button
              type="button"
              className="pi-gui-icon-button"
              aria-label={sessionsOpen ? 'Hide chat sessions' : 'Show chat sessions'}
              onClick={() => setSessionsOpen(open => !open)}
            >
              {sessionsOpen ? <ChevronLeft size={17} /> : <MessageSquareText size={17} />}
            </button>
          </Tooltip>
          <div className="pi-gui-title-block">
            <div className="pi-gui-title">AgSwarm AI</div>
            <div className="pi-gui-subtitle">
              <span>{isLocalTarget ? 'Local target' : 'Remote target'}</span>
              <span>{targetLabel}</span>
            </div>
          </div>
          <Badge color={isRunning ? 'teal' : 'gray'} variant="light">
            {isRunning ? 'running' : 'ready'}
          </Badge>
        </header>

        <div ref={paneRef} className="pi-gui-timeline-pane">
          <div className="pi-gui-timeline">
            {timelineItems.length ? timelineItems.map(item => (
              <TimelineRow
                key={item.id}
                item={item}
                expanded={item.kind === 'tool' ? expandedToolIds.has(item.callId) : false}
                onToggleTool={(callId) => setExpandedToolIds(current => toggleSetItem(current, callId))}
              />
            )) : (
              <div className="pi-gui-empty">Send a prompt to start the session.</div>
            )}
            {errorText ? <div className="pi-gui-error">{errorText}</div> : null}
          </div>
        </div>

        <div className="pi-gui-composer-wrap">
          {commandPanelOpen && filteredCommands.length ? (
            <div className="pi-gui-command-menu" role="listbox" aria-label="AgSwarm AI commands">
              {filteredCommands.map(command => (
                <button
                  key={`${command.source}:${command.name}:${command.value || ''}`}
                  type="button"
                  className="pi-gui-command"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setComposerText(command.value || command.name);
                    setCommandPanelOpen(false);
                    window.setTimeout(() => composerRef.current?.focus(), 0);
                  }}
                >
                  <span>{command.name}</span>
                  <small>{command.source}</small>
                  {command.description ? <em>{command.description}</em> : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="pi-gui-composer">
            <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="New chat" onClick={createSession}>
              <Plus size={18} />
            </ActionIcon>
            <textarea
              ref={composerRef}
              value={composerText}
              rows={1}
              placeholder={`Ask AgSwarm AI on ${targetLabel}...`}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setComposerText(value);
                setCommandPanelOpen(value.trimStart().startsWith('/'));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <ActionIcon
              variant="filled"
              color="teal"
              radius="xl"
              aria-label="Send"
              disabled={!composerText.trim() || isRunning}
              onClick={() => void submit()}
            >
              <SendHorizontal size={18} />
            </ActionIcon>
          </div>
        </div>
      </section>
    </Box>
  );
}

function TimelineRow({
  item,
  expanded,
  onToggleTool,
}: {
  item: TimelineItem;
  expanded: boolean;
  onToggleTool: (callId: string) => void;
}) {
  if (item.kind === 'message') {
    return (
      <article className={`pi-gui-item pi-gui-message pi-gui-message-${item.role}`}>
        <div className="pi-gui-speaker">{item.role === 'user' ? 'You' : 'AgSwarm AI'}</div>
        <div className="pi-gui-bubble">
          <Markdown text={item.text} />
        </div>
        {item.role === 'assistant' ? (
          <button className="pi-gui-copy" type="button" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(item.text)}>
            <Copy size={13} />
          </button>
        ) : null}
      </article>
    );
  }
  if (item.kind === 'reasoning') {
    return (
      <details className="pi-gui-reasoning" open={item.status === 'running'}>
        <summary>
          <span className={`pi-gui-dot ${item.status === 'running' ? 'is-running' : ''}`} />
          <span>{item.status === 'running' ? '正在思考' : '思考过程'}</span>
        </summary>
        <div className="pi-gui-reasoning-body">
          <Markdown text={item.text} />
        </div>
      </details>
    );
  }
  if (item.kind === 'tool') {
    const hasDetail = item.input !== undefined || item.output !== undefined;
    return (
      <article className={`pi-gui-tool pi-gui-tool-${item.status}`}>
        <button
          type="button"
          className="pi-gui-tool-header"
          disabled={!hasDetail}
          aria-expanded={expanded}
          onClick={() => onToggleTool(item.callId)}
        >
          {hasDetail ? <ChevronRight className={expanded ? 'is-expanded' : ''} size={15} /> : <Wrench size={14} />}
          <span>{item.label}</span>
          <small>{item.toolName} · {toolStatusLabel(item.status)}</small>
        </button>
        {expanded && hasDetail ? (
          <pre className="pi-gui-tool-detail">{formatToolDetail(item.input, item.output)}</pre>
        ) : null}
      </article>
    );
  }
  return (
    <div className={`pi-gui-activity ${item.tone === 'error' ? 'is-error' : ''}`}>
      <span>{item.label}</span>
      {item.detail ? <small>{item.detail}</small> : null}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(normalizeMarkdownContent(text));
  return (
    <div className="pi-gui-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <pre key={index} data-language={block.language || undefined}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
            </ul>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; language: string; text: string };

function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: { language: string; lines: string[] } | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join('\n').trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: 'list', items: list });
    list = [];
  };
  for (const line of lines) {
    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence) {
      if (code) {
        blocks.push({ type: 'code', language: code.language, text: code.lines.join('\n') });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { language: fence[1] || '', lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) blocks.push({ type: 'code', language: code.language, text: code.lines.join('\n') });
  flushParagraph();
  flushList();
  return blocks.length ? blocks : [{ type: 'paragraph', text: value }];
}

function renderInlineMarkdown(value: string) {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g;
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) nodes.push(value.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={nodes.length}>{token.slice(2, -2)}</strong>);
    } else {
      const label = match[4] || token;
      const href = match[5] || token;
      nodes.push(<a key={nodes.length} href={href} target="_blank" rel="noreferrer">{label}</a>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}

function createLiveTimelineSink(setItems: React.Dispatch<React.SetStateAction<TimelineItem[]>>) {
  const assistantTextById = new Map<string, string>();
  const reasoningTextById = new Map<string, string>();
  const toolArgsById = new Map<string, string>();
  const now = () => new Date().toISOString();
  return {
    apply(event: BaseEvent) {
      setItems(items => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_START:
            assistantTextById.set(eventString(event, 'messageId'), '');
            return upsertTimeline(items, {
              kind: 'message',
              id: eventString(event, 'messageId'),
              role: 'assistant',
              text: '',
              createdAt: now(),
            });
          case EventType.TEXT_MESSAGE_CONTENT: {
            const messageId = eventString(event, 'messageId');
            const previous = assistantTextById.get(messageId) || '';
            const text = previous + eventString(event, 'delta');
            assistantTextById.set(messageId, text);
            return upsertTimeline(items, {
              kind: 'message',
              id: messageId,
              role: 'assistant',
              text,
              createdAt: now(),
            });
          }
          case EventType.REASONING_MESSAGE_START:
            reasoningTextById.set(eventString(event, 'messageId'), '');
            return upsertTimeline(items, {
              kind: 'reasoning',
              id: eventString(event, 'messageId'),
              text: '',
              status: 'running',
              createdAt: now(),
            });
          case EventType.REASONING_MESSAGE_CONTENT: {
            const messageId = eventString(event, 'messageId');
            const previous = reasoningTextById.get(messageId) || '';
            const text = previous + eventString(event, 'delta');
            reasoningTextById.set(messageId, text);
            return upsertTimeline(items, {
              kind: 'reasoning',
              id: messageId,
              text,
              status: 'running',
              createdAt: now(),
            });
          }
          case EventType.REASONING_MESSAGE_END: {
            const existing = items.find(item => item.id === eventString(event, 'messageId') && item.kind === 'reasoning') as TimelineReasoning | undefined;
            if (!existing) return items;
            return upsertTimeline(items, { ...existing, status: 'complete' });
          }
          case EventType.TOOL_CALL_START:
            {
              const toolCallId = eventString(event, 'toolCallId');
              const toolCallName = eventString(event, 'toolCallName') || 'pi.tool';
              return upsertTimeline(items, {
                kind: 'tool',
                id: `tool-${toolCallId}`,
                callId: toolCallId,
                toolName: toolCallName,
                label: runningToolLabel(toolCallName, {}),
                status: 'running',
                createdAt: now(),
              });
            }
          case EventType.TOOL_CALL_ARGS: {
            const toolCallId = eventString(event, 'toolCallId');
            const args = (toolArgsById.get(toolCallId) || '') + eventString(event, 'delta');
            toolArgsById.set(toolCallId, args);
            const parsed = parseMaybeJson(args);
            const existing = items.find(item => item.kind === 'tool' && item.callId === toolCallId) as TimelineTool | undefined;
            if (!existing) return items;
            return upsertTimeline(items, {
              ...existing,
              input: parsed ?? args,
              label: runningToolLabel(existing.toolName, parsed),
            });
          }
          case EventType.TOOL_CALL_RESULT: {
            const existing = items.find(item => item.kind === 'tool' && item.callId === eventString(event, 'toolCallId')) as TimelineTool | undefined;
            if (!existing) return items;
            const isError = Boolean(eventValue(event, 'error'));
            return upsertTimeline(items, {
              ...existing,
              output: eventValue(event, 'content'),
              status: isError ? 'error' : 'success',
              label: completedToolLabel(existing.toolName),
            });
          }
          case EventType.RUN_ERROR:
            return upsertTimeline(items, {
              kind: 'activity',
              id: `run-error-${crypto.randomUUID()}`,
              label: 'AgSwarm AI 执行失败',
              detail: eventString(event, 'message'),
              tone: 'error',
              createdAt: now(),
            });
          default:
            return items;
        }
      });
    },
  };
}

function messagesToTimeline(messages: Message[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user' || message.role === 'assistant') {
      const text = messageText(message);
      if (!text.trim()) return;
      items.push({
        kind: 'message' as const,
        id: message.id || `${message.role}-${index}`,
        role: message.role,
        text,
        createdAt: new Date(index).toISOString(),
      });
      return;
    }
    if (message.role === 'reasoning') {
      const text = String(message.content || '');
      if (!text.trim()) return;
      items.push({
        kind: 'reasoning' as const,
        id: message.id || `reasoning-${index}`,
        text,
        status: 'complete' as const,
        createdAt: new Date(index).toISOString(),
      });
      return;
    }
    if (message.role === 'tool') {
      items.push({
        kind: 'tool' as const,
        id: `tool-${message.toolCallId || index}`,
        callId: message.toolCallId || `tool-${index}`,
        toolName: 'pi.tool',
        label: completedToolLabel('pi.tool'),
        status: message.error ? 'error' as const : 'success' as const,
        output: message.content,
        createdAt: new Date(index).toISOString(),
      });
    }
  });
  return items;
}

function upsertTimeline(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex(existing => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function mergeTimelineItems(left: TimelineItem[], right: TimelineItem[]): TimelineItem[] {
  return right.reduce(upsertTimeline, left);
}

function messageText(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part) return String(part.text || '');
    return '';
  }).filter(Boolean).join('\n');
}

function runningToolLabel(toolName: string, args: unknown): string {
  const command = stringField(args, 'command') || stringField(args, 'cmd');
  const path = stringField(args, 'path') || stringField(args, 'file_path') || stringField(args, 'filePath');
  if (/read/i.test(toolName) && path) return `Reading ${shortPath(path)}`;
  if (/bash|shell|exec|run/i.test(toolName) && command) return `Running ${summarizeCommand(command)}`;
  if (/write|edit|patch/i.test(toolName) && path) return `Editing ${shortPath(path)}`;
  return `Calling ${toolName}`;
}

function completedToolLabel(toolName: string): string {
  if (/read/i.test(toolName)) return 'Read file';
  if (/bash|shell|exec|run/i.test(toolName)) return 'Ran command';
  if (/write|edit|patch/i.test(toolName)) return 'Edited file';
  return `Called ${toolName}`;
}

function toolStatusLabel(status: TimelineTool['status']): string {
  if (status === 'running') return 'running';
  if (status === 'success') return 'done';
  return 'failed';
}

function formatToolDetail(input: unknown, output: unknown): string {
  return [input, output]
    .filter(value => value !== undefined)
    .map(value => typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    .join('\n\n');
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function eventValue(event: BaseEvent, key: string): unknown {
  return (event as unknown as Record<string, unknown>)[key];
}

function eventString(event: BaseEvent, key: string): string {
  const value = eventValue(event, key);
  return typeof value === 'string' ? value : '';
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : '';
}

function summarizeCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (/wttr\.in/i.test(compact)) return 'weather query';
  if (/python/i.test(compact)) return 'Python script';
  if (/curl/i.test(compact)) return 'network request';
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

function toggleSetItem(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function scrollToBottom(element: HTMLElement | null) {
  if (!element) return;
  window.requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}

function isPiAgentDevice(device: Device): boolean {
  return device.id === 'pi' || /pi|agent/i.test(`${device.name} ${device.activeTask?.type || ''}`);
}

function dedupePiCommands(commands: PiCommandInfo[]): PiCommandInfo[] {
  const seen = new Set<string>();
  const result: PiCommandInfo[] = [];
  for (const command of commands) {
    const name = command.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({ ...command, name });
  }
  return result;
}
