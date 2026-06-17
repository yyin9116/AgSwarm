import { useMemo, useState } from 'react';
import type { DragEvent, FC } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DeviceAliasSettings } from '../lib/settingsStore';
import {
  Check,
  CheckCircle2,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileUp,
  FileVideo,
  Image as ImageIcon,
  Laptop,
  Monitor,
  Pencil,
  RefreshCw,
  Search,
  Smartphone,
  X,
  XCircle,
} from 'lucide-react';
import { DeviceDetailsModal } from './DeviceDetailsModal';

export interface Device {
  id: string;
  name: string;
  type: 'laptop' | 'desktop' | 'mobile';
  os: string;
  status: 'online' | 'offline' | 'transferring' | 'idle';
  ipAddress?: string;
  storage?: string;
  networkType?: 'Wi-Fi' | 'Bluetooth' | 'Ethernet';
  backgroundTasks?: string[];
  recentTasks?: RecentTask[];
  activeTask?: {
    type: string;
    status: 'receiving' | 'executing';
  } | null;
}

export interface RecentTask {
  task_id: string;
  adapter: string;
  status: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  input_text?: string;
  user_message?: string | null;
  last_event_type?: string | null;
  result?: string | null;
}

export interface FileTransfer {
  id: string;
  fileName: string;
  targetDeviceName: string;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  size: string;
}

interface DevicesViewProps {
  devices: Device[];
  transfers?: FileTransfer[];
  onSelectDevice: (device: Device, file?: File) => void;
  onDropFilesToDevice?: (device: Device, files: File[]) => void;
  externalDragOverDeviceId?: string;
  deliveryAnimation?: { deviceId: string; fileName: string; id: number } | null;
  onCancelTransfer?: (transferId: string) => void;
  onRefreshDevices?: () => void;
  isRefreshing?: boolean;
  statusMessage?: string;
  localNodeId?: string;
  deviceAliases?: Record<string, DeviceAliasSettings>;
  onDeviceAliasesChange?: (aliases: Record<string, DeviceAliasSettings>) => void;
  onRenameLocalDevice?: (name: string) => void;
}

export function DevicesView({
  devices,
  transfers = [],
  onSelectDevice,
  onDropFilesToDevice,
  externalDragOverDeviceId,
  deliveryAnimation,
  onCancelTransfer,
  onRefreshDevices,
  isRefreshing = false,
  statusMessage = '',
  localNodeId,
  deviceAliases = {},
  onDeviceAliasesChange,
  onRenameLocalDevice,
}: DevicesViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDeviceDetails, setSelectedDeviceDetails] = useState<Device | null>(null);
  const [dragOverDevice, setDragOverDevice] = useState<string | null>(null);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const filteredDevices = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return devices.filter(device =>
      device.name.toLowerCase().includes(query) ||
      device.id.toLowerCase().includes(query) ||
      Boolean(device.ipAddress?.toLowerCase().includes(query)),
    );
  }, [devices, searchQuery]);

  const commitEditingDevice = () => {
    const name = editingName.trim();
    if (name && editingDeviceId === localNodeId) {
      onRenameLocalDevice?.(name);
      notifications.show({ color: 'teal', title: 'Device name updated', message: name });
    } else if (name && editingDeviceId) {
      onDeviceAliasesChange?.({
        ...deviceAliases,
        [editingDeviceId]: {
          ...deviceAliases[editingDeviceId],
          displayName: name,
        },
      });
      notifications.show({ color: 'teal', title: 'Device remark updated', message: name });
    }
    setEditingDeviceId(null);
    setEditingName('');
  };

  const handleDrop = (event: DragEvent, device: Device) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverDevice(null);
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length && onDropFilesToDevice) {
      onDropFilesToDevice(device, files);
      return;
    }
    const file = files[0];
    if (file) onSelectDevice(device, file);
  };

  return (
    <Stack maw={920} mx="auto" px="md" py="xl" gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Text fw={700} size="xl">Nearby Devices</Text>
          <Text c="dimmed" size="sm">Select a device to send tasks or files.</Text>
        </div>
        <Button
          variant="light"
          color="teal"
          leftSection={<RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />}
          onClick={onRefreshDevices}
          disabled={!onRefreshDevices || isRefreshing}
        >
          Refresh
        </Button>
      </Group>

      {statusMessage && (
        <Paper withBorder radius="md" p="sm">
          <Text size="sm" c="dimmed">{statusMessage}</Text>
        </Paper>
      )}

      <TextInput
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.currentTarget.value)}
        leftSection={<Search size={16} />}
        placeholder="Search devices by name, node id, or endpoint..."
        radius="md"
      />

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {filteredDevices.map(device => (
          <DeviceCard
            key={device.id}
            device={device}
            localNodeId={localNodeId}
            dragOver={dragOverDevice === device.id || externalDragOverDeviceId === device.id}
            deliveringFileName={deliveryAnimation?.deviceId === device.id ? deliveryAnimation.fileName : undefined}
            editing={editingDeviceId === device.id}
            editingName={editingName}
            onEditingNameChange={setEditingName}
            onEditStart={() => {
              setEditingDeviceId(device.id);
              setEditingName(device.name);
            }}
            onEditCancel={() => setEditingDeviceId(null)}
            onEditCommit={commitEditingDevice}
            onOpenDetails={() => setSelectedDeviceDetails(device)}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragOverDevice(device.id);
            }}
            onDragLeave={() => setDragOverDevice(null)}
            onDrop={(event) => handleDrop(event, device)}
            canRename={Boolean(device.id === localNodeId ? onRenameLocalDevice : onDeviceAliasesChange)}
          />
        ))}
      </SimpleGrid>

      {filteredDevices.length === 0 && (
        <Paper withBorder radius="md" p="xl" ta="center">
          <Text fw={600}>{devices.length === 0 ? 'No online peer nodes yet' : `No devices found matching "${searchQuery}"`}</Text>
          <Text mt={4} size="sm" c="dimmed">
            {devices.length === 0 ? 'Start another AgSwarm client on the same NATS network, then refresh discovery.' : 'Try a different device name, node id, or endpoint.'}
          </Text>
        </Paper>
      )}

      {transfers.length > 0 && (
        <Stack gap="sm">
          <Text fw={700} size="lg">Transfer Queue</Text>
          {transfers.map(transfer => (
            <TransferRow key={transfer.id} transfer={transfer} onCancelTransfer={onCancelTransfer} />
          ))}
        </Stack>
      )}

      <DeviceDetailsModal
        device={selectedDeviceDetails}
        onClose={() => setSelectedDeviceDetails(null)}
        onSendTask={(device) => {
          setSelectedDeviceDetails(null);
          onSelectDevice(device);
        }}
      />
    </Stack>
  );
}

const DeviceCard: FC<{
  device: Device;
  localNodeId?: string;
  dragOver: boolean;
  deliveringFileName?: string;
  editing: boolean;
  editingName: string;
  onEditingNameChange: (value: string) => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditCommit: () => void;
  onOpenDetails: () => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
  canRename: boolean;
}> = ({
  device,
  localNodeId,
  dragOver,
  deliveringFileName,
  editing,
  editingName,
  onEditingNameChange,
  onEditStart,
  onEditCancel,
  onEditCommit,
  onOpenDetails,
  onDragOver,
  onDragLeave,
  onDrop,
  canRename,
}) => {
  return (
    <Card
      data-device-drop-id={device.id}
      className={dragOver ? 'agswarm-device-card is-drop-target' : 'agswarm-device-card'}
      withBorder
      radius="md"
      p="md"
      role="button"
      tabIndex={0}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onOpenDetails();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        cursor: 'pointer',
        outlineOffset: 3,
      }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <ThemeIcon size={48} radius="md" variant="light" color={device.activeTask ? 'teal' : 'gray'}>
            {device.type === 'laptop' && <Laptop size={24} />}
            {device.type === 'desktop' && <Monitor size={24} />}
            {device.type === 'mobile' && <Smartphone size={24} />}
          </ThemeIcon>
          <Badge color={statusColor(device.status)} variant="light" leftSection={device.status === 'transferring' ? <RefreshCw size={10} /> : undefined}>
            {device.status}
          </Badge>
        </Group>

        {dragOver ? (
          <div className="agswarm-device-drop-guide">
            <FileUp size={18} />
            <span>Release to send here</span>
          </div>
        ) : (
          <Badge color="gray" variant="light" leftSection={<FileUp size={12} />}>Drop files here</Badge>
        )}

        {deliveringFileName && (
          <div className="agswarm-device-delivery">
            <FileUp size={15} />
            <Text size="xs" fw={700} truncate>Sending {deliveringFileName}</Text>
          </div>
        )}

        {editing ? (
          <Group gap="xs" onClick={(event) => event.stopPropagation()} wrap="nowrap">
            <TextInput
              autoFocus
              value={editingName}
              onChange={(event) => onEditingNameChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onEditCommit();
                if (event.key === 'Escape') onEditCancel();
              }}
              flex={1}
            />
            <ActionIcon color="teal" aria-label="Save device name" onClick={onEditCommit}><Check size={16} /></ActionIcon>
          </Group>
        ) : (
          <Group gap="xs" wrap="nowrap">
            <div style={{ minWidth: 0, flex: 1 }}>
              <Text fw={700} truncate>{device.name}</Text>
              <Text size="sm" c="dimmed" ff="monospace" truncate>{device.ipAddress || device.id}</Text>
            </div>
            {canRename && (
              <Tooltip label="Edit device name">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Edit device name"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditStart();
                  }}
                >
                  <Pencil size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        )}

        {device.id === localNodeId && <Badge color="teal" variant="outline">This client</Badge>}

        {device.activeTask && (
          <Paper withBorder radius="md" p="sm">
            <Group gap="sm">
              <RefreshCw size={16} className="animate-spin" />
              <Text size="sm">{device.activeTask.status === 'receiving' ? 'Receiving task...' : `Executing ${device.activeTask.type}...`}</Text>
            </Group>
          </Paper>
        )}
      </Stack>
    </Card>
  );
};

const TransferRow: FC<{ transfer: FileTransfer; onCancelTransfer?: (transferId: string) => void }> = ({ transfer, onCancelTransfer }) => {
  return (
    <Paper withBorder radius="md" p="md">
      <Group gap="md" wrap="nowrap">
        <ThemeIcon variant="light" color={transferColor(transfer.status)}>{transferIcon(transfer)}</ThemeIcon>
        <Stack gap={4} flex={1} miw={0}>
          <Group justify="space-between" gap="sm" wrap="nowrap">
            <Text size="sm" fw={600} truncate>{transfer.fileName}</Text>
            <Text size="xs" c="dimmed">{transfer.size}</Text>
          </Group>
          <Group justify="space-between" gap="sm">
            <Text size="xs" c="dimmed">To: {transfer.targetDeviceName}</Text>
            <Group gap="xs">
              <Badge size="xs" color={transferColor(transfer.status)} variant="light">{transfer.status}</Badge>
              {(transfer.status === 'pending' || transfer.status === 'transferring') && onCancelTransfer && (
                <ActionIcon size="xs" variant="subtle" color="red" aria-label="Cancel transfer" onClick={() => onCancelTransfer(transfer.id)}>
                  <X size={12} />
                </ActionIcon>
              )}
            </Group>
          </Group>
          <Progress value={transfer.progress} color={transferColor(transfer.status)} size="xs" radius="xl" />
        </Stack>
      </Group>
    </Paper>
  );
};

function transferIcon(transfer: FileTransfer) {
  if (transfer.status === 'completed') return <CheckCircle2 size={18} />;
  if (transfer.status === 'failed') return <XCircle size={18} />;
  const ext = transfer.fileName.split('.').pop()?.toLowerCase() || '';
  if (['zip', 'rar', 'tar', 'gz'].includes(ext)) return <FileArchive size={18} />;
  if (['pdf', 'txt', 'md', 'doc', 'docx'].includes(ext)) return <FileText size={18} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) return <ImageIcon size={18} />;
  if (['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json'].includes(ext)) return <FileCode size={18} />;
  if (['mp3', 'wav', 'ogg'].includes(ext)) return <FileAudio size={18} />;
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return <FileVideo size={18} />;
  return <File size={18} />;
}

function statusColor(status: Device['status']) {
  if (status === 'online') return 'green';
  if (status === 'transferring') return 'blue';
  if (status === 'idle') return 'yellow';
  return 'gray';
}

function transferColor(status: FileTransfer['status']) {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  return 'blue';
}
