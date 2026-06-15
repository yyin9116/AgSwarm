import { useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Combobox,
  FileButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  useCombobox,
} from '@mantine/core';
import {
  ArrowDownLeft,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Laptop,
  Monitor,
  Paperclip,
  Send,
  User,
  X,
} from 'lucide-react';
import { AppIcon } from './AppIcon';
import type { Device } from './DevicesView';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  isThinking?: boolean;
  followUpOptions?: string[];
  attachment?: {
    name: string;
    size: string;
  };
  taskProposal?: {
    direction: 'incoming' | 'outgoing';
    targetDeviceId: string;
    targetDeviceName: string;
    taskType: string;
    payload: string;
    status: 'parsing' | 'created' | 'dispatching' | 'accepted' | 'running' | 'completed';
    result?: string;
    preview?: {
      type: 'image' | 'pdf';
      url: string;
      name: string;
    };
  };
}

interface ChatViewProps {
  messages: ChatMessage[];
  onSendMessage: (content: string, file?: File) => void;
  devices?: Device[];
  localNodeId: string;
  localDeviceLabel: string;
}

export function ChatView({
  messages,
  onSendMessage,
  devices = [],
  localNodeId,
  localDeviceLabel,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  const remoteDevices = useMemo(() => devices.filter(device => device.id !== localNodeId), [devices, localNodeId]);
  const mentionQuery = getMentionQuery(input);
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return remoteDevices
      .filter(device => device.id.toLowerCase().includes(query) || device.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [mentionQuery, remoteDevices]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (mentionOptions.length) combobox.openDropdown();
    else combobox.closeDropdown();
  }, [combobox, mentionOptions.length]);

  useEffect(() => {
    if (!autoScroll) return;
    window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, [autoScroll, messages]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setAutoScroll(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80);
  };

  const handleSend = () => {
    if (!input.trim() && !selectedFile) return;
    onSendMessage(input, selectedFile || undefined);
    setInput('');
    setSelectedFile(null);
    setAutoScroll(true);
    combobox.closeDropdown();
  };

  const insertMention = (device: Device) => {
    setInput(prev => replaceActiveMention(prev, device.id));
    combobox.closeDropdown();
    inputRef.current?.focus();
  };

  return (
    <Stack h="100%" maw={860} mx="auto" px="md" py="xl" gap="md">
      <Group align="flex-start" gap="md">
        <AppIcon className="h-10 w-10" />
        <Box flex={1} miw={0}>
          <Group gap="xs" wrap="wrap">
            <Text fw={700} size="xl" truncate>{localDeviceLabel || 'AgSwarm Client'}</Text>
            <Badge color="teal" variant="light">This Client</Badge>
          </Group>
          <Text c="dimmed" ff="monospace" size="xs" truncate>{localNodeId}</Text>
          <Text c="dimmed" size="sm" truncate>
            {remoteDevices.length
              ? `Send to ${remoteDevices.map(device => `@${device.id}`).join(', ')}`
              : 'Waiting for another AgSwarm client on NATS.'}
          </Text>
        </Box>
      </Group>

      <ScrollArea.Autosize
        mah="calc(100vh - 230px)"
        flex={1}
        viewportRef={viewportRef}
        onScrollPositionChange={handleScroll}
        type="never"
      >
        <Stack gap="md" pr="xs">
          {messages.map(message => (
            <MessageRow key={message.id} message={message} onFollowUp={onSendMessage} />
          ))}
        </Stack>
      </ScrollArea.Autosize>

      <Stack gap="xs">
        {selectedFile && (
          <Paper withBorder radius="md" p="xs">
            <Group gap="sm">
              <ThemeIcon variant="light" color="teal"><FileText size={16} /></ThemeIcon>
              <Box flex={1} miw={0}>
                <Text size="sm" fw={600} truncate>{selectedFile.name}</Text>
                <Text size="xs" c="dimmed">{(selectedFile.size / 1024).toFixed(1)} KB</Text>
              </Box>
              <ActionIcon variant="subtle" color="gray" aria-label="Remove attachment" onClick={() => setSelectedFile(null)}>
                <X size={16} />
              </ActionIcon>
            </Group>
          </Paper>
        )}

        <Combobox store={combobox} onOptionSubmit={(value) => {
          const device = remoteDevices.find(item => item.id === value);
          if (device) insertMention(device);
        }}>
          <Combobox.DropdownTarget>
            <TextInput
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !combobox.dropdownOpened) handleSend();
              }}
              placeholder="Message, or type @ to choose a device..."
              leftSection={(
                <FileButton onChange={setSelectedFile}>
                  {(props) => (
                    <Tooltip label="Attach file">
                      <ActionIcon {...props} variant="subtle" color="gray" aria-label="Attach file">
                        <Paperclip size={18} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </FileButton>
              )}
              rightSection={(
                <Tooltip label="Send message">
                  <ActionIcon
                    color="teal"
                    aria-label="Send message"
                    disabled={!input.trim() && !selectedFile}
                    onClick={handleSend}
                  >
                    <Send size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              size="lg"
              radius="md"
            />
          </Combobox.DropdownTarget>
          <Combobox.Dropdown hidden={!mentionOptions.length}>
            <Combobox.Options>
              {mentionOptions.map(device => (
                <Combobox.Option key={device.id} value={device.id}>
                  <Group gap="sm" wrap="nowrap">
                    <ThemeIcon variant="light" color="teal" size="sm">
                      <Monitor size={14} />
                    </ThemeIcon>
                    <Box flex={1} miw={0}>
                      <Text size="sm" fw={600} truncate>{device.name}</Text>
                      <Text size="xs" c="dimmed" ff="monospace" truncate>{device.id}</Text>
                    </Box>
                    <Badge size="xs" variant="light" color={device.status === 'online' ? 'green' : 'gray'}>{device.status}</Badge>
                  </Group>
                </Combobox.Option>
              ))}
            </Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>
      </Stack>
    </Stack>
  );
}

const MessageRow: FC<{ message: ChatMessage; onFollowUp: (content: string) => void }> = ({ message, onFollowUp }) => {
  const isUser = message.role === 'user';
  return (
    <Group align="flex-end" justify={isUser ? 'flex-end' : 'flex-start'} gap="sm" wrap="nowrap">
      {!isUser && (
        <Avatar radius="xl" color={message.role === 'system' ? 'teal' : undefined}>
          {message.role === 'system' ? <ArrowDownLeft size={16} /> : <AppIcon className="h-7 w-7" />}
        </Avatar>
      )}

      <Stack gap={6} align={isUser ? 'flex-end' : 'flex-start'} maw={isUser ? '78%' : '84%'}>
        {message.attachment && (
          <Paper withBorder radius="md" p="xs">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon color="teal" variant="light"><FileText size={16} /></ThemeIcon>
              <Box miw={0}>
                <Text size="xs" fw={600} truncate>{message.attachment.name}</Text>
                <Text size="xs" c="dimmed">{message.attachment.size}</Text>
              </Box>
            </Group>
          </Paper>
        )}

        <Paper
          withBorder={!isUser}
          radius="lg"
          p="md"
          bg={isUser ? 'dark.8' : undefined}
          c={isUser ? 'white' : undefined}
        >
          {message.isThinking ? (
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm" fw={500}>Working...</Text>
            </Group>
          ) : (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.content}</Text>
          )}
        </Paper>

        {message.taskProposal && <TaskProposalCard proposal={message.taskProposal} />}

        {message.followUpOptions && message.taskProposal?.status === 'completed' && (
          <Group gap="xs">
            {message.followUpOptions.map(option => (
              <Badge key={option} component="button" variant="light" onClick={() => onFollowUp(option)}>
                {option}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>

      {isUser && (
        <Avatar radius="xl" color="dark">
          <User size={16} />
        </Avatar>
      )}
    </Group>
  );
};

function TaskProposalCard({ proposal }: { proposal: NonNullable<ChatMessage['taskProposal']> }) {
  const isIncoming = proposal.direction === 'incoming';
  return (
    <Paper withBorder radius="md" p="md" maw={460}>
      <Stack gap="sm">
        <Group justify="space-between" gap="md">
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            {isIncoming ? 'Incoming Task' : 'Task Execution'}
          </Text>
          <Badge
            color={proposal.status === 'completed' ? 'green' : 'blue'}
            leftSection={proposal.status === 'completed' ? <CheckCircle2 size={12} /> : <Loader size={10} />}
          >
            {proposal.status}
          </Badge>
        </Group>
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs">
            <ThemeIcon variant="light" color={isIncoming ? 'teal' : 'gray'}><Monitor size={16} /></ThemeIcon>
            <ThemeIcon variant="light" color={isIncoming ? 'gray' : 'teal'}><Laptop size={16} /></ThemeIcon>
          </Group>
          <Box ta="right" miw={0}>
            <Text size="sm" fw={600} truncate>{proposal.targetDeviceName}</Text>
            <Text size="xs" c="dimmed" ff="monospace" truncate>{proposal.targetDeviceId}</Text>
          </Box>
        </Group>
        <Paper radius="md" p="sm" style={{ background: 'var(--agswarm-surface-muted)' }}>
          <Group justify="space-between">
            <Text size="xs" c="dimmed" fw={600}>Action</Text>
            <Text size="xs" fw={700}>{proposal.taskType}</Text>
          </Group>
          <Text mt={4} size="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {proposal.payload}
          </Text>
        </Paper>
        {proposal.result && (
          <Paper withBorder radius="md" p="sm">
            <Text size="xs" fw={700} c="green">Result</Text>
            <Text mt={4} size="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{proposal.result}</Text>
            {proposal.preview && (
              <Group mt="sm" gap="xs">
                <ImageIcon size={14} />
                <Text size="xs" truncate>{proposal.preview.name}</Text>
              </Group>
            )}
          </Paper>
        )}
      </Stack>
    </Paper>
  );
}

function getMentionQuery(input: string): string | null {
  const match = input.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

function replaceActiveMention(input: string, value: string): string {
  return input.replace(/(?:^|\s)@([^\s@]*)$/, match => {
    const leadingSpace = match.startsWith(' ') ? ' ' : '';
    return `${leadingSpace}@${value} `;
  });
}
