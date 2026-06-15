import {
  Accordion,
  Badge,
  Box,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock, FileText, FileUp, MessageSquare, Monitor, XCircle } from 'lucide-react';

export interface Task {
  id: string;
  type: 'Echo' | 'LaTeX' | 'Agent' | 'File';
  target: string;
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'running' | 'failed';
  time: string;
  detail: string;
  result?: string;
  filePreview?: {
    type: 'image' | 'pdf';
    url: string;
    name: string;
  };
}

interface TasksViewProps {
  tasks: Task[];
}

export function TasksView({ tasks }: TasksViewProps) {
  return (
    <Stack maw={860} mx="auto" px="md" py="xl" gap="lg">
      <Text fw={700} size="xl">Activity</Text>

      {tasks.length === 0 ? (
        <Paper withBorder radius="md" p="xl" ta="center">
          <Text fw={600}>No task activity yet</Text>
          <Text mt={4} size="sm" c="dimmed">Send a message to another device or dispatch a task to see activity here.</Text>
        </Paper>
      ) : (
        <Accordion variant="separated" radius="md">
          {tasks.map(task => (
            <Accordion.Item key={task.id} value={task.id}>
              <Accordion.Control>
                <Group gap="md" wrap="nowrap">
                  <TaskIcon task={task} />
                  <Box flex={1} miw={0}>
                    <Group justify="space-between" gap="sm" wrap="nowrap">
                      <Text fw={600} truncate>
                        {task.type} {task.direction === 'incoming' ? 'from' : 'to'} {task.target}
                      </Text>
                      <Text size="xs" c="dimmed">{task.time}</Text>
                    </Group>
                    <Text size="sm" c="dimmed" truncate>{task.detail}</Text>
                  </Box>
                  <Badge color={statusColor(task.status)} variant="light">{task.status}</Badge>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="md">
                  <Group grow align="stretch">
                    <Detail label="Task ID" value={task.id} mono />
                    <Detail label="Status" value={<Badge color={statusColor(task.status)} variant="light">{task.status}</Badge>} />
                  </Group>
                  <Detail label="Payload / Detail" value={task.detail} mono block />
                  {task.status === 'completed' && (
                    <Detail label="Result" value={task.result || 'Task execution completed successfully.'} mono block color="green" />
                  )}
                  {task.filePreview && (
                    <Paper withBorder radius="md" p="sm">
                      {task.filePreview.type === 'image' ? (
                        <Image src={task.filePreview.url} alt={task.filePreview.name} radius="sm" mah={220} fit="contain" />
                      ) : (
                        <Group gap="sm">
                          <ThemeIcon color="red" variant="light"><FileText size={16} /></ThemeIcon>
                          <Text size="sm" fw={600}>{task.filePreview.name}</Text>
                        </Group>
                      )}
                    </Paper>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
    </Stack>
  );
}

function TaskIcon({ task }: { task: Task }) {
  return (
    <Box pos="relative">
      <ThemeIcon size={42} radius="xl" variant="light" color={statusColor(task.status)}>
        {task.type === 'Echo' && <MessageSquare size={20} />}
        {task.type === 'LaTeX' && <FileText size={20} />}
        {task.type === 'Agent' && <Monitor size={20} />}
        {task.type === 'File' && <FileUp size={20} />}
      </ThemeIcon>
      <ThemeIcon
        size={18}
        radius="xl"
        color={task.direction === 'incoming' ? 'indigo' : 'teal'}
        pos="absolute"
        bottom={-2}
        right={-2}
      >
        {task.direction === 'incoming' ? <ArrowDownLeft size={10} /> : <ArrowUpRight size={10} />}
      </ThemeIcon>
    </Box>
  );
}

function Detail({
  label,
  value,
  mono = false,
  block = false,
  color,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  block?: boolean;
  color?: string;
}) {
  return (
    <Paper withBorder radius="md" p="sm" style={color ? { background: 'var(--agswarm-surface-muted)' } : undefined}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">{label}</Text>
      {typeof value === 'string' ? (
        <Text mt={4} size="sm" ff={mono ? 'monospace' : undefined} style={{ whiteSpace: block ? 'pre-wrap' : undefined, overflowWrap: 'anywhere' }}>
          {value}
        </Text>
      ) : (
        <Box mt={4}>{value}</Box>
      )}
    </Paper>
  );
}

function statusColor(status: Task['status']) {
  if (status === 'completed') return 'green';
  if (status === 'running') return 'blue';
  return 'red';
}
