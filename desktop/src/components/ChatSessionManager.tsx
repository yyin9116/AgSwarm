import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Check, Edit3, MessageSquare, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatSession } from '../lib/chatSessionsStore';

interface ChatSessionManagerProps {
  sessions: ChatSession[];
  activeSessionId: string;
  layout?: 'row' | 'sidebar';
  onCreateSession: () => void;
  isCreatingSession?: boolean;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
}

export function ChatSessionManager({
  sessions,
  activeSessionId,
  layout = 'row',
  onCreateSession,
  isCreatingSession = false,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: ChatSessionManagerProps) {
  const [renamingSession, setRenamingSession] = useState<ChatSession | null>(null);
  const isSidebar = layout === 'sidebar';

  return (
    <>
      <Stack gap="sm" className={`agswarm-chat-sessions ${isSidebar ? 'is-sidebar' : ''}`}>
        <Group gap="xs" justify={isSidebar ? 'space-between' : 'flex-start'} wrap="nowrap">
          {isSidebar && (
            <Text fw={700} size="sm">
              Chats
            </Text>
          )}
          <Tooltip label="New chat">
            <ActionIcon
              aria-label="New chat"
              color="gray"
              disabled={isCreatingSession}
              loading={isCreatingSession}
              radius="xl"
              variant="subtle"
              onClick={onCreateSession}
            >
              <Plus size={17} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <ScrollArea type="never" offsetScrollbars={false} className="agswarm-chat-sessions-scroll">
          <Stack gap={4} className={isSidebar ? 'agswarm-chat-session-list' : undefined}>
            {sessions.map(session => (
              <SessionItem
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                onSelect={() => onSelectSession(session.id)}
                onRename={() => setRenamingSession(session)}
                onDelete={() => onDeleteSession(session.id)}
              />
            ))}
          </Stack>
        </ScrollArea>
      </Stack>
      <RenameSessionModal
        session={renamingSession}
        onClose={() => setRenamingSession(null)}
        onSave={(title) => {
          if (!renamingSession) return;
          onRenameSession(renamingSession.id, title);
          setRenamingSession(null);
        }}
      />
    </>
  );
}

function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Group gap={4} wrap="nowrap" className="agswarm-chat-session-row">
      <NavLink
        active={active}
        aria-label={`${session.title}, ${session.messages.length} messages`}
        className={`agswarm-chat-session-link ${active ? 'is-active' : ''}`}
        color="teal"
        description={`${session.messages.length} messages`}
        label={session.title}
        leftSection={<MessageSquare size={15} />}
        onClick={onSelect}
        role="button"
        variant="light"
      />
      <Menu position="bottom-end" width={150} shadow="md" withinPortal>
        <Menu.Target>
          <ActionIcon
            aria-label={`Manage ${session.title}`}
            color={active ? 'teal' : 'gray'}
            radius="xl"
            size="sm"
            variant="subtle"
          >
            <MoreHorizontal size={15} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<Edit3 size={14} />} onClick={onRename}>
            Rename
          </Menu.Item>
          <Menu.Item leftSection={<Trash2 size={14} />} color="red" onClick={onDelete}>
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

function RenameSessionModal({
  session,
  onClose,
  onSave,
}: {
  session: ChatSession | null;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState('');

  useEffect(() => {
    setTitle(session?.title || '');
  }, [session]);

  const submit = () => {
    const nextTitle = title.trim();
    if (nextTitle) onSave(nextTitle);
  };

  return (
    <Modal opened={Boolean(session)} onClose={onClose} title="Rename chat" centered radius="md">
      <Stack gap="md">
        <TextInput
          aria-label="Chat title"
          autoFocus
          value={title}
          onChange={event => setTitle(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') submit();
          }}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" color="gray" leftSection={<X size={16} />} onClick={onClose}>
            Cancel
          </Button>
          <Button color="teal" leftSection={<Check size={16} />} onClick={submit}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
