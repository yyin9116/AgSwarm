import type { Message } from '@ag-ui/client';
import { normalizeMarkdownContent } from './markdownNormalize';
import { collapseRepeatedText } from './textDedupe';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface ChatSessionsState {
  sessions: ChatSession[];
  activeSessionId: string;
}

const STORAGE_PREFIX = 'agswarm.chatSessions.v1';
const DEFAULT_TITLE = 'New chat';

export function loadChatSessions(localNodeId: string): ChatSessionsState {
  const parsed = readStoredState(storageKey(localNodeId));
  if (!parsed) {
    const session = createChatSession();
    return { sessions: [session], activeSessionId: session.id };
  }

  const sessions = compactEmptySessions(parsed.sessions
    .map(normalizeSession)
    .filter((session): session is ChatSession => Boolean(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), parsed.activeSessionId);

  if (!sessions.length) {
    const session = createChatSession();
    return { sessions: [session], activeSessionId: session.id };
  }

  const activeSessionId = sessions.some(session => session.id === parsed.activeSessionId)
    ? parsed.activeSessionId
    : sessions[0].id;

  const state = { sessions, activeSessionId };
  if (storedMessagesCount(parsed.sessions) !== storedMessagesCount(sessions)) {
    window.localStorage.setItem(storageKey(localNodeId), JSON.stringify(compactChatSessionsState(state)));
  }
  return state;
}

export function saveChatSessions(localNodeId: string, state: ChatSessionsState): void {
  window.localStorage.setItem(storageKey(localNodeId), JSON.stringify(compactChatSessionsState(state)));
}

export function createChatSession(title = DEFAULT_TITLE): ChatSession {
  const now = new Date().toISOString();
  return {
    id: `chat-${crypto.randomUUID()}`,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function createOrReuseEmptyChatSession(state: ChatSessionsState): ChatSessionsState {
  const compacted = compactChatSessionsState(state);
  const emptySession = compacted.sessions.find(session => isReusableEmptySession(session));
  if (emptySession) {
    return { ...compacted, activeSessionId: emptySession.id };
  }

  const session = createChatSession();
  return {
    sessions: [session, ...compacted.sessions],
    activeSessionId: session.id,
  };
}

export function renameChatSession(
  state: ChatSessionsState,
  sessionId: string,
  title: string,
): ChatSessionsState {
  const nextTitle = normalizeTitle(title);
  const sessions = state.sessions.map(session => (
    session.id === sessionId
      ? { ...session, title: nextTitle }
      : session
  ));
  return { ...state, sessions };
}

export function deleteChatSession(state: ChatSessionsState, sessionId: string): ChatSessionsState {
  const remaining = state.sessions.filter(session => session.id !== sessionId);
  if (!remaining.length) {
    const session = createChatSession();
    return { sessions: [session], activeSessionId: session.id };
  }

  const activeSessionId = state.activeSessionId === sessionId
    ? remaining[0].id
    : state.activeSessionId;

  return { sessions: remaining, activeSessionId };
}

export function upsertSessionMessages(
  state: ChatSessionsState,
  sessionId: string,
  messages: Message[],
): ChatSessionsState {
  const now = new Date().toISOString();
  let shouldPromote = false;
  const sessions = state.sessions.map(session => {
    if (session.id !== sessionId) return session;
    const title = session.title === DEFAULT_TITLE ? titleFromMessages(messages) : session.title;
    shouldPromote = messages.length > session.messages.length;
    return {
      ...session,
      title,
      messages,
      updatedAt: shouldPromote ? now : session.updatedAt,
    };
  });
  return { ...state, sessions: shouldPromote ? sortSessions(sessions) : sessions };
}

export function getSessionMessages(state: ChatSessionsState, sessionId: string): Message[] {
  return state.sessions.find(session => session.id === sessionId)?.messages || [];
}

function storageKey(localNodeId: string): string {
  return `${STORAGE_PREFIX}.${localNodeId || 'local'}`;
}

function readStoredState(key: string): ChatSessionsState | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ChatSessionsState>;
    return Array.isArray(value.sessions) && typeof value.activeSessionId === 'string'
      ? { sessions: value.sessions as ChatSession[], activeSessionId: value.activeSessionId }
      : null;
  } catch {
    return null;
  }
}

function normalizeSession(value: Partial<ChatSession>): ChatSession | null {
  if (!value || typeof value.id !== 'string') return null;
  const now = new Date().toISOString();
  return {
    id: value.id,
    title: normalizeTitle(value.title || DEFAULT_TITLE),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
    messages: Array.isArray(value.messages) ? value.messages.map(normalizeMessage).filter((message): message is Message => Boolean(message)) : [],
  };
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  return trimmed || DEFAULT_TITLE;
}

function titleFromMessages(messages: Message[]): string {
  const firstUserText = messages
    .filter(message => message.role === 'user')
    .map(message => textFromContent(message.content))
    .find(Boolean);

  if (!firstUserText) return DEFAULT_TITLE;
  return firstUserText.length > 36 ? `${firstUserText.slice(0, 36)}...` : firstUserText;
}

function textFromContent(content: Message['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) return String(part.text || '');
      return '';
    })
    .join(' ')
    .trim();
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function compactChatSessionsState(state: ChatSessionsState): ChatSessionsState {
  const sessions = compactEmptySessions(state.sessions, state.activeSessionId);
  if (!sessions.length) {
    const session = createChatSession();
    return { sessions: [session], activeSessionId: session.id };
  }
  const activeSessionId = sessions.some(session => session.id === state.activeSessionId)
    ? state.activeSessionId
    : sessions[0].id;
  return { sessions, activeSessionId };
}

function compactEmptySessions(sessions: ChatSession[], activeSessionId: string): ChatSession[] {
  const activeEmpty = sessions.find(session => session.id === activeSessionId && isReusableEmptySession(session));
  let keptEmptyId = activeEmpty?.id || '';
  return sessions.filter(session => {
    if (!isReusableEmptySession(session)) return true;
    if (!keptEmptyId) {
      keptEmptyId = session.id;
      return true;
    }
    return session.id === keptEmptyId;
  });
}

function storedMessagesCount(sessions: Array<Partial<ChatSession>>): number {
  return sessions.reduce((total, session) => total + (Array.isArray(session.messages) ? session.messages.length : 0), 0);
}

function isReusableEmptySession(session: ChatSession): boolean {
  return session.title === DEFAULT_TITLE && !session.messages.some(hasUserText);
}

function hasUserText(message: Message): boolean {
  return message.role === 'user' && Boolean(textFromContent(message.content));
}

function normalizeMessage(message: Message): Message | null {
  if (message.role === 'assistant' && shouldDropStoredAssistantMessage(message)) return null;
  if (message.role !== 'assistant' || typeof message.content !== 'string') return message;
  const content = sanitizeStoredAssistantText(message.content);
  if (!content.trim()) return null;
  return {
    ...message,
    content: normalizeMarkdownContent(content),
  };
}

function shouldDropStoredAssistantMessage(message: Message): boolean {
  const text = textFromContent(message.content);
  const record = message as unknown as Record<string, unknown>;
  if (isStoredLegacyPiActivity(record)) return true;
  if (!text && !hasStoredToolContent(record)) return true;
  if (/^(?:AgSwarm AI\s*)?(?:Response ready|Received your request|Calling pi on .+|pi started a reasoning turn\.?)$/i.test(text)) {
    return true;
  }
  if (/^Task completed successfully[\s.。!！]*$/i.test(text)) return true;
  if (/^(?:AgSwarm AI\s*)?(?:completed|finished|response ready)[\s.。!！]*$/i.test(text)) return true;
  if (isStoredDefaultPiActivity(record)) return true;
  return false;
}

function sanitizeStoredAssistantText(value: string): string {
  let text = value.replace(/^Task completed successfully[\s.。!！]*$/gim, '').trim();
  text = collapseRepeatedText(text);
  return text;
}

function hasStoredToolContent(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (!part || typeof part !== 'object') return false;
      const type = String((part as Record<string, unknown>).type || '');
      return type.includes('tool') || type.includes('activity');
    });
  }
  return Boolean(message.toolCalls || message.tool_calls || message.activities || message.activity);
}

function isStoredDefaultPiActivity(message: Record<string, unknown>): boolean {
  const serialized = safeStringify(message);
  if (!/agswarm\.pi\.status|activity/i.test(serialized)) return false;
  return /Task completed successfully|Response ready|Received your request|Calling pi on |pi started a reasoning turn/i.test(serialized);
}

function isStoredLegacyPiActivity(message: Record<string, unknown>): boolean {
  const serialized = safeStringify(message);
  if (!/agswarm\.pi\.status/i.test(serialized)) return false;
  if (message.toolCalls || message.tool_calls) return false;
  return true;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
