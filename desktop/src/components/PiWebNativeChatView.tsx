import { ActionIcon, Badge, Box, Group, Loader, Tooltip } from '@mantine/core';
import { ChevronLeft, ChevronRight, Copy, MessageSquareText, Plus, RefreshCw, SendHorizontal, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderPiMarkdown } from '../lib/piMarkdown';
import type { DeviceAliasSettings } from '../lib/settingsStore';
import {
  createPiWebSessionSocket,
  ensurePiWebReady,
  getPiWebMessages,
  getPiWebStatus,
  listPiWebCommands,
  listPiWebSessions,
  runPiWebCommand,
  sendPiWebPrompt,
  startPiWebSession,
  type PiWebSessionEvent,
  type PiWebSessionInfo,
  type PiWebSessionStatus,
  type PiWebSlashCommand,
} from '../lib/piWebClient';

type PiWebNativeChatViewProps = {
  piCwd: string;
  localNodeId: string;
  localDeviceLabel: string;
  userDisplayName: string;
  userAvatarSeed: string;
  agDisplayName: string;
  agAvatarSeed: string;
  deviceAliases: Record<string, DeviceAliasSettings>;
};

type TimelineMessage = {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant' | 'system';
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

type TimelineToolGroup = {
  kind: 'toolGroup';
  id: string;
  callId: string;
  label: string;
  tools: TimelineTool[];
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

type TimelineItem = TimelineMessage | TimelineReasoning | TimelineTool | TimelineToolGroup | TimelineActivity;

type TimelineRenderRow =
  | { kind: 'single'; item: TimelineItem }
  | { kind: 'assistantGroup'; id: string; statuses: TimelineItem[]; message: TimelineMessage };

type SpeakerIdentity = {
  id: string;
  label: string;
  avatar: {
    initials: string;
    background: string;
    color: string;
  };
};

const DEFAULT_WORKSPACE = '/Users/yinyin/test/AgSwarm';
const AGSWARM_SKILL_COMMANDS: PiWebSlashCommand[] = [
  {
    name: 'skill-search',
    source: 'skill',
    description: 'Search available skills',
  },
  {
    name: 'skill-create',
    source: 'skill',
    description: 'Create a new skill',
  },
];
const SYSTEM_IDENTITY: SpeakerIdentity = {
  id: 'system',
  label: 'AgSwarm',
  avatar: {
    initials: 'A',
    background: 'linear-gradient(135deg, #64748b, #334155)',
    color: '#ffffff',
  },
};

export function PiWebNativeChatView({
  piCwd,
  localNodeId,
  localDeviceLabel,
  userDisplayName,
  userAvatarSeed,
  agDisplayName,
  agAvatarSeed,
  deviceAliases,
}: PiWebNativeChatViewProps) {
  const cwd = piCwd.trim() || DEFAULT_WORKSPACE;
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<PiWebSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [status, setStatus] = useState<PiWebSessionStatus | null>(null);
  const [commands, setCommands] = useState<PiWebSlashCommand[]>([]);
  const [composerText, setComposerText] = useState('');
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  const [isBooting, setIsBooting] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');
  const paneRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId) || sessions.find(session => !session.archived) || sessions[0],
    [selectedSessionId, sessions],
  );
  const assistantLabel = agDisplayName.trim() || 'Ag';
  const displayDeviceLabel = deviceAliases[localNodeId]?.displayName?.trim() || localDeviceLabel || localNodeId;
  const assistantIdentity = useMemo<SpeakerIdentity>(() => ({
    id: localNodeId || 'local',
    label: assistantLabel,
    avatar: agentAvatar(agAvatarSeed || assistantLabel || localNodeId || 'Ag'),
  }), [agAvatarSeed, assistantLabel, localNodeId]);
  const userIdentity = useMemo<SpeakerIdentity>(() => ({
    id: 'user',
    label: userDisplayName.trim() || 'You',
    avatar: userAvatar(userAvatarSeed || userDisplayName || localDeviceLabel || localNodeId || 'user'),
  }), [localDeviceLabel, localNodeId, userAvatarSeed, userDisplayName]);

  const loadSessions = useCallback(async (options: { createIfEmpty?: boolean } = {}) => {
    setErrorText('');
    await ensurePiWebReady();
    let nextSessions = await listPiWebSessions(cwd);
    if (options.createIfEmpty && !nextSessions.some(session => !session.archived)) {
      const created = await startPiWebSession(cwd);
      nextSessions = [created, ...nextSessions];
    }
    setSessions(nextSessions);
    setSelectedSessionId(current => {
      if (current && nextSessions.some(session => session.id === current)) return current;
      return nextSessions.find(session => !session.archived)?.id || nextSessions[0]?.id || '';
    });
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    setIsBooting(true);
    loadSessions({ createIfEmpty: true })
      .catch(error => {
        if (!cancelled) setErrorText(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setIsBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!selectedSession) return;
    let cancelled = false;
    socketRef.current?.close();
    setTimelineItems([]);
    setStatus(null);
    setCommands([]);
    setExpandedToolIds(new Set());

    const hydrate = async () => {
      try {
        const [messages, nextStatus, nextCommands] = await Promise.all([
          getPiWebMessages(selectedSession),
          selectedSession.archived ? Promise.resolve(null) : getPiWebStatus(selectedSession),
          selectedSession.archived ? Promise.resolve([]) : listPiWebCommands(selectedSession),
        ]);
        if (cancelled) return;
        setTimelineItems(messagesToTimeline(messages.messages));
        setStatus(nextStatus);
        setCommands(nextCommands);
        if (!selectedSession.archived) {
          socketRef.current = createPiWebSessionSocket(selectedSession, event => {
            setTimelineItems(items => applyPiWebEvent(items, event));
            if (event.type === 'status.update') setStatus(event.status);
            if (event.type === 'session.name') {
              setSessions(current => current.map(session => session.id === event.sessionId ? { ...session, name: event.name } : session));
            }
          });
        }
      } catch (error) {
        if (!cancelled) setErrorText(error instanceof Error ? error.message : String(error));
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [selectedSession]);

  useEffect(() => {
    scrollToBottom(paneRef.current);
  }, [selectedSessionId, timelineItems]);

  const filteredCommands = useMemo(() => {
    const query = composerText.trimStart().replace(/^\//, '').toLowerCase();
    const merged = mergeSlashCommands(commands, AGSWARM_SKILL_COMMANDS);
    if (!query) return merged;
    return merged
      .filter(command => `${command.name} ${command.description || ''}`.toLowerCase().includes(query))
      .sort((left, right) => commandMatchRank(left, query) - commandMatchRank(right, query));
  }, [commands, composerText]);

  const createSession = useCallback(async () => {
    setIsSubmitting(true);
    setErrorText('');
    try {
      const created = await startPiWebSession(cwd);
      setSessions(current => [created, ...current.filter(session => session.id !== created.id)]);
      setSelectedSessionId(created.id);
      if (window.matchMedia('(max-width: 768px)').matches) setSessionsOpen(false);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [cwd]);

  const submit = useCallback(async () => {
    const text = composerText.trim();
    if (!text || !selectedSession || selectedSession.archived || isSubmitting) return;
    setComposerText('');
    setCommandPanelOpen(false);
    setErrorText('');
    setIsSubmitting(true);
    setTimelineItems(items => [...items, userTimelineMessage(text)]);
    try {
      const skillPrompt = agswarmSkillCommandPrompt(text);
      if (skillPrompt) {
        await sendPiWebPrompt(selectedSession, skillPrompt);
      } else if (text.startsWith('/')) {
        const result = await runPiWebCommand(selectedSession, text);
        setTimelineItems(items => applyCommandResult(items, result));
      } else {
        await sendPiWebPrompt(selectedSession, text);
      }
      setSessions(current => promoteSession(current, selectedSession.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      setTimelineItems(items => [...items, errorActivity(message)]);
    } finally {
      setIsSubmitting(false);
      window.setTimeout(() => composerRef.current?.focus(), 80);
    }
  }, [composerText, isSubmitting, selectedSession]);

  const isRunning = Boolean(status?.isStreaming || status?.isCompacting || status?.isBashRunning || isSubmitting);

  return (
    <Box className={`pi-gui-chat-shell ${sessionsOpen ? 'is-sessions-open' : 'is-sessions-collapsed'}`}>
      <button type="button" aria-label="Close chat sessions" className="pi-gui-chat-scrim" onClick={() => setSessionsOpen(false)} />
      <aside className="pi-gui-session-sidebar">
        <div className="pi-gui-sidebar-heading">
          <div className="pi-gui-device-name">{displayDeviceLabel}</div>
          <div className="pi-gui-sidebar-subtitle">Conversations</div>
        </div>
        <div className="pi-web-native-session-actions">
          <button type="button" onClick={() => void createSession()} disabled={isSubmitting}>
            <Plus size={14} />
            New session
          </button>
        </div>
        <div className="pi-web-native-session-list">
          {sessions.map(session => (
            <button
              key={session.id}
              type="button"
              className={session.id === selectedSession?.id ? 'is-active' : ''}
              onClick={() => {
                setSelectedSessionId(session.id);
                if (window.matchMedia('(max-width: 768px)').matches) setSessionsOpen(false);
              }}
            >
              <span>{session.name || session.firstMessage || 'New conversation'}</span>
              <small>{session.messageCount} messages</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="pi-gui-main">
        <header className="pi-gui-header">
          <div className="pi-gui-header-title-row">
            <Tooltip label={sessionsOpen ? 'Hide sessions' : 'Show sessions'}>
              <ActionIcon
                type="button"
                variant="subtle"
                color="gray"
                radius="xl"
                aria-label={sessionsOpen ? 'Hide chat sessions' : 'Show chat sessions'}
                onClick={() => setSessionsOpen(open => !open)}
              >
                {sessionsOpen ? <ChevronLeft size={17} /> : <MessageSquareText size={17} />}
              </ActionIcon>
            </Tooltip>
            <div className="pi-gui-title-block">
              <div className="pi-gui-title">Command</div>
              <div className="pi-gui-subtitle">
                <span>{shortPath(cwd)}</span>
              </div>
            </div>
          </div>
          <Group gap="xs" wrap="nowrap" className="pi-gui-header-actions">
            <Badge color={isRunning ? 'teal' : 'gray'} variant="light">
              {status?.isStreaming ? 'streaming' : status?.isBashRunning ? 'tool running' : isRunning ? 'running' : 'ready'}
            </Badge>
            <Tooltip label="Refresh conversations">
              <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="Refresh conversations" onClick={() => void loadSessions()}>
                <RefreshCw size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </header>

        <div ref={paneRef} className="pi-gui-timeline-pane">
          <div className="pi-gui-timeline">
            {isBooting ? (
              <div className="pi-gui-empty"><Loader size="sm" color="teal" /></div>
            ) : timelineItems.length ? buildTimelineRows(timelineItems).map(row => (
              <TimelineRow
                key={row.kind === 'single' ? row.item.id : row.id}
                row={row}
                expandedToolIds={expandedToolIds}
                assistant={assistantIdentity}
                user={userIdentity}
                onToggleTool={(callId) => setExpandedToolIds(current => toggleSetItem(current, callId))}
              />
            )) : (
              <div className="pi-gui-empty">Ask {assistantLabel} to start working in this workspace.</div>
            )}
            {errorText ? <div className="pi-gui-error">{friendlyAgSwarmError(errorText)}</div> : null}
          </div>
        </div>

        <div className="pi-gui-composer-wrap">
          {commandPanelOpen && filteredCommands.length ? (
            <div className="pi-gui-command-menu" role="listbox" aria-label={`${assistantLabel} commands`}>
              {filteredCommands.map(command => (
                <button
                  key={`${command.source}:${command.name}`}
                  type="button"
                  className="pi-gui-command"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setComposerText(`/${slashCommandName(command.name)} `);
                    setCommandPanelOpen(false);
                    window.setTimeout(() => composerRef.current?.focus(), 0);
                  }}
                >
                  <span>/{slashCommandName(command.name)}</span>
                  <small>{command.source}</small>
                  {command.description ? <em>{command.description}</em> : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="pi-gui-composer">
            <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="New session" onClick={() => void createSession()}>
              <Plus size={18} />
            </ActionIcon>
            <textarea
              ref={composerRef}
              value={composerText}
              rows={1}
              placeholder={selectedSession ? `Ask ${assistantLabel} in ${shortPath(cwd)}...` : `Starting ${assistantLabel}...`}
              disabled={!selectedSession || selectedSession.archived}
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
              disabled={!composerText.trim() || !selectedSession || isSubmitting}
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

function mergeSlashCommands(commands: PiWebSlashCommand[], additions: PiWebSlashCommand[]): PiWebSlashCommand[] {
  const byName = new Map<string, PiWebSlashCommand>();
  for (const command of additions) byName.set(slashCommandName(command.name), command);
  for (const command of commands) byName.set(slashCommandName(command.name), command);
  return Array.from(byName.values()).sort((left, right) => commandSortKey(left).localeCompare(commandSortKey(right)));
}

function commandSortKey(command: PiWebSlashCommand): string {
  const rank = command.source === 'builtin' ? '0' : command.source === 'skill' ? '1' : '2';
  return `${rank}:${slashCommandName(command.name)}`;
}

function commandMatchRank(command: PiWebSlashCommand, query: string): number {
  const name = slashCommandName(command.name).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (command.source === 'skill') return 2;
  return 3;
}

function agswarmSkillCommandPrompt(text: string): string | null {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const command = slashCommandName(rawCommand || '');
  const args = rest.join(' ').trim();
  if (command === 'skill-search') {
    return [
      'Search the available AgSwarm/pi skills for this request.',
      args ? `Query: ${args}` : 'If no query was provided, list the most relevant available skills and briefly describe when to use each one.',
    ].join('\n');
  }
  if (command === 'skill-create') {
    return [
      'Help create a new AgSwarm/pi skill from this request.',
      args ? `Skill request: ${args}` : 'Ask for the intended skill name, trigger conditions, workflow steps, and verification behavior before drafting the skill.',
    ].join('\n');
  }
  return null;
}

function TimelineRow({
  row,
  assistant,
  user,
  expandedToolIds,
  onToggleTool,
}: {
  row: TimelineRenderRow;
  assistant: SpeakerIdentity;
  user: SpeakerIdentity;
  expandedToolIds: Set<string>;
  onToggleTool: (callId: string) => void;
}) {
  if (row.kind === 'assistantGroup') {
    return (
      <MessageRow
        message={row.message}
        speaker={assistant}
        statusItems={row.statuses}
        expandedToolIds={expandedToolIds}
        onToggleTool={onToggleTool}
      />
    );
  }
  const item = row.item;
  if (item.kind === 'message') {
    const speaker = item.role === 'user' ? user : item.role === 'assistant' ? assistant : SYSTEM_IDENTITY;
    return (
      <MessageRow
        message={item}
        speaker={speaker}
        expandedToolIds={expandedToolIds}
        onToggleTool={onToggleTool}
      />
    );
  }
  return <StatusItem item={item} expandedToolIds={expandedToolIds} onToggleTool={onToggleTool} loose />;
}

function MessageRow({
  message,
  speaker,
  statusItems = [],
  expandedToolIds,
  onToggleTool,
}: {
  message: TimelineMessage;
  speaker: SpeakerIdentity;
  statusItems?: TimelineItem[];
  expandedToolIds: Set<string>;
  onToggleTool: (callId: string) => void;
}) {
  return (
    <article className={`pi-gui-item pi-gui-message pi-gui-message-${message.role}`}>
      <div className="pi-gui-avatar" style={{ background: speaker.avatar.background, color: speaker.avatar.color }} aria-hidden="true">
        {speaker.avatar.initials}
      </div>
      <div className="pi-gui-message-content">
        <div className="pi-gui-speaker">{speaker.label}</div>
        {statusItems.length ? (
          <div className="pi-gui-message-status-stack">
            {statusItems.map(statusItem => (
              <StatusItem
                key={statusItem.id}
                item={statusItem}
                expandedToolIds={expandedToolIds}
                onToggleTool={onToggleTool}
              />
            ))}
          </div>
        ) : null}
        <div className="pi-gui-bubble">
          <Markdown text={message.text} />
        </div>
        {message.role === 'assistant' ? (
          <button className="pi-gui-copy" type="button" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(message.text)}>
            <Copy size={13} />
          </button>
        ) : null}
      </div>
    </article>
  );
}

function StatusItem({
  item,
  expandedToolIds,
  onToggleTool,
  loose = false,
}: {
  item: TimelineItem;
  expandedToolIds: Set<string>;
  onToggleTool: (callId: string) => void;
  loose?: boolean;
}) {
  if (item.kind === 'message') return null;
  if (item.kind === 'reasoning') {
    return (
      <details className={`${loose ? 'pi-gui-status-loose ' : ''}pi-gui-reasoning`} open={item.status === 'running'}>
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
    const expanded = expandedToolIds.has(item.callId);
    return (
      <article className={`${loose ? 'pi-gui-status-loose ' : ''}pi-gui-tool pi-gui-tool-${item.status}`}>
        <button type="button" className="pi-gui-tool-header" disabled={!hasDetail} aria-expanded={expanded} onClick={() => onToggleTool(item.callId)}>
          {hasDetail ? <ChevronRight className={expanded ? 'is-expanded' : ''} size={15} /> : <Wrench size={14} />}
          <span>{item.label}</span>
          <small>{item.toolName} · {toolStatusLabel(item.status)}</small>
        </button>
        {expanded && hasDetail ? <pre className="pi-gui-tool-detail">{formatToolDetail(item.input, item.output)}</pre> : null}
      </article>
    );
  }
  if (item.kind === 'toolGroup') {
    const expanded = expandedToolIds.has(item.callId);
    return (
      <article className={`${loose ? 'pi-gui-status-loose ' : ''}pi-gui-tool pi-gui-tool-success`}>
        <button type="button" className="pi-gui-tool-header" aria-expanded={expanded} onClick={() => onToggleTool(item.callId)}>
          <ChevronRight className={expanded ? 'is-expanded' : ''} size={15} />
          <span>{item.label}</span>
          <small>{summarizeToolGroup(item.tools)}</small>
        </button>
        {expanded ? (
          <div className="pi-gui-tool-group-detail">
            {item.tools.map(tool => (
              <pre key={tool.callId} className="pi-gui-tool-detail">{tool.label}{'\n\n'}{formatToolDetail(tool.input, tool.output)}</pre>
            ))}
          </div>
        ) : null}
      </article>
    );
  }
  return (
    <div className={`${loose ? 'pi-gui-status-loose ' : ''}pi-gui-activity ${item.tone === 'error' ? 'is-error' : ''}`}>
      <span>{item.label}</span>
      {item.detail ? <small>{item.detail}</small> : null}
    </div>
  );
}

function buildTimelineRows(items: TimelineItem[]): TimelineRenderRow[] {
  const rows: TimelineRenderRow[] = [];
  let pendingStatuses: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === 'message') {
      if (item.role === 'assistant' && pendingStatuses.length) {
        rows.push({
          kind: 'assistantGroup',
          id: `${item.id}-with-status`,
          statuses: pendingStatuses,
          message: item,
        });
        pendingStatuses = [];
      } else {
        if (pendingStatuses.length) {
          rows.push(...pendingStatuses.map(status => ({ kind: 'single' as const, item: status })));
          pendingStatuses = [];
        }
        rows.push({ kind: 'single', item });
      }
    } else {
      pendingStatuses.push(item);
    }
  }
  if (pendingStatuses.length) {
    rows.push(...pendingStatuses.map(status => ({ kind: 'single' as const, item: status })));
  }
  return rows;
}

function applyPiWebEvent(items: TimelineItem[], event: PiWebSessionEvent): TimelineItem[] {
  const now = new Date().toISOString();
  if (event.type === 'message.append') return mergeAppendedMessage(items, messagesToTimeline([event.message]));
  if (event.type === 'assistant.delta') {
    const lastAssistant = [...items].reverse().find(item => item.kind === 'message' && item.role === 'assistant' && item.id.startsWith('assistant-stream-')) as TimelineMessage | undefined;
    const item: TimelineMessage = lastAssistant
      ? { ...lastAssistant, text: lastAssistant.text + event.text }
      : { kind: 'message', id: `assistant-stream-${crypto.randomUUID()}`, role: 'assistant', text: event.text, createdAt: now };
    return upsertTimeline(items, item);
  }
  if (event.type === 'assistant.thinking.delta') {
    const lastReasoning = [...items].reverse().find(item => item.kind === 'reasoning' && item.status === 'running') as TimelineReasoning | undefined;
    const item: TimelineReasoning = lastReasoning
      ? { ...lastReasoning, text: lastReasoning.text + event.text }
      : { kind: 'reasoning', id: `reasoning-${crypto.randomUUID()}`, text: event.text, status: 'running', createdAt: now };
    return upsertTimeline(items, item);
  }
  if (event.type === 'tool.start') {
    const callId = event.toolCallId || `tool-${crypto.randomUUID()}`;
    return collapseCompletedTools(upsertTimeline(closeRunningReasoning(items), {
      kind: 'tool',
      id: `tool-${callId}`,
      callId,
      toolName: event.toolName || 'tool',
      label: runningToolLabel(event.toolName, event.args, event.summary),
      status: 'running',
      input: event.args,
      createdAt: now,
    }));
  }
  if (event.type === 'tool.update' || event.type === 'tool.end') {
    const existing = items.find(item => item.kind === 'tool' && item.callId === event.toolCallId) as TimelineTool | undefined;
    if (!existing) return items;
    return collapseCompletedTools(upsertTimeline(items, {
      ...existing,
      status: event.type === 'tool.end' ? event.isError ? 'error' : 'success' : existing.status,
      label: event.type === 'tool.end' ? completedToolLabel(event.toolName) : existing.label,
      output: event.content ?? event.text ?? event.details,
    }));
  }
  if (event.type === 'shell.start') {
    const callId = `shell-${crypto.randomUUID()}`;
    return collapseCompletedTools([...closeRunningReasoning(items), {
      kind: 'tool',
      id: `tool-${callId}`,
      callId,
      toolName: 'shell',
      label: `Running ${summarizeCommand(event.command)}`,
      status: 'running',
      input: { command: event.command },
      createdAt: now,
    }]);
  }
  if (event.type === 'shell.chunk' || event.type === 'shell.end') {
    const existing = [...items].reverse().find(item => item.kind === 'tool' && item.toolName === 'shell' && item.status === 'running') as TimelineTool | undefined;
    if (!existing) return items;
    const nextOutput = event.type === 'shell.chunk'
      ? `${typeof existing.output === 'string' ? existing.output : ''}${event.chunk}`
      : event.output ?? existing.output;
    return collapseCompletedTools(upsertTimeline(items, {
      ...existing,
      status: event.type === 'shell.end' ? event.isError || (event.exitCode ?? 0) !== 0 ? 'error' : 'success' : 'running',
      label: event.type === 'shell.end' ? completedToolLabel('shell') : existing.label,
      output: nextOutput,
    }));
  }
  if (event.type === 'command.output' || event.type === 'session.error') {
    const message = event.type === 'session.error' ? friendlyAgSwarmError(event.message) : event.message;
    return [...items, {
      kind: 'activity',
      id: `activity-${crypto.randomUUID()}`,
      label: event.type === 'session.error' ? 'Ag is unavailable' : message,
      detail: event.type === 'session.error' ? message : undefined,
      tone: event.type === 'session.error' || event.level === 'error' ? 'error' : 'neutral',
      createdAt: now,
    }];
  }
  if (event.type === 'message.end') {
    if (event.message === undefined) return closeRunningReasoning(items);
    return collapseCompletedTools(mergeFinalAssistantMessage(closeRunningReasoning(items), messagesToTimeline([event.message])));
  }
  return items;
}

function slashCommandName(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

function Markdown({ text }: { text: string }) {
  return <div className="pi-gui-markdown" dangerouslySetInnerHTML={{ __html: renderPiMarkdown(text) }} />;
}

function messagesToTimeline(messages: unknown[]): TimelineItem[] {
  return messages.flatMap((message, index) => messageToTimeline(message, index));
}

function messageToTimeline(message: unknown, index: number): TimelineItem[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : 'system';
  if (role === 'assistant' || role === 'user') {
    const createdAt = new Date(index).toISOString();
    const parts = messageContentParts(record);
    const text = parts.text.join('\n').trim();
    const reasoning = parts.thinking.join('\n').trim();
    const timeline = [
      reasoning ? { kind: 'reasoning', id: String(record.id || `${role}-${index}-reasoning`), text: reasoning, status: 'complete', createdAt } as TimelineReasoning : null,
      text ? { kind: 'message', id: String(record.id || `${role}-${index}`), role, text, createdAt } as TimelineMessage : null,
    ];
    return timeline.filter((item): item is TimelineMessage | TimelineReasoning => item !== null);
  }
  if (role === 'toolResult') {
    return [{
      kind: 'tool',
      id: `tool-${String(record.toolCallId || index)}`,
      callId: String(record.toolCallId || index),
      toolName: String(record.toolName || 'tool'),
      label: completedToolLabel(String(record.toolName || 'tool')),
      status: record.isError === true ? 'error' : 'success',
      output: record.content,
      createdAt: new Date(index).toISOString(),
    }];
  }
  const text = messageContentParts(record).text.join('\n').trim();
  return text ? [{ kind: 'activity', id: `message-${index}`, label: text, createdAt: new Date(index).toISOString() }] : [];
}

function messageContentParts(record: Record<string, unknown>): { text: string[]; thinking: string[] } {
  const content = record.content;
  if (typeof content === 'string') return { text: [content], thinking: [] };
  if (!Array.isArray(content)) return { text: [], thinking: [] };
  return content.reduce<{ text: string[]; thinking: string[] }>((parts, part) => {
    if (typeof part === 'string') {
      parts.text.push(part);
      return parts;
    }
    if (!part || typeof part !== 'object') return parts;
    const recordPart = part as Record<string, unknown>;
    const text = typeof recordPart.text === 'string' ? recordPart.text : '';
    if (!text) return parts;
    if (recordPart.type === 'thinking') parts.thinking.push(text);
    else if (recordPart.type === 'text' || recordPart.type === undefined) {
      const phase = textSignaturePhase(recordPart.textSignature);
      if (phase !== 'commentary') parts.text.push(text);
    }
    return parts;
  }, { text: [], thinking: [] });
}

function textSignaturePhase(value: unknown): string {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return '';
  try {
    const parsed = JSON.parse(value) as { phase?: unknown };
    return typeof parsed.phase === 'string' ? parsed.phase : '';
  } catch {
    return '';
  }
}

function userTimelineMessage(text: string): TimelineMessage {
  return { kind: 'message', id: `user-${crypto.randomUUID()}`, role: 'user', text, createdAt: new Date().toISOString() };
}

function errorActivity(message: string): TimelineActivity {
  return { kind: 'activity', id: `error-${crypto.randomUUID()}`, label: 'Ag is unavailable', detail: friendlyAgSwarmError(message), tone: 'error', createdAt: new Date().toISOString() };
}

function friendlyAgSwarmError(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return 'Ag is temporarily unavailable. Please try again.';
  if (/Load failed|Failed to fetch|NetworkError|ECONNREFUSED|connection refused|No such file or directory/i.test(text)) {
    return 'Connection paused. Refresh the conversation or restart the app if it does not recover.';
  }
  if (/502|503|provider|熔断|无可用渠道|local proxy failed|responses/i.test(text)) {
    return 'Ag reached the local model service, but the model provider is currently unavailable.';
  }
  if (/timed out|timeout/i.test(text)) {
    return 'Ag took too long to respond. The task may still be running; please retry after a moment.';
  }
  if (/session daemon unavailable|runtime did not become healthy/i.test(text)) {
    return 'Ag runtime is still starting. Please wait a moment and refresh the conversation.';
  }
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function agentAvatar(seed: string): SpeakerIdentity['avatar'] {
  const palettes = [
    ['#0f766e', '#14b8a6'],
    ['#2563eb', '#38bdf8'],
    ['#7c3aed', '#a78bfa'],
    ['#be123c', '#fb7185'],
    ['#047857', '#34d399'],
    ['#4338ca', '#818cf8'],
  ];
  const hash = stableHash(seed);
  const [from, to] = palettes[hash % palettes.length];
  return {
    initials: initialsFor(seed, 'AI'),
    background: `linear-gradient(135deg, ${from}, ${to})`,
    color: '#ffffff',
  };
}

function userAvatar(seed: string): SpeakerIdentity['avatar'] {
  return {
    initials: initialsFor(seed, 'Y'),
    background: 'linear-gradient(135deg, #f8fafc, #e2e8f0)',
    color: '#0f172a',
  };
}

function initialsFor(value: string, fallback: string): string {
  const compact = value.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!compact) return fallback;
  const parts = compact.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
  return compact.slice(0, 2).toUpperCase();
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function applyCommandResult(items: TimelineItem[], result: unknown): TimelineItem[] {
  if (!result || typeof result !== 'object') return items;
  const record = result as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : '';
  if (!message) return items;
  return [...items, { kind: 'activity', id: `command-${crypto.randomUUID()}`, label: message, createdAt: new Date().toISOString() }];
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

function mergeAppendedMessage(left: TimelineItem[], right: TimelineItem[]): TimelineItem[] {
  const userMessage = right.find(item => item.kind === 'message' && item.role === 'user') as TimelineMessage | undefined;
  if (!userMessage) return mergeTimelineItems(left, right);
  const withoutOptimisticDuplicate = left.filter(item => (
    !(item.kind === 'message' && item.role === 'user' && item.id.startsWith('user-') && item.text === userMessage.text)
  ));
  return mergeTimelineItems(withoutOptimisticDuplicate, right);
}

function mergeFinalAssistantMessage(left: TimelineItem[], right: TimelineItem[]): TimelineItem[] {
  const hasAssistantMessage = right.some(item => item.kind === 'message' && item.role === 'assistant');
  const base = hasAssistantMessage
    ? left.filter(item => !(item.kind === 'message' && item.role === 'assistant' && item.id.startsWith('assistant-stream-')))
    : left;
  return mergeTimelineItems(base, right);
}

function closeRunningReasoning(items: TimelineItem[]): TimelineItem[] {
  return items.map(item => item.kind === 'reasoning' && item.status === 'running' ? { ...item, status: 'complete' } : item);
}

function collapseCompletedTools(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  const pendingTools: TimelineTool[] = [];
  const flush = () => {
    if (!pendingTools.length) return;
    if (pendingTools.length === 1) {
      result.push(pendingTools[0]);
    } else {
      result.push({
        kind: 'toolGroup',
        id: `tools-${pendingTools.map(tool => tool.callId).join('-')}`,
        callId: `tools-${pendingTools.map(tool => tool.callId).join('-')}`,
        label: `已调用 ${pendingTools.length} 个工具`,
        tools: [...pendingTools],
        createdAt: pendingTools[0].createdAt,
      });
    }
    pendingTools.length = 0;
  };
  for (const item of items) {
    if (item.kind === 'tool' && item.status === 'success') {
      pendingTools.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

function summarizeToolGroup(tools: TimelineTool[]): string {
  const names = Array.from(new Set(tools.map(tool => tool.toolName || 'tool')));
  return names.slice(0, 3).join('、');
}

function promoteSession(sessions: PiWebSessionInfo[], sessionId: string): PiWebSessionInfo[] {
  const session = sessions.find(item => item.id === sessionId);
  return session ? [session, ...sessions.filter(item => item.id !== sessionId)] : sessions;
}

function runningToolLabel(toolName: string, args: unknown, summary = ''): string {
  const command = stringField(args, 'command') || stringField(args, 'cmd');
  const path = stringField(args, 'path') || stringField(args, 'file_path') || stringField(args, 'filePath');
  if (/read/i.test(toolName) && path) return `Reading ${shortPath(path)}`;
  if (/bash|shell|exec|run/i.test(toolName) && command) return `Running ${summarizeCommand(command)}`;
  if (/write|edit|patch/i.test(toolName) && path) return `Editing ${shortPath(path)}`;
  return summary || `Calling ${toolName}`;
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
  return [input, output].filter(value => value !== undefined).map(value => typeof value === 'string' ? value : JSON.stringify(value, null, 2)).join('\n\n');
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
