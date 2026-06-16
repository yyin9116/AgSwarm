import { Avatar, Badge, Box, Group, Text, Tooltip } from '@mantine/core';
import { ChevronLeft, MessageSquareText, SendHorizontal } from 'lucide-react';
import { CopilotChat, CopilotChatAssistantMessage, CopilotChatReasoningMessage, CopilotChatUserMessage, CopilotKitProvider, useCopilotKit } from '@copilotkit/react-core/v2';
import type { CopilotChatAssistantMessageProps, CopilotChatReasoningMessageProps, CopilotChatUserMessageProps } from '@copilotkit/react-core/v2';
import type { AbstractAgent, Message } from '@ag-ui/client';
import type { RefObject, TouchEvent, WheelEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppIcon } from './AppIcon';
import { ChatSessionManager } from './ChatSessionManager';
import type { Device } from './DevicesView';
import { createPiActivityRenderer, createPiToolRenderer } from './PiAgentRenderers';
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

interface AgSwarmCopilotChatViewProps {
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

export function AgSwarmCopilotChatView({
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
}: AgSwarmCopilotChatViewProps) {
  const remoteDevices = useMemo(
    () => devices.filter(device => device.id !== localNodeId),
    [devices, localNodeId],
  );
  const [sessionEnvelope, setSessionEnvelope] = useState(() => ({
    nodeId: localNodeId,
    state: loadChatSessions(localNodeId),
  }));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [piCommands, setPiCommands] = useState<PiCommandInfo[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const chatRootRef = useRef<HTMLDivElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const latestSessionEnvelopeRef = useRef(sessionEnvelope);
  const lastPersistedMessagesSignatureRef = useRef('');
  const latestDevicesRef = useRef(devices);
  const latestDispatchTaskRef = useRef(onDispatchTask);
  const sessionState = sessionEnvelope.state;
  const activeSessionId = sessionState.activeSessionId;
  const activeSessionMessages = useMemo(
    () => getSessionMessages(sessionState, activeSessionId),
    [activeSessionId, sessionState],
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

  const getDevices = useCallback(() => latestDevicesRef.current, []);
  const dispatchTask = useCallback(
    (taskData: SendTaskData, options?: { targetDeviceName?: string }) => latestDispatchTaskRef.current(taskData, options),
    [],
  );

  const agentConfig = useMemo(() => ({
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
  }), [agentId, agentSkills, dispatchTask, getDevices, latexMcpDir, localDeviceLabel, localNodeId, model, natsUrl, piCwd, targetNodeId]);
  const agentRef = useRef<PiCopilotAgent | null>(null);
  const agentSessionRef = useRef<string | null>(null);
  if (!agentRef.current || agentRef.current.agentId !== agentId || agentSessionRef.current !== activeSessionId) {
    agentRef.current = new PiCopilotAgent(agentConfig, activeSessionMessages);
    agentSessionRef.current = activeSessionId;
  } else {
    agentRef.current.updateConfig(agentConfig);
  }
  const activeAgent = agentRef.current;
  const agents = useMemo(() => ({ [agentId]: activeAgent as AbstractAgent }), [activeAgent, agentId]);

  useEffect(() => {
    setSessionEnvelope({ nodeId: localNodeId, state: loadChatSessions(localNodeId) });
  }, [localNodeId]);

  useEffect(() => {
    latestSessionEnvelopeRef.current = sessionEnvelope;
    if (sessionEnvelope.nodeId !== localNodeId) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveChatSessions(localNodeId, sessionEnvelope.state);
      saveTimerRef.current = null;
    }, 250);
  }, [localNodeId, sessionEnvelope]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const latest = latestSessionEnvelopeRef.current;
      saveChatSessions(latest.nodeId || localNodeId, latest.state);
    };
  }, [localNodeId]);

  const createSession = useCallback(() => {
    if (isCreatingSession) return;
    setIsCreatingSession(true);
    setSessionEnvelope(current => {
      return {
        ...current,
        state: createOrReuseEmptyChatSession(current.state),
      };
    });
    window.setTimeout(() => setIsCreatingSession(false), 220);
  }, [isCreatingSession]);

  const selectSession = useCallback((sessionId: string) => {
    setSessionEnvelope(current => current.state.activeSessionId === sessionId
      ? current
      : { ...current, state: { ...current.state, activeSessionId: sessionId } });
  }, []);

  const selectSessionFromPanel = useCallback((sessionId: string) => {
    selectSession(sessionId);
    if (window.matchMedia('(max-width: 768px)').matches) {
      setSessionsOpen(false);
    }
  }, [selectSession]);

  const renameSession = useCallback((sessionId: string, title: string) => {
    setSessionEnvelope(current => ({
      ...current,
      state: renameChatSession(current.state, sessionId, title),
    }));
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setSessionEnvelope(current => ({
      ...current,
      state: deleteChatSession(current.state, sessionId),
    }));
  }, []);

  const persistActiveMessages = useCallback((messages: typeof sessionState.sessions[number]['messages']) => {
    const signature = messagesSignature(messages);
    if (signature === lastPersistedMessagesSignatureRef.current) return;
    lastPersistedMessagesSignatureRef.current = signature;
    setSessionEnvelope(current => ({
      ...current,
      state: upsertSessionMessages(current.state, activeSessionId, messages),
    }));
  }, [activeSessionId]);

  useEffect(() => {
    const subscription = activeAgent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const nextMessages = [...messages];
        if (!nextMessages.length && activeSessionMessages.length > 0) return;
        persistActiveMessages(nextMessages);
      },
    });
    return () => subscription.unsubscribe();
  }, [activeAgent, activeSessionMessages.length, persistActiveMessages]);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaY) > 48 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) {
      if (deltaY > 0) {
        setComposerCollapsed(true);
      } else {
        setComposerCollapsed(false);
      }
      return;
    }
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return;
    if (deltaX > 0 && start.x < 42) {
      setSessionsOpen(true);
    } else if (deltaX < 0 && sessionsOpen) {
      setSessionsOpen(false);
    }
  }, [sessionsOpen]);
  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) < 8 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    if (event.deltaY < 0) {
      setComposerCollapsed(true);
      return;
    }
    const scrollParent = findActiveScrollable(chatRootRef.current);
    if (!scrollParent) return;
    const distanceToBottom = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
    if (distanceToBottom < 96) {
      setComposerCollapsed(false);
    }
  }, []);
  const copilotProperties = useMemo(() => ({
    localNodeId,
    localDeviceLabel,
    targetPiNodeId: targetNodeId,
    remoteDeviceIds: remoteDevices.map(device => device.id),
  }), [localDeviceLabel, localNodeId, remoteDevices, targetNodeId]);
  const renderActivityMessages = useMemo(() => [createPiActivityRenderer(agentId)], [agentId]);
  const renderToolCalls = useMemo(() => [createPiToolRenderer(agentId)], [agentId]);

  useEffect(() => {
    const root = chatRootRef.current;
    if (!root) return;
    const dump = (label = 'chat-dom') => {
      const snapshot = createChatDomSnapshot(root);
      void writeFrontendDebugLog({ label, payload: snapshot }).catch(error => {
        console.warn('[agswarm:frontend-debug]', error);
      });
      return snapshot;
    };
    const debugWindow = window as typeof window & {
      __AGSWARM_DOM_SNAPSHOT__?: (label?: string) => ReturnType<typeof createChatDomSnapshot>;
    };
    debugWindow.__AGSWARM_DOM_SNAPSHOT__ = dump;
    return () => {
      if (debugWindow.__AGSWARM_DOM_SNAPSHOT__ === dump) {
        delete debugWindow.__AGSWARM_DOM_SNAPSHOT__;
      }
    };
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    getPiCommands({ natsUrl, skills: agentSkills || 'safe_default', workspace: piCwd || undefined })
      .then(response => {
        if (cancelled) return;
        const commands = dedupePiCommands([...(response.commands || []), ...(response.models || []), ...(response.skills || [])]);
        setPiCommands(commands);
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
    const root = chatRootRef.current;
    if (!root) return;
    const handleInput = () => {
      const value = activeChatInputValue(root);
      setInputValue(value);
      setCommandPanelOpen(value.trimStart().startsWith('/'));
    };
    root.addEventListener('input', handleInput, true);
    root.addEventListener('focusin', handleInput, true);
    root.addEventListener('keydown', handleInput, true);
    return () => {
      root.removeEventListener('input', handleInput, true);
      root.removeEventListener('focusin', handleInput, true);
      root.removeEventListener('keydown', handleInput, true);
    };
  }, [activeSessionId]);

  useEffect(() => {
    const root = chatRootRef.current;
    if (!root) return;
    let cleanup: (() => void) | null = null;
    let attempts = 0;
    const bindScroll = () => {
      const scrollContent = root.querySelector<HTMLElement>('[data-testid="copilot-scroll-content"]');
      const scrollParent = findScrollableParent(scrollContent, root);
      if (!scrollParent) {
        attempts += 1;
        if (attempts < 20) {
          window.setTimeout(bindScroll, 120);
        }
        return;
      }
      let lastScrollTop = scrollParent.scrollTop;
      const handleScroll = () => {
        const distanceToBottom = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
        const isNearLatest = distanceToBottom < 48;
        const scrollingUp = scrollParent.scrollTop < lastScrollTop - 4;
        if (isNearLatest) {
          setComposerCollapsed(false);
        } else if (scrollingUp) {
          setComposerCollapsed(true);
        }
        lastScrollTop = scrollParent.scrollTop;
      };
      scrollParent.addEventListener('scroll', handleScroll, { passive: true });
      cleanup = () => scrollParent.removeEventListener('scroll', handleScroll);
    };
    bindScroll();
    return () => cleanup?.();
  }, [activeSessionId]);

  const expandComposer = useCallback(() => {
    setComposerCollapsed(false);
    window.setTimeout(() => {
      const input = chatRootRef.current?.querySelector<HTMLElement>('textarea, [contenteditable="true"], input');
      input?.focus();
    }, 180);
  }, []);

  return (
    <CopilotKitProvider
      key={activeSessionId}
      selfManagedAgents={agents}
      renderActivityMessages={renderActivityMessages}
      renderToolCalls={renderToolCalls}
      defaultThrottleMs={24}
      properties={copilotProperties}
      onError={({ code, error, context }) => {
        console.error('[copilotkit]', code, error, context);
      }}
    >
      <ChatSessionHydrator
        agent={activeAgent}
        activeSessionId={activeSessionId}
        messages={activeSessionMessages}
      />
      <PiRunWatchdog
        agent={activeAgent}
        activeSessionId={activeSessionId}
      />
      <CopilotAutoScroller
        agent={activeAgent}
        rootRef={chatRootRef}
        activeSessionId={activeSessionId}
      />
      <Box
        ref={chatRootRef}
        className={`agswarm-chat-workspace ${sessionsOpen ? 'is-sessions-open' : 'is-sessions-collapsed'} ${composerCollapsed ? 'is-composer-collapsed' : 'is-composer-open'}`}
        data-active-session-id={activeSessionId}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
      >
        <button
          type="button"
          aria-label="Close chat sessions"
          className="agswarm-chat-scrim"
          onClick={() => setSessionsOpen(false)}
          tabIndex={sessionsOpen ? 0 : -1}
        />
        <Box
          id="agswarm-chat-sidebar"
          className="agswarm-chat-sidebar"
          aria-hidden={!sessionsOpen}
        >
          <ChatHeader
            localNodeId={localNodeId}
            localDeviceLabel={localDeviceLabel}
            targetLabel={targetLabel}
            targetNodeId={targetNodeId}
            isLocalTarget={isLocalTarget}
            remoteDevices={remoteDevices}
          />
          <ChatSessionManager
            layout="sidebar"
            sessions={sessionState.sessions}
            activeSessionId={activeSessionId}
            onCreateSession={createSession}
            isCreatingSession={isCreatingSession}
            onSelectSession={selectSessionFromPanel}
            onRenameSession={renameSession}
            onDeleteSession={removeSession}
          />
        </Box>
        <Box className="agswarm-chat-main">
          <Box className="agswarm-chat-main-header">
            <Tooltip label={sessionsOpen ? 'Hide chats' : 'Show chats'}>
              <button
                type="button"
                className="agswarm-chat-sidebar-toggle"
                aria-label={sessionsOpen ? 'Hide chat sessions' : 'Show chat sessions'}
                aria-controls="agswarm-chat-sidebar"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen(open => !open)}
              >
                {sessionsOpen ? <ChevronLeft size={17} strokeWidth={1.8} /> : <MessageSquareText size={17} strokeWidth={1.8} />}
              </button>
            </Tooltip>
            <Group gap="xs" wrap="nowrap" className="agswarm-chat-main-title">
              <Text fw={700} truncate>AgSwarm AI</Text>
              <Badge color={isLocalTarget ? 'gray' : 'teal'} variant="light">
                {isLocalTarget ? 'Local target' : 'Remote target'}
              </Badge>
              <Text c="dimmed" ff="monospace" size="xs" truncate>
                {targetNodeId}
              </Text>
            </Group>
          </Box>
          <Box className="agswarm-copilot-chat">
            <CopilotChat
              key={activeSessionId}
              agentId={agentId}
              threadId={activeSessionId}
              throttleMs={80}
              autoScroll="pin-to-send"
              className="agswarm-copilotkit-chat"
              messageView={{
                assistantMessage: PiAssistantMessage,
                userMessage: PiUserMessage,
                reasoningMessage: PiReasoningMessage,
              }}
              labels={{
                chatInputPlaceholder: `Ask AgSwarm AI on ${targetLabel}... Use @device to route.`,
                welcomeMessageText: 'Ask the AgSwarm AgSwarm AI.',
                modalHeaderTitle: 'AgSwarm AI',
                chatDisclaimerText: '',
              }}
              attachments={{
                enabled: true,
                accept: '*/*',
                maxSize: 50 * 1024 * 1024,
              }}
            />
            <PiCommandPalette
              commands={piCommands}
              inputValue={inputValue}
              opened={commandPanelOpen}
              rootRef={chatRootRef}
              onClose={() => setCommandPanelOpen(false)}
            />
            <button
              type="button"
              className="agswarm-composer-fab"
              aria-label="Show message input"
              onClick={expandComposer}
            >
              <SendHorizontal size={18} strokeWidth={1.8} />
            </button>
          </Box>
        </Box>
      </Box>
    </CopilotKitProvider>
  );
}

const PiAssistantMessage = Object.assign(function PiAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const speaker = messageSpeaker(props.message, 'AgSwarm AI');
  const avatar = speaker.includes('pi') ? 'π' : speaker.slice(0, 1).toUpperCase();
  const content = messageTextContent(props.message);
  const hasText = content.trim().length > 0;
  const hasAssistantSurface = hasText || messageHasToolContent(props.message);
  return (
    <CopilotChatAssistantMessage {...props} className="agswarm-copilot-message-base">
      {({ markdownRenderer, toolbar, toolCallsView, toolbarVisible }) => (
        hasAssistantSurface ? (
          <div className="agswarm-chat-message-row is-assistant">
            <Avatar size={28} radius="xl" color="teal" variant="light" className="agswarm-chat-avatar">{avatar}</Avatar>
            <div className="agswarm-chat-message-body">
              <Text size="xs" fw={700} c="dimmed" className="agswarm-chat-speaker">{speaker}</Text>
              {toolCallsView}
              {hasText && <div className="agswarm-chat-markdown">{markdownRenderer}</div>}
              {hasText && toolbarVisible && <div className="agswarm-chat-toolbar">{toolbar}</div>}
            </div>
          </div>
        ) : null
      )}
    </CopilotChatAssistantMessage>
  );
}, CopilotChatAssistantMessage);

const PiUserMessage = Object.assign(function PiUserMessage(props: CopilotChatUserMessageProps) {
  const speaker = messageSpeaker(props.message, 'You');
  const avatar = speaker === 'You' ? 'Y' : speaker.slice(0, 1).toUpperCase();
  return (
    <CopilotChatUserMessage {...props} className="agswarm-copilot-message-base" messageRenderer={UserMarkdownMessageRenderer}>
      {({ messageRenderer, toolbar }) => (
        <div className="agswarm-chat-message-row is-user">
          <Avatar size={28} radius="xl" color="gray" variant="light" className="agswarm-chat-avatar">{avatar}</Avatar>
          <div className="agswarm-chat-message-body">
            <Text size="xs" fw={700} c="dimmed" className="agswarm-chat-speaker">{speaker}</Text>
            {messageRenderer}
            <div className="agswarm-chat-toolbar is-user">{toolbar}</div>
          </div>
        </div>
      )}
    </CopilotChatUserMessage>
  );
}, CopilotChatUserMessage);

const PiReasoningMessage = Object.assign(function PiReasoningMessage(props: CopilotChatReasoningMessageProps) {
  return (
    <CopilotChatReasoningMessage
      {...props}
      className="agswarm-reasoning"
      header={PiReasoningHeader}
      contentView={PiReasoningContent}
    />
  );
}, CopilotChatReasoningMessage);

function PiReasoningHeader({
  isOpen,
  hasContent,
  isStreaming,
  onClick,
}: {
  isOpen?: boolean;
  hasContent?: boolean;
  isStreaming?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="agswarm-reasoning-header"
      aria-expanded={hasContent ? Boolean(isOpen) : undefined}
      onClick={onClick}
      disabled={!hasContent}
    >
      <span className={`agswarm-reasoning-dot ${isStreaming ? 'is-running' : ''}`} />
      <span>{isStreaming ? '正在思考' : '思考过程'}</span>
      {hasContent && <span className="agswarm-reasoning-chevron">{isOpen ? '收起' : '展开'}</span>}
    </button>
  );
}

function PiReasoningContent({
  children,
  hasContent,
}: {
  children?: unknown;
  hasContent?: boolean;
}) {
  const content = compactRepeatedProgressText(reasoningContentToText(children));
  if (!hasContent || !content) return null;
  return (
    <div className="agswarm-reasoning-content">
      <CopilotChatAssistantMessage.MarkdownRenderer content={normalizeMarkdownContent(content)} />
    </div>
  );
}

function PiCommandPalette({
  commands,
  inputValue,
  opened,
  rootRef,
  onClose,
}: {
  commands: PiCommandInfo[];
  inputValue: string;
  opened: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const query = inputValue.trimStart().replace(/^\//, '').toLowerCase();
  const filtered = commands
    .filter(command => {
      const haystack = `${command.name} ${command.description || ''}`.toLowerCase();
      return !query || haystack.includes(query);
    })
    .slice(0, 8);
  if (!opened || !filtered.length) return null;
  return (
    <div className="agswarm-command-palette" role="listbox" aria-label="AgSwarm AI commands">
      {filtered.map(command => (
        <button
          key={`${command.source}:${command.name}:${command.value || ''}`}
          type="button"
          className="agswarm-command-item"
          onMouseDown={(event) => {
            event.preventDefault();
            fillChatInput(rootRef.current, command.value || command.name);
            onClose();
          }}
        >
          <span className="agswarm-command-name">{command.name}</span>
          <span className="agswarm-command-source">{sourceLabel(command.source)}</span>
          {command.description && <span className="agswarm-command-description">{command.description}</span>}
        </button>
      ))}
    </div>
  );
}

function activeChatInputValue(root: HTMLElement): string {
  const element = root.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
  if (element) return element.value;
  const editable = root.querySelector<HTMLElement>('[contenteditable="true"]');
  return editable?.innerText || '';
}

function fillChatInput(root: HTMLElement | null, value: string) {
  if (!root) return;
  const input = root.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(value.length, value.length);
    return;
  }
  const editable = root.querySelector<HTMLElement>('[contenteditable="true"]');
  if (editable) {
    editable.innerText = value;
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    editable.focus();
  }
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
  return result.sort((left, right) => sourceOrder(left.source) - sourceOrder(right.source) || left.name.localeCompare(right.name));
}

function sourceOrder(source: PiCommandInfo['source']): number {
  return source === 'builtin' ? 0 : source === 'skill' ? 1 : source === 'model' ? 2 : 3;
}

function sourceLabel(source: PiCommandInfo['source']): string {
  if (source === 'builtin') return 'pi';
  if (source === 'skill') return 'skill';
  if (source === 'model') return 'model';
  return source;
}

function reasoningContentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(reasoningContentToText).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'summary', 'thinking', 'reasoning']) {
    const nested = reasoningContentToText(record[key]);
    if (nested) return nested;
  }
  return '';
}

function UserMarkdownMessageRenderer({ content, className }: { content: string; className?: string }) {
  return (
    <div className={`agswarm-chat-user-markdown ${className || ''}`}>
      <CopilotChatAssistantMessage.MarkdownRenderer content={normalizeMarkdownContent(content)} />
    </div>
  );
}

function messageSpeaker(message: Message | undefined, fallback: string): string {
  const metadata = message && 'metadata' in message ? message.metadata as Record<string, unknown> | undefined : undefined;
  const deviceLabel = stringMetadata(metadata, 'deviceLabel') || stringMetadata(metadata, 'sourceDeviceLabel');
  const agentLabel = stringMetadata(metadata, 'agentLabel') || stringMetadata(metadata, 'sourceAgentLabel');
  return agentLabel || deviceLabel || fallback;
}

function messageTextContent(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function messageHasToolContent(message: Message | undefined): boolean {
  if (!message) return false;
  const record = message as unknown as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (!part || typeof part !== 'object') return false;
      const type = String((part as Record<string, unknown>).type || '');
      return type.includes('tool') || type.includes('activity');
    });
  }
  return Boolean(record.toolCalls || record.tool_calls || record.activities || record.activity);
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function compactRepeatedProgressText(value: string): string {
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  const compacted: string[] = [];
  for (const line of lines) {
    const last = compacted.at(-1);
    if (!last) {
      compacted.push(line);
      continue;
    }
    if (line === last || line.startsWith(last)) {
      compacted[compacted.length - 1] = line;
      continue;
    }
    compacted.push(line);
  }

  return compacted.join('\n');
}

function findScrollableParent(element: HTMLElement | null, fallback: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current && current !== fallback) {
    if (current.scrollHeight > current.clientHeight + 8) {
      const style = window.getComputedStyle(current);
      if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`)) return current;
    }
    current = current.parentElement;
  }
  return fallback.scrollHeight > fallback.clientHeight + 8 ? fallback : null;
}

function findActiveScrollable(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  return candidates.find(element => {
    if (element.scrollHeight <= element.clientHeight + 24) return false;
    const style = window.getComputedStyle(element);
    return /(auto|scroll)/.test(`${style.overflowY}${style.overflow}`);
  }) || null;
}

function findCopilotScrollParent(root: HTMLElement): HTMLElement | null {
  const scrollContent = root.querySelector<HTMLElement>('[data-testid="copilot-scroll-content"]');
  return findScrollableParent(scrollContent, root) || findActiveScrollable(root);
}

function messagesSignature(messages: Message[]): string {
  const tail = messages.at(-1);
  return `${messages.length}:${tail?.id || ''}:${tail?.role || ''}:${messageContentLength(tail)}`;
}

function latestMessageRole(messages: Message[]): string {
  return String(messages.at(-1)?.role || '');
}

function messageContentLength(message: Message | undefined): number {
  if (!message) return 0;
  const content = message.content;
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(content ?? '').length;
  } catch {
    return 0;
  }
}

function createChatDomSnapshot(root: HTMLElement) {
  const getText = (selector: string) => compactDomText(root.querySelector<HTMLElement>(selector)?.innerText || '');
  const all = <T extends HTMLElement>(selector: string) => Array.from(root.querySelectorAll<T>(selector));
  const scrollContent = root.querySelector<HTMLElement>('[data-testid="copilot-scroll-content"]');
  const inputOverlay = root.querySelector<HTMLElement>('[data-testid="copilot-input-overlay"]');
  const messages = all<HTMLElement>('.agswarm-chat-message-row').map((element, index) => ({
    index,
    role: element.classList.contains('is-user') ? 'user' : 'assistant',
    text: compactDomText(element.innerText).slice(0, 600),
    rect: elementRect(element),
    className: element.className,
  }));
  const reasoning = all<HTMLElement>('.agswarm-reasoning, .agswarm-pi-status').map((element, index) => ({
    index,
    text: compactDomText(element.innerText).slice(0, 500),
    open: Boolean(element.querySelector('details[open]')),
    rect: elementRect(element),
    className: element.className,
  }));
  return {
    url: window.location.href,
    title: document.title,
    activeElement: activeElementSummary(),
    bodyTextStart: compactDomText(document.body.innerText).slice(0, 1200),
    workspace: {
      className: root.className,
      rect: elementRect(root),
      sessionsHeader: getText('.agswarm-chat-sidebar-header'),
      mainHeader: getText('.agswarm-chat-main-header'),
      sessionsOpen: root.classList.contains('is-sessions-open'),
      composerCollapsed: root.classList.contains('is-composer-collapsed'),
    },
    scrollContent: scrollContent ? {
      rect: elementRect(scrollContent),
      scrollTop: scrollContent.scrollTop,
      scrollHeight: scrollContent.scrollHeight,
      clientHeight: scrollContent.clientHeight,
      childCount: scrollContent.childElementCount,
    } : null,
    inputOverlay: inputOverlay ? {
      rect: elementRect(inputOverlay),
      className: inputOverlay.className,
      text: compactDomText(inputOverlay.innerText).slice(0, 500),
    } : null,
    textareaCount: all<HTMLTextAreaElement>('textarea').length,
    buttonTexts: all<HTMLButtonElement>('button').map(button => compactDomText(button.innerText || button.getAttribute('aria-label') || '')).filter(Boolean).slice(0, 40),
    messages,
    reasoning,
  };
}

function elementRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function activeElementSummary() {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return null;
  return {
    tag: element.tagName.toLowerCase(),
    className: element.className,
    ariaLabel: element.getAttribute('aria-label'),
    text: compactDomText(element.innerText || '').slice(0, 200),
  };
}

function compactDomText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function ChatSessionHydrator({
  agent,
  activeSessionId,
  messages,
}: {
  agent: PiCopilotAgent;
  activeSessionId: string;
  messages: ReturnType<typeof getSessionMessages>;
}) {
  useEffect(() => {
    const initialMessages = messages;
    const restoreMessages = () => {
      agent.threadId = activeSessionId;
      agent.setMessages(initialMessages);
    };
    const timer = window.setTimeout(restoreMessages, 0);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, agent]);

  return null;
}

function PiRunWatchdog({
  agent,
  activeSessionId,
}: {
  agent: PiCopilotAgent;
  activeSessionId: string;
}) {
  const { copilotkit } = useCopilotKit();
  const lastTriggeredUserMessageRef = useRef<string | null>(null);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    lastTriggeredUserMessageRef.current = null;
  }, [activeSessionId, agent]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: () => forceUpdate(value => value + 1),
      onRunInitialized: () => forceUpdate(value => value + 1),
      onRunFinalized: () => forceUpdate(value => value + 1),
      onRunFailed: () => forceUpdate(value => value + 1),
      onRunErrorEvent: () => forceUpdate(value => value + 1),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  useEffect(() => {
    if (agent.threadId && agent.threadId !== activeSessionId) return;
    const pendingUserMessage = latestUserMessageWithoutAssistant(agent.messages);
    if (!pendingUserMessage || agent.isRunning) return;
    if (lastTriggeredUserMessageRef.current === pendingUserMessage.id) return;
    const timer = window.setTimeout(() => {
      const latestPendingUserMessage = latestUserMessageWithoutAssistant(agent.messages);
      if (!latestPendingUserMessage || latestPendingUserMessage.id !== pendingUserMessage.id || agent.isRunning) return;
      lastTriggeredUserMessageRef.current = latestPendingUserMessage.id;
      void writeFrontendDebugLog({
        label: 'pi-agent-watchdog-run',
        payload: {
          threadId: activeSessionId,
          messageId: latestPendingUserMessage.id,
          messageCount: agent.messages.length,
        },
      }).catch(() => undefined);
      void copilotkit.runAgent({ agent }).catch(error => {
        lastTriggeredUserMessageRef.current = null;
        console.error('[agswarm] pi watchdog run failed', error);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, agent, agent.messages, agent.isRunning, copilotkit]);

  return null;
}

function CopilotAutoScroller({
  agent,
  rootRef,
  activeSessionId,
}: {
  agent: PiCopilotAgent;
  rootRef: RefObject<HTMLDivElement | null>;
  activeSessionId: string;
}) {
  const [, forceUpdate] = useState(0);
  const followLatestRef = useRef(true);

  useEffect(() => {
    followLatestRef.current = true;
  }, [activeSessionId, agent]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: () => forceUpdate(value => value + 1),
      onRunInitialized: () => forceUpdate(value => value + 1),
      onRunFinalized: () => forceUpdate(value => value + 1),
      onTextMessageContentEvent: () => forceUpdate(value => value + 1),
      onToolCallStartEvent: () => forceUpdate(value => value + 1),
      onToolCallArgsEvent: () => forceUpdate(value => value + 1),
      onToolCallEndEvent: () => forceUpdate(value => value + 1),
      onToolCallResultEvent: () => forceUpdate(value => value + 1),
      onReasoningMessageContentEvent: () => forceUpdate(value => value + 1),
      onActivitySnapshotEvent: () => forceUpdate(value => value + 1),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scrollParent = findCopilotScrollParent(root);
    if (!scrollParent) return;
    const handleScroll = () => {
      const distanceToBottom = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
      followLatestRef.current = distanceToBottom < 160;
    };
    scrollParent.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scrollParent.removeEventListener('scroll', handleScroll);
  }, [rootRef, activeSessionId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const shouldForce = agent.isRunning || latestMessageRole(agent.messages) === 'user';
    if (!followLatestRef.current && !shouldForce) return;
    const scrollParent = findCopilotScrollParent(root);
    if (!scrollParent) return;
    const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
      scrollParent.scrollTo({ top: scrollParent.scrollHeight, behavior });
    };
    scrollToBottom();
    const frame = window.requestAnimationFrame(() => scrollToBottom('auto'));
    const timer = window.setTimeout(() => scrollToBottom(agent.isRunning ? 'auto' : 'smooth'), 120);
    const lateTimer = window.setTimeout(() => scrollToBottom('auto'), 420);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.clearTimeout(lateTimer);
    };
  }, [agent.messages, agent.isRunning, activeSessionId, rootRef]);

  return null;
}

function latestUserMessageWithoutAssistant(messages: Message[]): Message | null {
  let latestUser: Message | null = null;
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      latestUser = message;
      latestUserIndex = index;
      break;
    }
  }
  if (!latestUser || latestUserIndex < 0) return null;
  const hasAssistantAfterUser = messages.slice(latestUserIndex + 1).some(message => (
    message.role === 'assistant' && (
      messageTextContent(message).trim().length > 0 || messageHasToolContent(message)
    )
  ));
  return hasAssistantAfterUser ? null : latestUser;
}

function isPiAgentDevice(device: Device): boolean {
  return device.os.toLowerCase().includes('AgSwarm AI')
    || Boolean(device.backgroundTasks?.some(task => task.toLowerCase().includes('pi-agent')));
}

function ChatHeader({
  localNodeId,
  localDeviceLabel,
  targetLabel,
  targetNodeId,
  isLocalTarget,
  remoteDevices,
}: {
  localNodeId: string;
  localDeviceLabel: string;
  targetLabel: string;
  targetNodeId: string;
  isLocalTarget: boolean;
  remoteDevices: Device[];
}) {
  const targetSummary = isLocalTarget ? '' : `Target: ${targetLabel}`;
  const statusLabel = `Client: ${localNodeId}. Target: ${targetLabel}${isLocalTarget ? ' (local)' : ` @${targetNodeId}`}. ${
    remoteDevices.length
      ? `${remoteDevices.length} remote client${remoteDevices.length === 1 ? '' : 's'} online.`
      : 'No remote clients online.'
  }`;

  return (
    <Tooltip label={statusLabel}>
      <Group
        align="center"
        gap="sm"
        className="agswarm-chat-sidebar-header"
        aria-label={statusLabel}
      >
        <AppIcon className="h-9 w-9" />
        <Box flex={1} miw={0}>
          <Text fw={700} size="lg" truncate>{localDeviceLabel || 'AgSwarm Client'}</Text>
        {targetSummary && (
          <Text c="dimmed" size="xs" truncate>
            {targetSummary}
          </Text>
        )}
        </Box>
      </Group>
    </Tooltip>
  );
}
