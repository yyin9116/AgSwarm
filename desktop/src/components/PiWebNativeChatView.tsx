import { ActionIcon, Badge, Box, Group, Loader, Tooltip } from '@mantine/core';
import { ChevronLeft, ChevronRight, Copy, FileUp, MessageSquareText, PanelTop, Plus, RefreshCw, SendHorizontal, Square, Wrench, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderPiMarkdown } from '../lib/piMarkdown';
import type { DeviceAliasSettings } from '../lib/settingsStore';
import { saveChatAttachment, stageChatAttachment } from '../lib/agswarmApi';
import type { StagedChatAttachment } from '../types/agswarm';
import type { Device } from './DevicesView';
import { PiWebCapabilityPanel } from './PiWebCapabilityPanel';
import {
  abortPiWebSession,
  createPiWebSessionSocket,
  ensurePiWebReady,
  getPiWebMessages,
  getPiWebStatus,
  listPiWebCommands,
  listPiWebModels,
  listPiWebSessions,
  listPiWebThinkingLevels,
  resolvePiWebWorkspace,
  runPiWebCommand,
  sendPiWebPrompt,
  startPiWebSession,
  type PiWebCommandResult,
  type PiWebSessionEvent,
  type PiWebSessionInfo,
  type PiWebSessionModel,
  type PiWebSessionStatus,
  type PiWebSlashCommand,
  type PiWebThinkingLevel,
  type PiWebWorkspaceContext,
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
  devices: Device[];
  deviceStatusMessage: string;
  externalAttachmentDrop?: { id: number; paths: string[] } | null;
  externalActivity?: { id: number; label: string; detail?: string; tone?: 'neutral' | 'error' } | null;
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
type PendingAttachment = StagedChatAttachment & { id: string };

type PendingCommandSelect = Extract<PiWebCommandResult, { type: 'select' }>;

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
  devices,
  deviceStatusMessage,
  externalAttachmentDrop,
  externalActivity,
}: PiWebNativeChatViewProps) {
  const cwd = piCwd.trim();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<PiWebSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [status, setStatus] = useState<PiWebSessionStatus | null>(null);
  const [commands, setCommands] = useState<PiWebSlashCommand[]>([]);
  const [models, setModels] = useState<PiWebSessionModel[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<PiWebThinkingLevel[]>([]);
  const [composerText, setComposerText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false);
  const [pendingCommandSelect, setPendingCommandSelect] = useState<PendingCommandSelect | null>(null);
  const [workspaceContext, setWorkspaceContext] = useState<PiWebWorkspaceContext | null>(null);
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAwaitingAgent, setIsAwaitingAgent] = useState(false);
  const [errorText, setErrorText] = useState('');
  const paneRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
    if (!isAbsoluteWorkspacePath(cwd)) {
      throw new Error('Choose an absolute Host Working Directory in Settings before starting a conversation.');
    }
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

  const attachPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    if (!uniquePaths.length) return;
    setErrorText('');
    try {
      const staged = await Promise.all(uniquePaths.map(sourcePath => stageChatAttachment({
        sourcePath,
        workspaceRoot: cwd,
      })));
      setAttachments(current => mergeAttachments(current, staged.map(item => ({
        ...item,
        id: crypto.randomUUID(),
      }))));
      window.setTimeout(() => composerRef.current?.focus(), 40);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [cwd]);

  const attachFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setErrorText('');
    try {
      const staged = await Promise.all(files.map(async file => {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        return saveChatAttachment({
          name: file.name || 'attachment',
          workspaceRoot: cwd,
          bytes,
        });
      }));
      setAttachments(current => mergeAttachments(current, staged.map(item => ({
        ...item,
        id: crypto.randomUUID(),
      }))));
      window.setTimeout(() => composerRef.current?.focus(), 40);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [cwd]);

  const chooseAttachments = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  useEffect(() => {
    if (!externalAttachmentDrop?.paths.length) return;
    void attachPaths(externalAttachmentDrop.paths);
  }, [attachPaths, externalAttachmentDrop]);

  useEffect(() => {
    if (!externalActivity) return;
    setTimelineItems(items => [...items, {
      kind: 'activity',
      id: `external-${externalActivity.id}`,
      label: externalActivity.label,
      detail: externalActivity.detail,
      tone: externalActivity.tone || 'neutral',
      createdAt: new Date().toISOString(),
    }]);
  }, [externalActivity]);

  const refreshSessionSnapshot = useCallback(async (session: PiWebSessionInfo) => {
    const [messages, nextStatus] = await Promise.all([
      getPiWebMessages(session),
      session.archived ? Promise.resolve(null) : getPiWebStatus(session),
    ]);
    setTimelineItems(current => mergeSnapshotTimeline(current, messagesToTimeline(messages.messages)));
    setStatus(nextStatus);
    return { messages, status: nextStatus };
  }, []);

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
    setModels([]);
    setThinkingLevels([]);
    setWorkspaceContext(null);
    setPendingCommandSelect(null);
    setExpandedToolId(null);

    const hydrate = async () => {
      try {
        const [messages, nextStatus, nextCommands, nextModels, nextThinkingLevels, nextWorkspaceContext] = await Promise.all([
          getPiWebMessages(selectedSession),
          selectedSession.archived ? Promise.resolve(null) : getPiWebStatus(selectedSession),
          selectedSession.archived ? Promise.resolve([]) : listPiWebCommands(selectedSession),
          selectedSession.archived ? Promise.resolve([]) : listPiWebModels(selectedSession),
          selectedSession.archived ? Promise.resolve([]) : listPiWebThinkingLevels(selectedSession),
          resolvePiWebWorkspace(selectedSession.cwd).catch(() => null),
        ]);
        if (cancelled) return;
        setTimelineItems(messagesToTimeline(messages.messages));
        setStatus(nextStatus);
        setCommands(nextCommands);
        setModels(nextModels);
        setThinkingLevels(nextThinkingLevels);
        setWorkspaceContext(nextWorkspaceContext);
        if (!selectedSession.archived) {
          socketRef.current = createPiWebSessionSocket(selectedSession, event => {
            setTimelineItems(items => applyPiWebEvent(items, event));
            if (event.type === 'status.update') setStatus(event.status);
            if (
              event.type === 'agent.start'
              || event.type === 'assistant.delta'
              || event.type === 'assistant.thinking.delta'
              || event.type === 'tool.start'
              || event.type === 'shell.start'
              || event.type === 'message.append'
            ) {
              setIsAwaitingAgent(false);
            }
            if (event.type === 'agent.end' || event.type === 'message.end' || event.type === 'session.error') {
              setIsAwaitingAgent(false);
              if (event.type === 'message.end') void refreshSessionSnapshot(selectedSession).catch(() => undefined);
            }
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
  }, [refreshSessionSnapshot, selectedSession]);

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

  const pushActivity = useCallback((label: string, detail?: string, tone: TimelineActivity['tone'] = 'neutral') => {
    setTimelineItems(items => [...items, {
      kind: 'activity',
      id: `ui-${crypto.randomUUID()}`,
      label,
      detail,
      tone,
      createdAt: new Date().toISOString(),
    }]);
  }, []);

  const applyCommandResultToTimeline = useCallback((result: PiWebCommandResult) => {
    if (result.type === 'select') {
      setPendingCommandSelect(result);
      pushActivity(result.title, `${result.options.length} options available`);
      return;
    }
    if (result.message) pushActivity(result.message);
    if ('promptDraft' in result && result.promptDraft) setComposerText(result.promptDraft);
  }, [pushActivity]);

  const submit = useCallback(async () => {
    const text = composerText.trim();
    if ((!text && !attachments.length) || selectedSession?.archived || isSubmitting) return;
    const submittedAttachments = attachments;
    const visibleText = text || attachmentOnlyPrompt(submittedAttachments);
    setComposerText('');
    setAttachments([]);
    setCommandPanelOpen(false);
    setErrorText('');
    setIsSubmitting(true);
    setTimelineItems(items => [...items, userTimelineMessage(withAttachmentSummary(visibleText, submittedAttachments))]);
    try {
      let session = selectedSession;
      if (!session) {
        await ensurePiWebReady();
        const created = await startPiWebSession(cwd);
        setSessions(current => [created, ...current.filter(item => item.id !== created.id)]);
        setSelectedSessionId(created.id);
        session = created;
      }
      const promptText = withAttachmentPrompt(visibleText, submittedAttachments);
      const prompt = withAgSwarmRuntimeContext(promptText, {
        devices,
        deviceStatusMessage,
        localNodeId,
        localDeviceLabel: displayDeviceLabel,
      });
      const skillPrompt = agswarmSkillCommandPrompt(visibleText);
      if (skillPrompt) {
        await sendPiWebPrompt(session, withAgSwarmRuntimeContext(skillPrompt, {
          devices,
          deviceStatusMessage,
          localNodeId,
          localDeviceLabel: displayDeviceLabel,
        }));
        setIsAwaitingAgent(true);
      } else if (visibleText.startsWith('/')) {
        const result = await runPiWebCommand(session, visibleText);
        applyCommandResultToTimeline(result);
      } else {
        await sendPiWebPrompt(session, prompt);
        setIsAwaitingAgent(true);
      }
      setSessions(current => promoteSession(current, session.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      setTimelineItems(items => [...items, errorActivity(message)]);
    } finally {
      setIsSubmitting(false);
      window.setTimeout(() => composerRef.current?.focus(), 80);
    }
  }, [applyCommandResultToTimeline, attachments, composerText, cwd, deviceStatusMessage, devices, displayDeviceLabel, isSubmitting, localNodeId, selectedSession]);

  const isRunning = Boolean(status?.isStreaming || status?.isCompacting || status?.isBashRunning || isSubmitting || isAwaitingAgent);
  const canStop = Boolean(selectedSession && !selectedSession.archived && (
    status?.isStreaming
    || status?.isCompacting
    || status?.isBashRunning
    || (status?.pendingMessageCount || 0) > 0
    || isSubmitting
    || isAwaitingAgent
  ));

  const stopActiveWork = useCallback(async () => {
    if (!selectedSession || selectedSession.archived) return;
    setErrorText('');
    try {
      await abortPiWebSession(selectedSession);
      setTimelineItems(items => closeRunningReasoning(markRunningToolsStopped(items)));
      const nextStatus = await getPiWebStatus(selectedSession).catch(() => null);
      setStatus(nextStatus);
      setIsSubmitting(false);
      setIsAwaitingAgent(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      setTimelineItems(items => [...items, errorActivity(message)]);
    } finally {
      window.setTimeout(() => composerRef.current?.focus(), 80);
    }
  }, [selectedSession]);

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

      <section
        className="pi-gui-main"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setIsDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setIsDraggingFiles(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setIsDraggingFiles(false);
          void attachFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {isDraggingFiles ? (
          <div className="pi-gui-drop-overlay">
            <FileUp size={22} />
            <span>Drop files to attach</span>
          </div>
        ) : null}
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
              {status?.isStreaming ? 'streaming' : status?.isBashRunning ? 'tool running' : isAwaitingAgent ? 'starting' : isRunning ? 'running' : 'ready'}
            </Badge>
            <Tooltip label={toolsPanelOpen ? 'Hide Pi Web tools' : 'Show Pi Web tools'}>
              <ActionIcon
                variant={toolsPanelOpen ? 'light' : 'subtle'}
                color={toolsPanelOpen ? 'teal' : 'gray'}
                radius="xl"
                aria-label={toolsPanelOpen ? 'Hide Pi Web tools' : 'Show Pi Web tools'}
                onClick={() => setToolsPanelOpen(open => !open)}
              >
                <PanelTop size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Refresh conversations">
              <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="Refresh conversations" onClick={() => void loadSessions()}>
                <RefreshCw size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </header>

        {toolsPanelOpen ? (
          <PiWebCapabilityPanel
            session={selectedSession}
            cwd={cwd}
            status={status}
            models={models}
            thinkingLevels={thinkingLevels}
            workspaceContext={workspaceContext}
            pendingCommandSelect={pendingCommandSelect}
            onPendingCommandSelectChange={setPendingCommandSelect}
            onStatusChange={setStatus}
            onActivity={pushActivity}
            onCommandResult={applyCommandResultToTimeline}
            onError={setErrorText}
          />
        ) : null}

        <div ref={paneRef} className="pi-gui-timeline-pane">
          <div className="pi-gui-timeline">
            {isBooting ? (
              <div className="pi-gui-empty"><Loader size="sm" color="teal" /></div>
            ) : timelineItems.length ? buildTimelineRows(timelineItems).map(row => (
              <TimelineRow
                key={row.kind === 'single' ? row.item.id : row.id}
                row={row}
                expandedToolId={expandedToolId}
                assistant={assistantIdentity}
                user={userIdentity}
                onToggleTool={(callId) => setExpandedToolId(current => current === callId ? null : callId)}
              />
            )) : (
              <div className="pi-gui-empty">Ask {assistantLabel} to start working in this workspace.</div>
            )}
            {errorText ? (
              <div className="pi-gui-error" role="status">
                <span>{friendlyAgSwarmError(errorText)}</span>
                <button type="button" onClick={() => void loadSessions({ createIfEmpty: true })}>
                  Retry
                </button>
              </div>
            ) : null}
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
          {attachments.length ? (
            <div className="pi-gui-attachments" aria-label="Attached files">
              {attachments.map(attachment => (
                <div key={attachment.id} className="pi-gui-attachment-chip">
                  <FileUp size={14} />
                  <span>{attachment.name}</span>
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="pi-gui-composer">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="pi-gui-file-input"
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files || []);
                event.currentTarget.value = '';
                void attachFiles(files);
              }}
            />
            <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="Attach files" onClick={() => void chooseAttachments()}>
              <Plus size={18} />
            </ActionIcon>
            <textarea
              ref={composerRef}
              value={composerText}
              rows={1}
              placeholder={selectedSession ? `Ask ${assistantLabel} in ${shortPath(cwd)}...` : `Ask ${assistantLabel} in ${shortPath(cwd)}...`}
              disabled={Boolean(selectedSession?.archived)}
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
              color={canStop ? 'gray' : 'teal'}
              radius="xl"
              aria-label={canStop ? 'Stop' : 'Send'}
              disabled={!canStop && ((!composerText.trim() && !attachments.length) || Boolean(selectedSession?.archived))}
              onClick={() => {
                if (canStop) void stopActiveWork();
                else void submit();
              }}
            >
              {canStop ? <Square size={15} fill="currentColor" /> : <SendHorizontal size={18} />}
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
  expandedToolId,
  onToggleTool,
}: {
  row: TimelineRenderRow;
  assistant: SpeakerIdentity;
  user: SpeakerIdentity;
  expandedToolId: string | null;
  onToggleTool: (callId: string) => void;
}) {
  if (row.kind === 'assistantGroup') {
    return (
      <MessageRow
        message={row.message}
        speaker={assistant}
        statusItems={row.statuses}
        expandedToolId={expandedToolId}
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
        expandedToolId={expandedToolId}
        onToggleTool={onToggleTool}
      />
    );
  }
  return <StatusItem item={item} expandedToolId={expandedToolId} onToggleTool={onToggleTool} loose />;
}

function MessageRow({
  message,
  speaker,
  statusItems = [],
  expandedToolId,
  onToggleTool,
}: {
  message: TimelineMessage;
  speaker: SpeakerIdentity;
  statusItems?: TimelineItem[];
  expandedToolId: string | null;
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
                expandedToolId={expandedToolId}
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
  expandedToolId,
  onToggleTool,
  loose = false,
}: {
  item: TimelineItem;
  expandedToolId: string | null;
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
    const expanded = expandedToolId === item.callId;
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
    const expanded = expandedToolId === item.callId || item.tools.some(tool => expandedToolId === nestedToolDetailId(tool.callId));
    return (
      <article className={`${loose ? 'pi-gui-status-loose ' : ''}pi-gui-tool pi-gui-tool-success`}>
        <button type="button" className="pi-gui-tool-header" aria-expanded={expanded} onClick={() => onToggleTool(item.callId)}>
          <ChevronRight className={expanded ? 'is-expanded' : ''} size={15} />
          <span>{item.label}</span>
          <small>{summarizeToolGroup(item.tools)}</small>
        </button>
        {expanded ? (
          <div className="pi-gui-tool-group-detail">
            {item.tools.map((tool, index) => (
              <ToolGroupDetailRow
                key={tool.callId}
                tool={tool}
                index={index}
                expandedToolId={expandedToolId}
                onToggleTool={onToggleTool}
              />
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

function ToolGroupDetailRow({
  tool,
  index,
  expandedToolId,
  onToggleTool,
}: {
  tool: TimelineTool;
  index: number;
  expandedToolId: string | null;
  onToggleTool: (callId: string) => void;
}) {
  const hasDetail = tool.input !== undefined || tool.output !== undefined;
  const detailId = nestedToolDetailId(tool.callId);
  const expanded = expandedToolId === detailId;
  return (
    <div className={`pi-gui-tool-group-row pi-gui-tool-${tool.status}`}>
      <button
        type="button"
        className="pi-gui-tool-header"
        disabled={!hasDetail}
        aria-expanded={expanded}
        onClick={() => onToggleTool(detailId)}
      >
        {hasDetail ? <ChevronRight className={expanded ? 'is-expanded' : ''} size={15} /> : <Wrench size={14} />}
        <span>{index + 1}. {tool.label}</span>
        <small>{tool.toolName} · {toolStatusLabel(tool.status)}</small>
      </button>
      {expanded && hasDetail ? <pre className="pi-gui-tool-detail">{formatToolDetail(tool.input, tool.output)}</pre> : null}
    </div>
  );
}

function buildTimelineRows(items: TimelineItem[]): TimelineRenderRow[] {
  const rows: TimelineRenderRow[] = [];
  let pendingStatuses: TimelineItem[] = [];
  for (const item of compactTimelineItems(items)) {
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
    const lastAssistantIndex = findLastAssistantRowIndex(rows);
    if (lastAssistantIndex >= 0) {
      const row = rows[lastAssistantIndex];
      const message = assistantMessageFromRow(row);
      if (!message) {
        rows.push(...pendingStatuses.map(status => ({ kind: 'single' as const, item: status })));
        return rows;
      }
      const existingStatuses = row.kind === 'assistantGroup' ? row.statuses : [];
      rows[lastAssistantIndex] = {
        kind: 'assistantGroup',
        id: `${message.id}-with-status`,
        statuses: mergeStatusItems(existingStatuses, pendingStatuses),
        message,
      };
    } else {
      rows.push(...pendingStatuses.map(status => ({ kind: 'single' as const, item: status })));
    }
  }
  return rows;
}

function assistantMessageFromRow(row: TimelineRenderRow): TimelineMessage | null {
  if (row.kind === 'assistantGroup') return row.message;
  return row.item.kind === 'message' && row.item.role === 'assistant' ? row.item : null;
}

function findLastAssistantRowIndex(rows: TimelineRenderRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'assistantGroup') return index;
    if (row.item.kind === 'message' && row.item.role === 'assistant') return index;
  }
  return -1;
}

function mergeStatusItems(left: TimelineItem[], right: TimelineItem[]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const item of [...left, ...right]) byId.set(item.id, item);
  return Array.from(byId.values());
}

function applyPiWebEvent(items: TimelineItem[], event: PiWebSessionEvent): TimelineItem[] {
  const now = new Date().toISOString();
  if (event.type === 'agent.start') return compactTimelineItems(closeOpenStream(items));
  if (event.type === 'agent.end') return closeRunningReasoning(items);
  if (event.type === 'message.append') return compactTimelineItems(mergeAppendedMessage(items, messagesToTimeline([event.message], items.length)));
  if (event.type === 'assistant.delta') {
    const lastAssistant = [...items].reverse().find(item => item.kind === 'message' && item.role === 'assistant' && item.id.startsWith('assistant-stream-')) as TimelineMessage | undefined;
    const item: TimelineMessage = lastAssistant
      ? { ...lastAssistant, text: lastAssistant.text + event.text }
      : { kind: 'message', id: `assistant-stream-${crypto.randomUUID()}`, role: 'assistant', text: event.text, createdAt: now };
    return compactTimelineItems(upsertTimeline(items, item));
  }
  if (event.type === 'assistant.thinking.delta') {
    const lastReasoning = [...items].reverse().find(item => item.kind === 'reasoning' && item.status === 'running') as TimelineReasoning | undefined;
    const item: TimelineReasoning = lastReasoning
      ? { ...lastReasoning, text: lastReasoning.text + event.text }
      : { kind: 'reasoning', id: `reasoning-${crypto.randomUUID()}`, text: event.text, status: 'running', createdAt: now };
    return compactTimelineItems(upsertTimeline(items, item));
  }
  if (event.type === 'tool.start') {
    const callId = event.toolCallId || `tool-${crypto.randomUUID()}`;
    return compactTimelineItems(upsertTimeline(closeRunningReasoning(items), {
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
    return compactTimelineItems(upsertTimeline(items, {
      ...existing,
      status: event.type === 'tool.end' ? event.isError ? 'error' : 'success' : existing.status,
      label: event.type === 'tool.end' ? completedToolLabel(event.toolName) : existing.label,
      output: event.content ?? event.text ?? event.details,
    }));
  }
  if (event.type === 'shell.start') {
    const callId = `shell-${crypto.randomUUID()}`;
    return compactTimelineItems([...closeRunningReasoning(items), {
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
    return compactTimelineItems(upsertTimeline(items, {
      ...existing,
      status: event.type === 'shell.end' ? event.isError || (event.exitCode ?? 0) !== 0 ? 'error' : 'success' : 'running',
      label: event.type === 'shell.end' ? completedToolLabel('shell') : existing.label,
      output: nextOutput,
    }));
  }
  if (event.type === 'command.output' || event.type === 'session.error') {
    const message = event.type === 'session.error' ? friendlyAgSwarmError(event.message) : event.message;
    return compactTimelineItems([...items, {
      kind: 'activity',
      id: `activity-${crypto.randomUUID()}`,
      label: event.type === 'session.error' ? 'Ag is unavailable' : message,
      detail: event.type === 'session.error' ? message : undefined,
      tone: event.type === 'session.error' || event.level === 'error' ? 'error' : 'neutral',
      createdAt: now,
    }]);
  }
  if (event.type === 'message.end') {
    if (event.message === undefined) return closeRunningReasoning(items);
    const closedItems = closeRunningReasoning(items);
    return compactTimelineItems(mergeFinalAssistantMessage(closedItems, messagesToTimeline([event.message], closedItems.length)));
  }
  return items;
}

function slashCommandName(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

function mergeAttachments(current: PendingAttachment[], incoming: PendingAttachment[]): PendingAttachment[] {
  const seen = new Set(current.map(item => item.stagedPath));
  return [
    ...current,
    ...incoming.filter(item => {
      if (seen.has(item.stagedPath)) return false;
      seen.add(item.stagedPath);
      return true;
    }),
  ];
}

function attachmentOnlyPrompt(attachments: PendingAttachment[]): string {
  return attachments.length === 1 ? `请查看附件 ${attachments[0].name}` : `请查看这 ${attachments.length} 个附件`;
}

function withAttachmentSummary(text: string, attachments: PendingAttachment[]): string {
  if (!attachments.length) return text;
  return [
    text,
    '',
    attachments.map(attachment => `附件：${attachment.name} (${attachment.relativePath})`).join('\n'),
  ].join('\n').trim();
}

function withAttachmentPrompt(text: string, attachments: PendingAttachment[]): string {
  if (!attachments.length) return text;
  return [
    '<agswarm_attachments trusted="true">',
    'The user attached these files through the AgSwarm desktop app. Paths are relative to the current workspace unless absolutePath is explicitly shown. Use file-reading tools if you need content; do not ask the user to paste the file again.',
    JSON.stringify(attachments.map(attachment => ({
      name: attachment.name,
      path: attachment.relativePath,
      stagedPath: attachment.relativePath,
      originalPath: attachment.sourcePath,
      sizeBytes: attachment.sizeBytes,
      copiedIntoWorkspace: attachment.copied,
    })), null, 2),
    '</agswarm_attachments>',
    '',
    text,
  ].join('\n');
}

function formatBytes(value: number): string {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function withAgSwarmRuntimeContext(
  text: string,
  context: {
    devices: Device[];
    deviceStatusMessage: string;
    localNodeId: string;
    localDeviceLabel: string;
  },
): string {
  const devices = context.devices.map(device => ({
    id: device.id,
    name: device.name,
    status: device.status,
    type: device.type,
    os: device.os,
    endpoint: device.ipAddress || null,
    isLocal: device.id === context.localNodeId,
    capabilities: device.backgroundTasks || [],
    activeTask: device.activeTask || null,
  }));
  const onlineCount = devices.filter(device => device.status === 'online' || device.status === 'idle' || device.status === 'transferring').length;
  return [
    '<agswarm_app_state trusted="true">',
    'This state is provided by the AgSwarm desktop app UI. Prefer it for questions about devices, tasks, sessions, settings, and the current client state. Do not inspect source code or run shell commands just to answer these app-state questions.',
    JSON.stringify({
      currentClient: {
        nodeId: context.localNodeId,
        name: context.localDeviceLabel,
      },
      devicePage: {
        statusMessage: context.deviceStatusMessage,
        visibleDeviceCount: context.devices.length,
        onlineOrIdleDeviceCount: onlineCount,
        devices,
      },
    }, null, 2),
    '</agswarm_app_state>',
    '',
    text,
  ].join('\n');
}

function Markdown({ text }: { text: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    enhancePiWebCodeBlocks(root);
  }, [text]);
  return <div ref={rootRef} className="pi-gui-markdown" dangerouslySetInnerHTML={{ __html: renderPiMarkdown(text) }} />;
}

function enhancePiWebCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll('pre').forEach(pre => {
    if (!(pre instanceof HTMLPreElement) || pre.parentElement?.classList.contains('pi-gui-code-block-wrapper')) return;
    const code = pre.querySelector('code');
    if (!(code instanceof HTMLElement)) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pi-gui-code-block-wrapper';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'pi-gui-code-copy-button';
    copyButton.title = 'Copy code block';
    copyButton.setAttribute('aria-label', 'Copy code block');
    copyButton.textContent = '⧉';
    copyButton.addEventListener('click', () => {
      void copyCodeBlock(code.textContent || '', copyButton);
    });
    pre.before(wrapper);
    wrapper.append(pre, copyButton);
  });
}

async function copyCodeBlock(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    button.dataset.state = 'copied';
    button.textContent = '✓';
  } catch {
    button.dataset.state = 'failed';
    button.textContent = '!';
  } finally {
    window.setTimeout(() => {
      button.dataset.state = 'idle';
      button.textContent = '⧉';
    }, 1200);
  }
}

function messagesToTimeline(messages: unknown[], startIndex = 0): TimelineItem[] {
  return messages.flatMap((message, index) => messageToTimeline(message, startIndex + index));
}

function messageToTimeline(message: unknown, index: number): TimelineItem[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : 'system';
  if (role === 'assistant' || role === 'user') {
    const createdAt = new Date(index).toISOString();
    const parts = messageContentParts(record);
    const errorText = role === 'assistant' ? assistantErrorText(record) : '';
    const text = stripAgSwarmRuntimeContext(parts.text.join('\n')).trim() || errorText;
    const reasoning = parts.thinking.join('\n').trim();
    const baseId = String(record.id || `${role}-${index}`);
    const timeline: Array<TimelineMessage | TimelineReasoning | TimelineTool | null> = [
      reasoning ? { kind: 'reasoning', id: `${baseId}-reasoning`, text: reasoning, status: 'complete', createdAt } as TimelineReasoning : null,
      ...parts.tools.map((tool, toolIndex) => ({
        ...tool,
        id: tool.id || `tool-${index}-${toolIndex}`,
        callId: tool.callId || `${index}-${toolIndex}`,
        createdAt,
      })),
      text ? { kind: 'message', id: `${baseId}-message`, role, text, createdAt } as TimelineMessage : null,
    ];
    return timeline.filter((item): item is TimelineMessage | TimelineReasoning | TimelineTool => item !== null);
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
  const text = stripAgSwarmRuntimeContext(messageContentParts(record).text.join('\n')).trim();
  return text ? [{ kind: 'activity', id: `message-${index}`, label: text, createdAt: new Date(index).toISOString() }] : [];
}

function assistantErrorText(record: Record<string, unknown>): string {
  const stopReason = typeof record.stopReason === 'string' ? record.stopReason : '';
  const message = typeof record.errorMessage === 'string' ? record.errorMessage : '';
  if (!message || stopReason !== 'error') return '';
  return friendlyAgSwarmError(message);
}

function stripAgSwarmRuntimeContext(value: string): string {
  return value.replace(/<agswarm_app_state\b[^>]*>[\s\S]*?<\/agswarm_app_state>/gi, '').trim();
}

function compactTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let pendingTools: TimelineTool[] = [];

  const flushTools = () => {
    if (!pendingTools.length) return;
    if (pendingTools.length === 1 && pendingTools[0].status === 'running') {
      result.push(pendingTools[0]);
    } else {
      result.push(groupTools(pendingTools));
    }
    pendingTools = [];
  };

  for (const item of items) {
    if (item.kind === 'tool') {
      pendingTools.push(item);
      if (item.status === 'running') flushTools();
      continue;
    }
    if (item.kind === 'toolGroup') {
      pendingTools.push(...item.tools);
      continue;
    }
    flushTools();
    if (item.kind === 'reasoning') {
      const previous = result[result.length - 1];
      if (previous?.kind === 'reasoning') {
        result[result.length - 1] = {
          ...previous,
          text: mergeReasoningText(previous.text, item.text),
          status: previous.status === 'running' || item.status === 'running' ? 'running' : 'complete',
        };
        continue;
      }
    }
    result.push(item);
  }
  flushTools();
  return result;
}

function groupTools(tools: TimelineTool[]): TimelineToolGroup {
  const running = tools.find(tool => tool.status === 'running');
  const errored = tools.filter(tool => tool.status === 'error');
  const createdAt = tools[0]?.createdAt || new Date().toISOString();
  const groupedNames = Array.from(new Set(tools.map(tool => tool.toolName || 'tool')));
  const label = running
    ? running.label
    : errored.length
      ? `${errored.length} tool ${errored.length === 1 ? 'call failed' : 'calls failed'}`
      : `已调用 ${tools.length} 个工具`;
  return {
    kind: 'toolGroup',
    id: `tools-${tools.map(tool => tool.callId).join('-')}`,
    callId: `tools-${tools.map(tool => tool.callId).join('-')}`,
    label,
    tools: [...tools],
    createdAt,
  };
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function mergeReasoningText(left: string, right: string): string {
  if (!left.trim()) return right;
  if (!right.trim()) return left;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left}\n${right}`;
}

function messageContentParts(record: Record<string, unknown>): { text: string[]; thinking: string[]; tools: TimelineTool[] } {
  const content = Array.isArray(record.parts) ? record.parts : record.content;
  if (typeof content === 'string') return { text: [content], thinking: [], tools: [] };
  if (!Array.isArray(content)) return { text: [], thinking: [], tools: [] };
  return content.reduce<{ text: string[]; thinking: string[]; tools: TimelineTool[] }>((parts, part, index) => {
    if (typeof part === 'string') {
      parts.text.push(part);
      return parts;
    }
    if (!part || typeof part !== 'object') return parts;
    const recordPart = part as Record<string, unknown>;
    if (recordPart.type === 'toolExecution') {
      const toolName = String(recordPart.toolName || 'tool');
      const status = toolExecutionStatus(recordPart.status);
      parts.tools.push({
        kind: 'tool',
        id: `tool-${String(recordPart.toolCallId || index)}`,
        callId: String(recordPart.toolCallId || index),
        toolName,
        label: status === 'running'
          ? runningToolLabel(toolName, recordPart.args, String(recordPart.summary || ''))
          : completedToolLabel(toolName),
        status,
        input: recordPart.args,
        output: recordPart.content ?? recordPart.resultText ?? recordPart.details,
        createdAt: new Date(index).toISOString(),
      });
      return parts;
    }
    const text = typeof recordPart.text === 'string' ? recordPart.text : '';
    if (!text) return parts;
    if (recordPart.type === 'thinking') parts.thinking.push(text);
    else if (recordPart.type === 'text' || recordPart.type === undefined) {
      const phase = textSignaturePhase(recordPart.textSignature);
      if (phase !== 'commentary') parts.text.push(text);
    }
    return parts;
  }, { text: [], thinking: [], tools: [] });
}

function toolExecutionStatus(value: unknown): TimelineTool['status'] {
  if (value === 'running' || value === 'pending') return 'running';
  if (value === 'error' || value === 'failed') return 'error';
  return 'success';
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

function mergeSnapshotTimeline(left: TimelineItem[], snapshot: TimelineItem[]): TimelineItem[] {
  if (!snapshot.length) return left;
  const snapshotMessageKeys = new Set(
    snapshot
      .filter((item): item is TimelineMessage => item.kind === 'message')
      .map(message => messageIdentityKey(message)),
  );
  const withoutOptimisticMessages = left.filter(item => (
    item.kind !== 'message'
    || !item.id.startsWith(`${item.role}-`)
    || !snapshotMessageKeys.has(messageIdentityKey(item))
  ));
  return compactTimelineItems(mergeTimelineItems(withoutOptimisticMessages, snapshot));
}

function mergeAppendedMessage(left: TimelineItem[], right: TimelineItem[]): TimelineItem[] {
  const userMessage = right.find(item => item.kind === 'message' && item.role === 'user') as TimelineMessage | undefined;
  const assistantMessage = right.find(item => item.kind === 'message' && item.role === 'assistant') as TimelineMessage | undefined;
  const withoutOptimisticDuplicate = left.filter(item => (
    !(userMessage && item.kind === 'message' && item.role === 'user' && item.id.startsWith('user-') && normalizeComparableText(item.text) === normalizeComparableText(userMessage.text))
    && !(assistantMessage && item.kind === 'message' && item.role === 'assistant' && item.id.startsWith('assistant-stream-'))
  ));
  return mergeTimelineItems(withoutOptimisticDuplicate, right);
}

function messageIdentityKey(message: TimelineMessage): string {
  return `${message.role}:${normalizeComparableText(message.text)}`;
}

function mergeFinalAssistantMessage(left: TimelineItem[], right: TimelineItem[]): TimelineItem[] {
  const hasAssistantMessage = right.some(item => item.kind === 'message' && item.role === 'assistant');
  const base = hasAssistantMessage
    ? left.filter(item => !(item.kind === 'message' && item.role === 'assistant' && item.id.startsWith('assistant-stream-')))
    : left;
  return mergeTimelineItems(base, right);
}

function closeOpenStream(items: TimelineItem[]): TimelineItem[] {
  return closeRunningReasoning(items).map(item => {
    if (item.kind === 'message' && item.role === 'assistant' && item.id.startsWith('assistant-stream-')) {
      return { ...item, id: item.id.replace('assistant-stream-', 'assistant-stream-closed-') };
    }
    return item;
  });
}

function closeRunningReasoning(items: TimelineItem[]): TimelineItem[] {
  return items.map(item => item.kind === 'reasoning' && item.status === 'running' ? { ...item, status: 'complete' } : item);
}

function markRunningToolsStopped(items: TimelineItem[]): TimelineItem[] {
  return items.map(item => {
    if (item.kind === 'tool' && item.status === 'running') {
      return { ...item, status: 'error', label: `${item.label} stopped` };
    }
    if (item.kind === 'toolGroup') {
      return {
        ...item,
        tools: item.tools.map(tool => tool.status === 'running' ? { ...tool, status: 'error', label: `${tool.label} stopped` } : tool),
      };
    }
    return item;
  });
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

function nestedToolDetailId(callId: string): string {
  return `detail-${callId}`;
}

function scrollToBottom(element: HTMLElement | null) {
  if (!element) return;
  window.requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}
