import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Activity, Bot, BrainCircuit, CheckCircle2, Cpu, FileCode, Folder, Key, Moon, Power, Radar, RefreshCw, Save, Sun, UserRound } from 'lucide-react';
import type { DeviceAliasSettings } from '../lib/settingsStore';
import type { LocalPeerStatus } from '../types/agswarm';

interface SettingsViewProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  providerUrl: string;
  onProviderUrlChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  modelName: string;
  onModelNameChange: (value: string) => void;
  natsUrl: string;
  onNatsUrlChange: (value: string) => void;
  nodeId: string;
  onNodeIdChange: (value: string) => void;
  deviceLabel: string;
  onDeviceLabelChange: (value: string) => void;
  userDisplayName: string;
  onUserDisplayNameChange: (value: string) => void;
  userAvatarSeed: string;
  onUserAvatarSeedChange: (value: string) => void;
  agDisplayName: string;
  onAgDisplayNameChange: (value: string) => void;
  agAvatarSeed: string;
  onAgAvatarSeedChange: (value: string) => void;
  deviceAliases: Record<string, DeviceAliasSettings>;
  onDeviceAliasesChange: (value: Record<string, DeviceAliasSettings>) => void;
  enablePi: boolean;
  onEnablePiChange: (value: boolean) => void;
  localPeerStatus: LocalPeerStatus | null;
  onRestartLocalPeer: () => Promise<void>;
  latexMcpDir: string;
  onLatexMcpDirChange: (value: string) => void;
  piCwd: string;
  onPiCwdChange: (value: string) => void;
  defaultSavePath: string;
  onDefaultSavePathChange: (value: string) => void;
  agentSkills: string;
  onAgentSkillsChange: (value: string) => void;
}

export function SettingsView({
  theme,
  onThemeChange,
  providerUrl,
  onProviderUrlChange,
  apiKey,
  onApiKeyChange,
  modelName,
  onModelNameChange,
  natsUrl,
  onNatsUrlChange,
  nodeId,
  onNodeIdChange,
  deviceLabel,
  onDeviceLabelChange,
  userDisplayName,
  onUserDisplayNameChange,
  userAvatarSeed,
  onUserAvatarSeedChange,
  agDisplayName,
  onAgDisplayNameChange,
  agAvatarSeed,
  onAgAvatarSeedChange,
  deviceAliases,
  onDeviceAliasesChange,
  enablePi,
  onEnablePiChange,
  localPeerStatus,
  onRestartLocalPeer,
  latexMcpDir,
  onLatexMcpDirChange,
  piCwd,
  onPiCwdChange,
  defaultSavePath,
  onDefaultSavePathChange,
  agentSkills,
  onAgentSkillsChange,
}: SettingsViewProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [isRestartingPeer, setIsRestartingPeer] = useState(false);

  const restartPeer = async (showNotification: boolean) => {
    setIsRestartingPeer(true);
    try {
      await onRestartLocalPeer();
      if (showNotification) notifications.show({ color: 'teal', title: 'Local node restarted', message: 'Settings have been applied.' });
    } catch (error) {
      notifications.show({ color: 'red', title: 'Restart failed', message: formatError(error) });
      throw error;
    } finally {
      setIsRestartingPeer(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await restartPeer(false);
      notifications.show({ color: 'teal', title: 'Settings saved', message: 'Local peer settings were applied.' });
    } catch (error) {
      notifications.show({ color: 'red', title: 'Settings not saved', message: formatError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box className="agswarm-settings-scroll">
      <Stack maw={860} mx="auto" px="md" py="xl" pb={120} gap="lg">
        <Group justify="space-between" align="center">
          <Text fw={700} size="xl">Settings</Text>
          <Button
            color="teal"
            leftSection={isSaving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
            onClick={handleSave}
            loading={isSaving}
          >
            Save Changes
          </Button>
        </Group>

        <SettingsCard icon={<UserRound size={16} />} title="Profile">
          <TextInput
            label="Your Name"
            description="Name shown on your own chat bubbles"
            value={userDisplayName}
            onChange={(event) => onUserDisplayNameChange(event.currentTarget.value)}
          />
          <TextInput
            label="Your Avatar Seed"
            description="Initials or words used to generate your avatar"
            value={userAvatarSeed}
            onChange={(event) => onUserAvatarSeedChange(event.currentTarget.value)}
          />
          <TextInput
            label="Ag Nickname"
            description="Everyday name for AgSwarm AI in chat"
            leftSection={<Bot size={16} />}
            value={agDisplayName}
            onChange={(event) => onAgDisplayNameChange(event.currentTarget.value)}
          />
          <TextInput
            label="Ag Avatar Seed"
            description="Initials or words used to generate Ag's avatar"
            value={agAvatarSeed}
            onChange={(event) => onAgAvatarSeedChange(event.currentTarget.value)}
          />
          <Textarea
            label="Device Remarks"
            description="Persistent remarks for discovered devices. Use one node id per line: node-id = display name | avatar seed"
            autosize
            minRows={3}
            value={deviceAliasesToText(deviceAliases)}
            onChange={(event) => onDeviceAliasesChange(deviceAliasesFromText(event.currentTarget.value))}
          />
        </SettingsCard>

        <SettingsCard icon={<Sun size={16} />} title="General">
          <Group justify="space-between" align="center">
            <div>
              <Text fw={600}>Appearance</Text>
              <Text c="dimmed" size="sm">Toggle dark mode</Text>
            </div>
            <Select
              value={theme}
              onChange={(value) => onThemeChange(value === 'dark' ? 'dark' : 'light')}
              data={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              leftSection={theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
              w={180}
            />
          </Group>
          <TextInput label="Device Name" description="How you appear to others on the local network" value={deviceLabel} onChange={(event) => onDeviceLabelChange(event.currentTarget.value)} />
          <TextInput label="Default Save Path" leftSection={<Folder size={16} />} value={defaultSavePath} onChange={(event) => onDefaultSavePathChange(event.currentTarget.value)} />
        </SettingsCard>

        <SettingsCard icon={<BrainCircuit size={16} />} title="AI & Agent Configuration">
          <PasswordInput label="API Key" description="Bearer key for the local OpenAI-compatible provider" leftSection={<Key size={16} />} value={apiKey} onChange={(event) => onApiKeyChange(event.currentTarget.value)} />
          <Select
            label="Default Model"
            description="Model used for reasoning"
            leftSection={<Cpu size={16} />}
            value={modelName}
            onChange={(value) => onModelNameChange(value || 'gpt-5.5')}
            data={['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']}
          />
          <TextInput label="Host Working Directory" description="Base directory used by pi and local desktop tools. Leave empty to use the AgSwarm repo." leftSection={<Folder size={16} />} value={piCwd} onChange={(event) => onPiCwdChange(event.currentTarget.value)} />
          <Textarea label="Agent Skills" description="Comma-separated list of allowed skills" autosize minRows={3} value={agentSkills} onChange={(event) => onAgentSkillsChange(event.currentTarget.value)} />
        </SettingsCard>

        <SettingsCard icon={<Power size={16} />} title="Local Agent Node" rightSection={<Badge color={localPeerStatus?.nodeRunning ? 'green' : 'red'} variant="light">{localPeerStatus?.nodeRunning ? 'Running' : 'Stopped'}</Badge>}>
          <TextInput label="Local Node ID" description="Unique identity for this installed client" value={nodeId} onChange={(event) => onNodeIdChange(event.currentTarget.value)} />
          <Switch
            label="pi Agent Harness"
            description="Expose earendil-works/pi tasks on this client"
            checked={enablePi}
            onChange={(event) => onEnablePiChange(event.currentTarget.checked)}
            color="teal"
          />
          <Group justify="space-between" align="center" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Activity size={16} />
                <Text fw={600}>Runtime Status</Text>
              </Group>
              <Text c="dimmed" size="sm" truncate>{localPeerStatus?.message || 'Starting local peer...'}</Text>
              <Text c="dimmed" size="xs" ff="monospace">NATS: {localPeerStatus?.natsManaged ? 'managed local' : 'external or already running'}</Text>
            </div>
            <Button
              variant="light"
              color="teal"
              leftSection={<RefreshCw size={16} className={isRestartingPeer ? 'animate-spin' : ''} />}
              onClick={() => restartPeer(true)}
              loading={isRestartingPeer}
            >
              Restart
            </Button>
          </Group>
        </SettingsCard>

        <SettingsCard icon={<Radar size={16} />} title="Network">
          <TextInput label="Agent Provider" description="Local OpenAI-compatible HTTP endpoint" value={providerUrl} onChange={(event) => onProviderUrlChange(event.currentTarget.value)} />
          <TextInput label="NATS Server" description="Control plane address" value={natsUrl} onChange={(event) => onNatsUrlChange(event.currentTarget.value)} />
          <TextInput label="LaTeX MCP Dir" description="Required for live LaTeX compile tasks" leftSection={<FileCode size={16} />} value={latexMcpDir} onChange={(event) => onLatexMcpDirChange(event.currentTarget.value)} />
        </SettingsCard>
      </Stack>
    </Box>
  );
}

function deviceAliasesToText(aliases: Record<string, DeviceAliasSettings>): string {
  return Object.entries(aliases)
    .map(([nodeId, alias]) => {
      const displayName = alias.displayName || '';
      const avatarSeed = alias.avatarSeed || '';
      return avatarSeed ? `${nodeId} = ${displayName} | ${avatarSeed}` : `${nodeId} = ${displayName}`;
    })
    .filter(Boolean)
    .join('\n');
}

function deviceAliasesFromText(value: string): Record<string, DeviceAliasSettings> {
  const aliases: Record<string, DeviceAliasSettings> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.includes('=') ? '=' : ':';
    const [nodeId, ...rest] = trimmed.split(separator);
    const [displayName = '', avatarSeed = ''] = rest.join(separator).split('|').map(part => part.trim());
    if (nodeId.trim() && (displayName || avatarSeed)) aliases[nodeId.trim()] = { displayName, avatarSeed };
  }
  return aliases;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SettingsCard({
  icon,
  title,
  rightSection,
  children,
}: {
  icon: ReactNode;
  title: string;
  rightSection?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Group gap="sm">
            <ThemeIcon variant="light" color="teal">{icon}</ThemeIcon>
            <Text fw={700}>{title}</Text>
          </Group>
          {rightSection}
        </Group>
        {children}
      </Stack>
    </Card>
  );
}
