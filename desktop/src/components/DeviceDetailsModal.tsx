import {
  Badge,
  Button,
  Group,
  List,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import type { ReactNode } from 'react';
import { Activity, Bluetooth, Cable, HardDrive, Laptop, Layers, Monitor, Network, Smartphone, Wifi } from 'lucide-react';
import type { Device } from './DevicesView';

interface DeviceDetailsModalProps {
  device: Device | null;
  onClose: () => void;
  onSendTask?: (device: Device) => void;
}

export function DeviceDetailsModal({ device, onClose, onSendTask }: DeviceDetailsModalProps) {
  return (
    <Modal opened={Boolean(device)} onClose={onClose} title="Device Details" centered radius="md" size="lg">
      {device && (
        <Stack gap="lg">
          <Group gap="md" wrap="nowrap">
            <ThemeIcon size={64} radius="md" variant="light" color="teal">
              {device.type === 'laptop' && <Laptop size={32} />}
              {device.type === 'desktop' && <Monitor size={32} />}
              {device.type === 'mobile' && <Smartphone size={32} />}
            </ThemeIcon>
            <div>
              <Text fw={700} size="xl">{device.name}</Text>
              <Text c="dimmed" size="sm">{device.os}</Text>
            </div>
          </Group>

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <DetailItem icon={<Network size={16} />} label="Endpoint" value={device.ipAddress || 'Unknown'} mono />
            <DetailItem icon={<HardDrive size={16} />} label="Queue" value={device.storage || 'Unknown'} />
            <DetailItem
              icon={<Activity size={16} />}
              label="AgSwarm Status"
              value={<Badge color={statusColor(device.status)} variant="light">{device.status}</Badge>}
            />
            <DetailItem
              icon={device.networkType === 'Wi-Fi' ? <Wifi size={16} /> : device.networkType === 'Bluetooth' ? <Bluetooth size={16} /> : <Cable size={16} />}
              label="Network"
              value={device.networkType || 'Unknown'}
            />
          </SimpleGrid>

          {device.backgroundTasks?.length ? (
            <DetailItem
              icon={<Layers size={16} />}
              label="Capabilities"
              value={(
                <List size="sm" spacing={4}>
                  {device.backgroundTasks.map(task => <List.Item key={task}>{task}</List.Item>)}
                </List>
              )}
            />
          ) : null}

          {device.activeTask && (
            <DetailItem
              icon={<Activity size={16} />}
              label="Active Task"
              value={(
                <Group gap="xs">
                  <Text size="sm" fw={600}>{device.activeTask.type}</Text>
                  <Badge color="teal" variant="light">{device.activeTask.status}</Badge>
                </Group>
              )}
            />
          )}

          <Group grow>
            <Button variant="default" onClick={onClose}>Close</Button>
            <Button color="teal" onClick={() => onSendTask?.(device)}>Send Task</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function DetailItem({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <Stack gap={4} p="md" style={{ borderRadius: 8, background: 'var(--agswarm-surface-muted)' }}>
      <Group gap="xs" c="dimmed">
        {icon}
        <Text size="xs" fw={700} tt="uppercase">{label}</Text>
      </Group>
      {typeof value === 'string' ? (
        <Text size="sm" ff={mono ? 'monospace' : undefined} style={{ overflowWrap: 'anywhere' }}>{value}</Text>
      ) : value}
    </Stack>
  );
}

function statusColor(status: Device['status']) {
  if (status === 'online') return 'green';
  if (status === 'transferring') return 'blue';
  if (status === 'idle') return 'yellow';
  return 'gray';
}
