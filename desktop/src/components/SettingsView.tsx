import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Progress,
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
import { Activity, Bot, BrainCircuit, CheckCircle2, Cpu, Download, ExternalLink, FileCode, Folder, Key, MonitorCog, Moon, Power, Radar, RefreshCw, Save, Sun, UserRound } from 'lucide-react';
import type { DeviceAliasSettings, ThemeMode } from '../lib/settingsStore';
import { checkForAppUpdate, installPendingAppUpdate, manualDownloadUrl, type AppUpdateInfo, type UpdateDownloadProgress } from '../lib/updatesService';
import { testAgentProvider } from '../lib/agswarmApi';
import type { AgentProviderTestResult } from '../types/agswarm';
import type { LocalPeerStatus } from '../types/agswarm';

interface SettingsViewProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
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
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState('Check GitHub Releases for signed app updates.');
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<AgentProviderTestResult | null>(null);

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

  const handleCheckForUpdates = async () => {
    setIsCheckingUpdate(true);
    setUpdateProgress(null);
    try {
      const result = await checkForAppUpdate();
      if (result.status === 'available') {
        setUpdateInfo(result.update);
        setUpdateStatus(`Version ${result.update.version} is ready to install.`);
        notifications.show({ color: 'teal', title: 'Update available', message: `AgSwarm ${result.update.version} is ready.` });
      } else {
        setUpdateInfo(null);
        setUpdateStatus(result.message);
        notifications.show({ color: result.status === 'current' ? 'teal' : 'yellow', title: result.status === 'current' ? 'Up to date' : 'Updates unavailable', message: result.message });
      }
    } catch (error) {
      const message = updateErrorMessage(error);
      setUpdateInfo(null);
      setUpdateStatus(message);
      notifications.show({ color: 'red', title: 'Update check failed', message });
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    setIsInstallingUpdate(true);
    setUpdateStatus('Downloading update...');
    try {
      await installPendingAppUpdate(progress => {
        setUpdateProgress(progress);
        if (progress.phase === 'finished') {
          setUpdateStatus('Installing update and restarting AgSwarm...');
        } else if (typeof progress.percent === 'number') {
          setUpdateStatus(`Downloading update: ${progress.percent}%`);
        } else {
          setUpdateStatus('Downloading update...');
        }
      });
    } catch (error) {
      const message = updateErrorMessage(error);
      setUpdateStatus(message);
      notifications.show({ color: 'red', title: 'Update install failed', message });
    } finally {
      setIsInstallingUpdate(false);
    }
  };

  const handleTestModel = async () => {
    setIsTestingModel(true);
    setModelTestResult(null);
    try {
      const result = await testAgentProvider({
        providerUrl,
        apiKey,
        model: modelName,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        temperature: 0,
      });
      setModelTestResult(result);
      notifications.show({
        color: result.ok ? 'teal' : modelTestColor(result.category),
        title: result.ok ? 'Model endpoint ready' : 'Model endpoint check failed',
        message: result.message,
      });
    } catch (error) {
      const result: AgentProviderTestResult = {
        ok: false,
        category: 'provider',
        message: 'Could not run the model endpoint check.',
        detail: formatError(error),
        model: modelName,
        providerUrl,
        durationMs: 0,
      };
      setModelTestResult(result);
      notifications.show({ color: 'red', title: 'Model test failed', message: result.message });
    } finally {
      setIsTestingModel(false);
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
              <Text c="dimmed" size="sm">Follow the system appearance or choose a fixed theme</Text>
            </div>
            <Select
              value={theme}
              onChange={(value) => onThemeChange(isThemeMode(value) ? value : 'system')}
              data={[
                { value: 'system', label: 'Follow system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              leftSection={theme === 'system' ? <MonitorCog size={16} /> : theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
              w={210}
            />
          </Group>
          <TextInput label="Device Name" description="How you appear to others on the local network" value={deviceLabel} onChange={(event) => onDeviceLabelChange(event.currentTarget.value)} />
          <TextInput label="Default Save Path" leftSection={<Folder size={16} />} value={defaultSavePath} onChange={(event) => onDefaultSavePathChange(event.currentTarget.value)} />
        </SettingsCard>

        <SettingsCard icon={<Download size={16} />} title="Software Updates" rightSection={<Badge color={updateInfo ? 'teal' : 'gray'} variant="light">{updateInfo ? 'Available' : 'Stable'}</Badge>}>
          <Stack gap="sm">
            <div>
              <Text fw={600}>Automatic Updates</Text>
              <Text c="dimmed" size="sm">
                Signed releases are checked from GitHub. Installing an update restarts AgSwarm after the download completes.
              </Text>
            </div>
            <Text c={updateInfo ? 'teal' : 'dimmed'} size="sm">{updateStatus}</Text>
            {updateInfo ? (
              <Box className="agswarm-update-notes">
                <Text fw={600} size="sm">AgSwarm {updateInfo.version}</Text>
                {updateInfo.date ? <Text c="dimmed" size="xs">{new Date(updateInfo.date).toLocaleString()}</Text> : null}
                {updateInfo.notes ? <Text size="sm" mt={4}>{updateInfo.notes}</Text> : null}
              </Box>
            ) : null}
            {updateProgress ? (
              <Progress
                value={updateProgress.percent ?? 0}
                animated={isInstallingUpdate && updateProgress.phase !== 'finished'}
                color="teal"
                aria-label="Update download progress"
              />
            ) : null}
            <Group justify="space-between" align="center">
              <Button
                variant="light"
                color="teal"
                leftSection={<RefreshCw size={16} className={isCheckingUpdate ? 'animate-spin' : ''} />}
                onClick={handleCheckForUpdates}
                loading={isCheckingUpdate}
                disabled={isInstallingUpdate}
              >
                Check
              </Button>
              <Group gap="xs">
                <Button
                  variant="subtle"
                  color="gray"
                  leftSection={<ExternalLink size={16} />}
                  component="a"
                  href={manualDownloadUrl()}
                  target="_blank"
                  rel="noreferrer"
                >
                  Releases
                </Button>
                <Button
                  color="teal"
                  leftSection={<Download size={16} />}
                  onClick={handleInstallUpdate}
                  loading={isInstallingUpdate}
                  disabled={!updateInfo || isCheckingUpdate}
                >
                  Install
                </Button>
              </Group>
            </Group>
          </Stack>
        </SettingsCard>

        <SettingsCard icon={<BrainCircuit size={16} />} title="Ag Model Service" rightSection={<Badge color={modelTestResult?.ok ? 'teal' : modelTestResult ? modelTestColor(modelTestResult.category) : 'gray'} variant="light">{modelTestResult?.ok ? 'Ready' : modelTestResult ? 'Needs attention' : 'Untested'}</Badge>}>
          <Text size="sm" c="dimmed">
            Ag uses this OpenAI-compatible endpoint through the local runtime. Test it here before starting a long agent task.
          </Text>
          <TextInput label="Endpoint" description="OpenAI-compatible base URL, for example http://127.0.0.1:15721" value={providerUrl} onChange={(event) => onProviderUrlChange(event.currentTarget.value)} />
          <PasswordInput label="API Key" description="Bearer key for the configured model service" leftSection={<Key size={16} />} value={apiKey} onChange={(event) => onApiKeyChange(event.currentTarget.value)} />
          <Select
            label="Default Model"
            description="Model Ag asks the runtime to use"
            leftSection={<Cpu size={16} />}
            value={modelName}
            onChange={(value) => onModelNameChange(value || 'gpt-5.5')}
            data={['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']}
          />
          {modelTestResult ? (
            <Box className={`agswarm-model-test-result is-${modelTestResult.ok ? 'ok' : modelTestResult.category}`}>
              <Group justify="space-between" gap="xs" align="flex-start">
                <div>
                  <Text fw={700} size="sm">{modelTestResult.message}</Text>
                  <Text c="dimmed" size="xs">
                    {modelTestResult.providerUrl} · {modelTestResult.model} · {modelTestResult.durationMs} ms
                  </Text>
                </div>
                <Badge color={modelTestResult.ok ? 'teal' : modelTestColor(modelTestResult.category)} variant="light">
                  {modelTestLabel(modelTestResult.category)}
                </Badge>
              </Group>
              {modelTestResult.detail ? <Text mt={6} size="xs" c="dimmed">{modelTestResult.detail}</Text> : null}
              {!modelTestResult.ok ? <Text mt={6} size="xs">{modelTestRecovery(modelTestResult.category)}</Text> : null}
            </Box>
          ) : null}
          <Group justify="flex-end">
            <Button
              variant="light"
              color="teal"
              leftSection={isTestingModel ? <RefreshCw size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              onClick={handleTestModel}
              loading={isTestingModel}
            >
              Test Model Endpoint
            </Button>
          </Group>
          <TextInput label="Host Working Directory" description="Base directory used by Ag and local desktop tools. Leave empty to use your AgSwarm workspace folder." leftSection={<Folder size={16} />} value={piCwd} onChange={(event) => onPiCwdChange(event.currentTarget.value)} />
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

function updateErrorMessage(error: unknown): string {
  const message = formatError(error);
  if (/latest\.json|github\.com|releases\/latest\/download|error sending request/i.test(message)) {
    return 'Could not reach the signed update feed on GitHub. Check your network or proxy, then retry; manual downloads are still available from Releases.';
  }
  if (/pubkey|signature|updater/i.test(message)) {
    return 'This build is not configured for signed automatic updates. Use the Releases link or install a build with updater signing enabled.';
  }
  if (/network|fetch|timed out|timeout|dns|resolve/i.test(message)) {
    return 'Could not reach the update server. Check the network connection and try again.';
  }
  return message;
}

function modelTestColor(category: AgentProviderTestResult['category']): string {
  if (category === 'ok') return 'teal';
  if (category === 'auth' || category === 'model') return 'yellow';
  return 'red';
}

function modelTestLabel(category: AgentProviderTestResult['category']): string {
  switch (category) {
    case 'ok':
      return 'OK';
    case 'network':
      return 'Network';
    case 'auth':
      return 'Auth';
    case 'model':
      return 'Model';
    case 'invalid_response':
      return 'Response';
    default:
      return 'Provider';
  }
}

function modelTestRecovery(category: AgentProviderTestResult['category']): string {
  switch (category) {
    case 'network':
      return 'Make sure the local model service is running and the endpoint URL includes the correct protocol and port.';
    case 'auth':
      return 'Check the API key in Settings. Restart Ag after changing credentials if the provider caches auth.';
    case 'model':
      return 'Choose a model name that the provider exposes, then save settings and restart the local node.';
    case 'invalid_response':
      return 'The endpoint must speak the OpenAI chat completions API at /v1/chat/completions.';
    default:
      return 'The service is reachable but unavailable. Check provider quota, routing, and backend logs.';
  }
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
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
