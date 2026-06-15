import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radar, ArrowRightLeft, Settings, MessageSquareText } from 'lucide-react';
import { ActionIcon, Group, Loader, MantineProvider, Paper, Stack, Tooltip } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { DevicesView, Device, FileTransfer, RecentTask } from './components/DevicesView';
import { TasksView, Task } from './components/TasksView';
import { SettingsView } from './components/SettingsView';
import { SendModal } from './components/SendModal';
import {
  getLocalPeerStatus,
  getRuntimeConfig,
  getSystemDeviceName,
  runAgSwarmCli,
  setWindowTitle,
  startLocalPeer,
  writeFrontendDebugLog,
} from './lib/agswarmApi';
import {
  deviceFromLocalPeerStatus,
  deviceFromSnapshot,
  mergeDiscoveredWithLocal,
  mergeTasks,
  taskDetail,
  taskFromRecentTask,
  upsertDevice,
} from './lib/agswarmMappers';
import { loadAppSettings, saveAppSettings, type AppSettings, type DeviceAliasSettings } from './lib/settingsStore';
import { runTaskCommand, summarizeCliResult } from './lib/taskDispatch';
import type { DiscoverNodesResponse, LocalPeerStatus, NodeSnapshotDto, RuntimeConfig, SendTaskData } from './types/agswarm';

const DEFAULT_PROVIDER_URL = import.meta.env.VITE_AGENT_PROVIDER_URL || 'http://127.0.0.1:15721';
const DEFAULT_AGENT_MODEL = import.meta.env.VITE_AGENT_MODEL || 'gpt-5.5';
const DEFAULT_AGENT_API_KEY = import.meta.env.VITE_AGENT_API_KEY || 'local-dev-key';
const DEFAULT_NATS_URL = import.meta.env.VITE_NATS_URL || 'nats://127.0.0.1:4222';
const DEFAULT_LATEX_MCP_DIR = import.meta.env.VITE_LATEX_MCP_DIR || '';
const LOCAL_STATUS_ACTIVE_MS = 12_000;
const LOCAL_STATUS_BACKGROUND_MS = 45_000;
const DEVICE_REFRESH_ACTIVE_MS = 20_000;
const DEVICE_REFRESH_ON_ENTER_DELAY_MS = 520;

function piProviderFromSetting(providerUrl: string): string {
  const value = providerUrl.trim();
  if (!value) return 'local-openai';
  return /^https?:\/\//i.test(value) ? 'local-openai' : value;
}

const DEFAULT_SETTINGS: AppSettings = {
  providerUrl: DEFAULT_PROVIDER_URL,
  agentModel: DEFAULT_AGENT_MODEL,
  agentApiKey: DEFAULT_AGENT_API_KEY,
  natsUrl: DEFAULT_NATS_URL,
  latexMcpDir: DEFAULT_LATEX_MCP_DIR,
  piCwd: '',
  defaultSavePath: '~/Downloads/AgentTasks',
  agentSkills: 'safe_default',
  enablePi: true,
  theme: 'light',
  userDisplayName: 'You',
  userAvatarSeed: 'You',
  agDisplayName: 'Ag',
  agAvatarSeed: 'Ag',
  deviceAliases: {},
};
const PiWebNativeChatView = lazy(() =>
  import('./components/PiWebNativeChatView').then(module => ({ default: module.PiWebNativeChatView })),
);

export default function App() {
  const [currentTab, setCurrentTab] = useState('chat');
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [selectedFileForDevice, setSelectedFileForDevice] = useState<File | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [settings, setSettings] = useState(() => loadAppSettings(DEFAULT_SETTINGS));
  const {
    theme,
    providerUrl,
    agentModel,
    agentApiKey,
    natsUrl,
    latexMcpDir,
    piCwd,
    defaultSavePath,
    agentSkills,
    enablePi,
    userDisplayName,
    userAvatarSeed,
    agDisplayName,
    agAvatarSeed,
    deviceAliases,
  } = settings;
  const [nodeId, setNodeId] = useState(getStoredNodeId);
  const [deviceLabel, setDeviceLabel] = useState(getDefaultDeviceLabel);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [runtimeConfigLoaded, setRuntimeConfigLoaded] = useState(false);
  const [localPeerStatus, setLocalPeerStatus] = useState<LocalPeerStatus | null>(null);
  const [localPeerStatusForMerge, setLocalPeerStatusForMerge] = useState<LocalPeerStatus | null>(null);
  const localPeerStatusForMergeRef = useRef<LocalPeerStatus | null>(null);
  const [deviceStatusMessage, setDeviceStatusMessage] = useState('No devices loaded yet. Refresh to query NATS.');
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const hasStartedLocalPeerRef = useRef(false);
  const isDeviceSurfaceActive = currentTab === 'devices';

  useEffect(() => {
    localPeerStatusForMergeRef.current = localPeerStatusForMerge;
  }, [localPeerStatusForMerge]);

  useEffect(() => {
    saveAppSettings(settings);
  }, [settings]);

  useEffect(() => {
    setDevices(prev => applyDeviceAliases(prev, deviceAliases));
  }, [deviceAliases]);

  useEffect(() => {
    const dump = (label = 'app-dom') => {
      const snapshot = createAppDomSnapshot(currentTab);
      void writeFrontendDebugLog({ label, payload: snapshot }).catch(error => {
        console.warn('[agswarm:frontend-debug]', error);
      });
      return snapshot;
    };
    const debugWindow = window as typeof window & {
      __AGSWARM_APP_DOM_SNAPSHOT__?: (label?: string) => ReturnType<typeof createAppDomSnapshot>;
    };
    debugWindow.__AGSWARM_APP_DOM_SNAPSHOT__ = dump;
    return () => {
      if (debugWindow.__AGSWARM_APP_DOM_SNAPSHOT__ === dump) {
        delete debugWindow.__AGSWARM_APP_DOM_SNAPSHOT__;
      }
    };
  }, [currentTab]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const mergeIncomingTasksFromDevices = useCallback((items: Device[]) => {
    const incoming = items
      .filter(device => device.id === nodeId)
      .flatMap(device => device.recentTasks?.map(task => taskFromRecentTask(task, device)) || []);
    if (!incoming.length) return;
    setTasks(prev => mergeTasks(prev, incoming));
  }, [nodeId]);

  const refreshRuntimeState = useCallback(async (options: { localPeerStatus?: LocalPeerStatus | null; updateStatusMessage?: boolean } = {}) => {
    const [discovered, localSnapshot] = await Promise.all([
      discoverDevices(natsUrl, nodeId),
      getNodeSnapshot(natsUrl, nodeId),
    ]);
    const localDevice = deviceFromSnapshot(localSnapshot, nodeId);
    const mergedDevices = applyDeviceAliases(mergeDiscoveredWithLocal(
      upsertDevice(discovered, localDevice),
      options.localPeerStatus ?? null,
      {
        nodeId,
        natsUrl,
        deviceLabel,
        enablePi,
      },
    ), deviceAliases);
    startTransition(() => {
      setDevices(prev => areDevicesEquivalent(prev, mergedDevices) ? prev : mergedDevices);
      mergeIncomingTasksFromDevices([localDevice]);
      if (options.updateStatusMessage) {
        setDeviceStatusMessage(discovered.length ? `Discovered ${discovered.length} online node${discovered.length === 1 ? '' : 's'}.` : 'No online nodes announced on NATS yet.');
      }
    });
    return { discovered, localDevice, mergedDevices };
  }, [deviceAliases, deviceLabel, enablePi, mergeIncomingTasksFromDevices, natsUrl, nodeId]);

  useEffect(() => {
    let disposed = false;
    getRuntimeConfig()
      .then(async config => {
        if (disposed) return;
        setRuntimeConfig(config);
        if (config.nodeId) setNodeId(config.nodeId);
        const effectiveNodeId = config.nodeId || nodeId;
        const storedDeviceLabel = getStoredDeviceLabel(effectiveNodeId);
        if (config.deviceLabel) {
          setDeviceLabel(config.deviceLabel);
        } else if (storedDeviceLabel) {
          setDeviceLabel(storedDeviceLabel);
        } else {
          try {
            const name = await getSystemDeviceName();
            if (!disposed && name.trim()) setDeviceLabel(labelFromSystemName(name.trim(), effectiveNodeId));
          } catch {
            // Keep the bundled fallback label when system naming is unavailable.
          }
        }
        if (config.natsUrl) updateSetting('natsUrl', config.natsUrl);
        if (!disposed) setRuntimeConfigLoaded(true);
      })
      .catch(() => {
        // Runtime overrides are optional; packaged clients can run without them.
        if (!disposed) setRuntimeConfigLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (runtimeConfig?.nodeId) return;
    localStorage.setItem('agswarm.nodeId', nodeId);
  }, [nodeId, runtimeConfig?.nodeId]);

  useEffect(() => {
    if (runtimeConfig?.deviceLabel) return;
    if (deviceLabel.trim()) {
      setStoredDeviceLabel(nodeId, deviceLabel.trim());
    }
  }, [deviceLabel, nodeId, runtimeConfig?.deviceLabel]);

  useEffect(() => {
    const title = deviceLabel && deviceLabel !== 'AgSwarm Client'
      ? `${deviceLabel} · AgSwarm`
      : `${nodeId} · AgSwarm`;
    setWindowTitle(title);
  }, [deviceLabel, nodeId]);

  useEffect(() => {
    if (!runtimeConfigLoaded || hasStartedLocalPeerRef.current) return;
    hasStartedLocalPeerRef.current = true;
    let disposed = false;
    const startPeer = async () => {
      try {
        const status = await startLocalPeer({
          natsUrl,
          nodeId,
          deviceLabel,
          deviceTags: 'desktop,tauri,local',
          capabilities: enablePi ? 'echo-client,interactive-file-stream,pi-agent' : 'echo-client,interactive-file-stream',
          enablePi,
          piModel: agentModel,
          piProvider: piProviderFromSetting(providerUrl),
          piCwd,
          startNats: true,
        });
        if (!disposed) {
          setLocalPeerStatus(status);
          setLocalPeerStatusForMerge(status);
          setDeviceStatusMessage(status.message);
          setDevices(prev => upsertDevice(prev, deviceFromLocalPeerStatus(status, {
            nodeId,
            natsUrl,
            deviceLabel,
            enablePi,
          })));
        }
      } catch (error) {
        if (!disposed) {
          setLocalPeerStatus({
            ok: false,
            nodeId,
            natsUrl,
            nodeRunning: false,
            natsRunning: false,
            natsManaged: false,
            message: formatError(error),
          });
          setLocalPeerStatusForMerge({
            ok: false,
            nodeId,
            natsUrl,
            nodeRunning: false,
            natsRunning: false,
            natsManaged: false,
            message: formatError(error),
          });
          setDeviceStatusMessage(formatError(error));
        }
      }
    };
    startPeer();
    return () => {
      disposed = true;
    };
  }, [runtimeConfigLoaded]);

  useEffect(() => {
    if (!runtimeConfigLoaded) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const status = await getLocalPeerStatus();
        if (!disposed) setLocalPeerStatus(status);
      } catch {
        // Status polling should not interrupt active user work.
      }
    }, isDeviceSurfaceActive ? LOCAL_STATUS_ACTIVE_MS : LOCAL_STATUS_BACKGROUND_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isDeviceSurfaceActive, runtimeConfigLoaded]);

  useEffect(() => {
    if (!runtimeConfigLoaded || !isDeviceSurfaceActive) return;
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const { discovered } = await refreshRuntimeState({ localPeerStatus: localPeerStatusForMergeRef.current, updateStatusMessage: true });
        if (disposed) return;
        setDeviceStatusMessage(discovered.length ? `Discovered ${discovered.length} online node${discovered.length === 1 ? '' : 's'}.` : 'No online nodes announced on NATS yet.');
      } catch {
        // Keep the last known device list while NATS or a peer is restarting.
      } finally {
        refreshing = false;
      }
    };
    const enterTimer = window.setTimeout(refresh, DEVICE_REFRESH_ON_ENTER_DELAY_MS);
    const timer = window.setInterval(refresh, DEVICE_REFRESH_ACTIVE_MS);
    return () => {
      disposed = true;
      window.clearTimeout(enterTimer);
      window.clearInterval(timer);
    };
  }, [isDeviceSurfaceActive, refreshRuntimeState, runtimeConfigLoaded]);

  const handleCancelTransfer = (transferId: string) => {
    setTransfers(prev => prev.map(t => 
      t.id === transferId ? { ...t, status: 'failed' } : t
    ));
  };

  const handleSelectDevice = (device: Device, file?: File) => {
    setSelectedDevice(device);
    if (file) {
      setSelectedFileForDevice(file);
    } else {
      setSelectedFileForDevice(null);
    }
  };

  const tabs = [
    { id: 'chat', icon: MessageSquareText, label: 'Copilot' },
    { id: 'devices', icon: Radar, label: 'Devices' },
    { id: 'tasks', icon: ArrowRightLeft, label: 'Tasks' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  const handleRefreshDevices = async () => {
    setIsRefreshingDevices(true);
    setDeviceStatusMessage(`Discovering online nodes on ${natsUrl}...`);
    try {
      const { discovered } = await refreshRuntimeState({ localPeerStatus });
      setDeviceStatusMessage(discovered.length ? `Discovered ${discovered.length} online node${discovered.length === 1 ? '' : 's'}.` : 'No online nodes announced on NATS yet.');
    } catch (error) {
      setDevices(prev => upsertDevice(prev, {
        ...deviceFromLocalPeerStatus(localPeerStatus, {
          nodeId,
          natsUrl,
          deviceLabel,
          enablePi,
        }),
        status: 'offline',
      }));
      setDeviceStatusMessage(formatError(error));
    } finally {
      setIsRefreshingDevices(false);
    }
  };

  const handleRestartLocalPeer = async () => {
    saveAppSettings(settings);
    const status = await startLocalPeer({
      natsUrl,
      nodeId,
      deviceLabel,
      deviceTags: 'desktop,tauri,local',
      capabilities: enablePi ? 'echo-client,interactive-file-stream,pi-agent' : 'echo-client,interactive-file-stream',
      enablePi,
      piModel: agentModel,
      piProvider: piProviderFromSetting(providerUrl),
      piCwd,
      startNats: true,
    });
    setLocalPeerStatus(status);
    setLocalPeerStatusForMerge(status);
    setDeviceStatusMessage(status.message);
    setDevices(prev => upsertDevice(prev, deviceFromLocalPeerStatus(status, {
      nodeId,
      natsUrl,
      deviceLabel,
      enablePi,
    })));
  };

  const handleRenameLocalDevice = async (name: string) => {
    const normalized = name.trim();
    if (!normalized || normalized === deviceLabel) return;
    setDeviceLabel(normalized);
    setStoredDeviceLabel(nodeId, normalized);
    setDevices(prev => prev.map(device => device.id === nodeId ? { ...device, name: normalized } : device));
    window.setTimeout(() => {
      handleRestartLocalPeer().catch(error => setDeviceStatusMessage(formatError(error)));
    }, 0);
  };

  const dispatchTask = useCallback(async (
    taskData: SendTaskData,
    options: { switchToTasks?: boolean; targetDeviceName?: string; quiet?: boolean } = {},
  ) => {
    const taskId = `tsk-${Date.now()}`;
    const target = taskData.target || nodeId;
    const detail = taskDetail(taskData);
    const newTask: Task = {
      id: taskId,
      type: taskData.type,
      target,
      direction: 'outgoing',
      status: 'running',
      time: 'Just now',
      detail,
    };
    if (!options.quiet) {
      setTasks(prev => [newTask, ...prev]);
    }
    setDevices(prev => prev.map(device => device.id === target ? { ...device, status: 'transferring', activeTask: { type: taskData.type, status: 'executing' } } : device));
    if (options.switchToTasks) {
      setCurrentTab('tasks');
    }
    try {
      const response = await runTaskCommand({
        taskData,
        target,
        natsUrl,
        model: agentModel,
        latexMcpDir,
        sourceNodeId: nodeId,
        sourceDeviceLabel: deviceLabel,
      });
      if (!response.ok) {
        throw new Error(response.stderr || JSON.stringify(response.stdout));
      }
      const result = summarizeCliResult(response.stdout);
      if (!options.quiet) {
        setTasks(prev => prev.map(task => task.id === taskId ? {
          ...task,
          status: 'completed',
          result,
        } : task));
      }
      if (taskData.type === 'File') {
        setTransfers(prev => [{
          id: `tf-${Date.now()}`,
          fileName: taskData.fileName || taskData.sourcePath || 'uploaded file',
          targetDeviceName: options.targetDeviceName || target,
          progress: 100,
          status: 'completed',
          size: taskData.fileSize || '',
        }, ...prev]);
      }
      return response;
    } catch (error) {
      const message = formatError(error);
      if (!options.quiet) {
        setTasks(prev => prev.map(task => task.id === taskId ? {
          ...task,
          status: 'failed',
          result: message,
        } : task));
      }
      if (taskData.type === 'File') {
        setTransfers(prev => [{
          id: `tf-${Date.now()}`,
          fileName: taskData.fileName || taskData.sourcePath || 'uploaded file',
          targetDeviceName: options.targetDeviceName || target,
          progress: 0,
          status: 'failed',
          size: taskData.fileSize || '',
        }, ...prev]);
      }
      throw error;
    } finally {
      setDevices(prev => prev.map(device => device.id === target ? { ...device, status: 'online', activeTask: null } : device));
    }
  }, [agentModel, deviceLabel, latexMcpDir, natsUrl, nodeId]);

  const handleSendTask = async (taskData: SendTaskData) => {
    await dispatchTask(taskData, { switchToTasks: true });
  };

  return (
    <MantineProvider forceColorScheme={theme}>
      <Notifications position="top-center" />
      <div className={`h-screen overflow-hidden font-sans selection:bg-teal-500/30 ${theme === 'dark' ? 'dark' : ''}`}>
      <main className="min-h-0 h-full overflow-hidden">
        <div className="agswarm-tab-stack">
          <section
            className={`agswarm-tab-panel ${currentTab === 'chat' ? 'is-active' : ''}`}
            data-tab="chat"
            aria-hidden={currentTab !== 'chat'}
            inert={currentTab !== 'chat'}
          >
            <Suspense
              fallback={(
                <Stack h="100%" align="center" justify="center">
                  <Loader color="teal" />
                </Stack>
              )}
            >
              <PiWebNativeChatView
                piCwd={piCwd}
                localNodeId={nodeId}
                localDeviceLabel={deviceLabel}
                userDisplayName={userDisplayName}
                userAvatarSeed={userAvatarSeed}
                agDisplayName={agDisplayName}
                agAvatarSeed={agAvatarSeed}
                deviceAliases={deviceAliases}
                devices={devices}
                deviceStatusMessage={deviceStatusMessage}
              />
            </Suspense>
          </section>

          <section
            className={`agswarm-tab-panel ${currentTab === 'devices' ? 'is-active' : ''}`}
            data-tab="devices"
            aria-hidden={currentTab !== 'devices'}
            inert={currentTab !== 'devices'}
          >
            <DevicesView
              devices={devices}
              transfers={transfers}
              onSelectDevice={handleSelectDevice}
              onCancelTransfer={handleCancelTransfer}
              onRefreshDevices={handleRefreshDevices}
              isRefreshing={isRefreshingDevices}
              statusMessage={deviceStatusMessage}
              localNodeId={nodeId}
              deviceAliases={deviceAliases}
              onDeviceAliasesChange={(value) => updateSetting('deviceAliases', value)}
              onRenameLocalDevice={handleRenameLocalDevice}
            />
          </section>

          <section
            className={`agswarm-tab-panel ${currentTab === 'tasks' ? 'is-active' : ''}`}
            data-tab="tasks"
            aria-hidden={currentTab !== 'tasks'}
            inert={currentTab !== 'tasks'}
          >
            <TasksView tasks={tasks} />
          </section>

          <section
            className={`agswarm-tab-panel ${currentTab === 'settings' ? 'is-active' : ''}`}
            data-tab="settings"
            aria-hidden={currentTab !== 'settings'}
            inert={currentTab !== 'settings'}
          >
            <SettingsView
              theme={theme}
              onThemeChange={(value) => updateSetting('theme', value)}
              providerUrl={providerUrl}
              onProviderUrlChange={(value) => updateSetting('providerUrl', value)}
              apiKey={agentApiKey}
              onApiKeyChange={(value) => updateSetting('agentApiKey', value)}
              modelName={agentModel}
              onModelNameChange={(value) => updateSetting('agentModel', value)}
              natsUrl={natsUrl}
              onNatsUrlChange={(value) => updateSetting('natsUrl', value)}
              nodeId={nodeId}
              onNodeIdChange={setNodeId}
              deviceLabel={deviceLabel}
              onDeviceLabelChange={setDeviceLabel}
              userDisplayName={userDisplayName}
              onUserDisplayNameChange={(value) => updateSetting('userDisplayName', value)}
              userAvatarSeed={userAvatarSeed}
              onUserAvatarSeedChange={(value) => updateSetting('userAvatarSeed', value)}
              agDisplayName={agDisplayName}
              onAgDisplayNameChange={(value) => updateSetting('agDisplayName', value)}
              agAvatarSeed={agAvatarSeed}
              onAgAvatarSeedChange={(value) => updateSetting('agAvatarSeed', value)}
              deviceAliases={deviceAliases}
              onDeviceAliasesChange={(value) => updateSetting('deviceAliases', value)}
              enablePi={enablePi}
              onEnablePiChange={(value) => updateSetting('enablePi', value)}
              localPeerStatus={localPeerStatus}
              onRestartLocalPeer={handleRestartLocalPeer}
              latexMcpDir={latexMcpDir}
              onLatexMcpDirChange={(value) => updateSetting('latexMcpDir', value)}
              piCwd={piCwd}
              onPiCwdChange={(value) => updateSetting('piCwd', value)}
              defaultSavePath={defaultSavePath}
              onDefaultSavePathChange={(value) => updateSetting('defaultSavePath', value)}
              agentSkills={agentSkills}
              onAgentSkillsChange={(value) => updateSetting('agentSkills', value)}
            />
          </section>
        </div>
      </main>

      <Paper
        withBorder
        radius="xl"
        shadow="md"
        p="xs"
        className="agswarm-bottom-nav fixed bottom-5 left-1/2 z-50 -translate-x-1/2"
      >
        <Group gap={4} wrap="nowrap">
          {tabs.map((tab) => {
            const isActive = currentTab === tab.id;
            const Icon = tab.icon;
            return (
              <Tooltip key={tab.id} label={tab.label}>
                <ActionIcon
                  variant={isActive ? 'light' : 'subtle'}
                  color={isActive ? 'teal' : 'gray'}
                  radius="xl"
                  size="xl"
                  onClick={() => startTransition(() => setCurrentTab(tab.id))}
                  aria-label={tab.label}
                >
                  <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 2} />
                </ActionIcon>
              </Tooltip>
            );
          })}
        </Group>
      </Paper>

      <SendModal 
        device={selectedDevice} 
        onClose={() => {
          setSelectedDevice(null);
          setSelectedFileForDevice(null);
        }} 
        onSend={handleSendTask}
        initialFile={selectedFileForDevice}
        initialTaskType={selectedFileForDevice ? 'file' : undefined}
      />
      </div>
    </MantineProvider>
  );
}

async function discoverDevices(natsUrl: string, nodeId: string): Promise<Device[]> {
  const response = await runAgSwarmCli<DiscoverNodesResponse>({
    command: 'discover-nodes',
    natsUrl,
    waitTimeoutSec: 0.35,
  });
  if (!response.ok) {
    throw new Error(response.stderr || JSON.stringify(response.stdout));
  }
  const nodes = Array.isArray(response.stdout?.nodes) ? response.stdout.nodes : [];
  return nodes.map((snapshot) => deviceFromSnapshot(snapshot, String(snapshot?.node_id || nodeId)));
}

async function getNodeSnapshot(natsUrl: string, nodeId: string): Promise<NodeSnapshotDto> {
  const response = await runAgSwarmCli<NodeSnapshotDto>({
    command: 'node-snapshot',
    natsUrl,
    nodeId,
    waitTimeoutSec: 2,
  });
  if (!response.ok) {
    throw new Error(response.stderr || JSON.stringify(response.stdout));
  }
  return response.stdout;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function areDevicesEquivalent(left: Device[], right: Device[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((device, index) => {
    const next = right[index];
    return next
      && device.id === next.id
      && device.name === next.name
      && device.status === next.status
      && device.os === next.os
      && device.activeTask?.type === next.activeTask?.type
      && device.activeTask?.status === next.activeTask?.status
      && (device.recentTasks?.length || 0) === (next.recentTasks?.length || 0);
  });
}

function getStoredNodeId(): string {
  const existing = localStorage.getItem('agswarm.nodeId');
  if (existing && existing.trim()) {
    return existing;
  }
  const suffix = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6);
  return `agswarm-${suffix}`;
}

function getDefaultDeviceLabel(): string {
  return getStoredDeviceLabel() || 'AgSwarm Client';
}

function getStoredDeviceLabel(nodeId?: string): string | null {
  const keys = [
    nodeId ? `agswarm.deviceLabel.${nodeId}` : '',
    'agswarm.deviceLabel',
  ].filter(Boolean);
  for (const key of keys) {
    const existing = localStorage.getItem(key);
    const normalized = existing?.trim();
    if (normalized && !isPlaceholderDeviceLabel(normalized)) {
      return normalized;
    }
  }
  return null;
}

function setStoredDeviceLabel(nodeId: string, label: string) {
  if (isPlaceholderDeviceLabel(label)) return;
  localStorage.setItem(`agswarm.deviceLabel.${nodeId}`, label);
}

function applyDeviceAliases(devices: Device[], aliases: Record<string, DeviceAliasSettings>): Device[] {
  return devices.map(device => {
    const alias = aliases[device.id];
    const displayName = alias?.displayName?.trim();
    return displayName ? { ...device, name: displayName } : device;
  });
}

function isPlaceholderDeviceLabel(label: string): boolean {
  return ['AgSwarm Client', 'Desktop A', 'Desktop B'].includes(label.trim());
}

function labelFromSystemName(systemName: string, nodeId: string): string {
  if (!nodeId) return systemName;
  if (/^desktop-[a-z0-9-]+$/i.test(nodeId)) {
    return `${systemName} · ${nodeId}`;
  }
  return systemName;
}

function createAppDomSnapshot(currentTab: string) {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-tab]')).map(section => ({
    tab: section.dataset.tab,
    className: section.className,
    ariaHidden: section.getAttribute('aria-hidden'),
    inert: section.hasAttribute('inert'),
    rect: elementRect(section),
    text: compactDomText(section.innerText).slice(0, 700),
  }));
  return {
    url: window.location.href,
    title: document.title,
    currentTab,
    bodyTextStart: compactDomText(document.body.innerText).slice(0, 1600),
    rootRect: elementRect(document.getElementById('root')),
    activeElement: activeElementSummary(),
    copilotContainerCount: document.querySelectorAll('.agswarm-copilotkit-chat, .copilotKitChat').length,
    chatWorkspaceCount: document.querySelectorAll('.agswarm-chat-workspace').length,
    textareaCount: document.querySelectorAll('textarea').length,
    buttonTexts: Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .map(button => compactDomText(button.innerText || button.getAttribute('aria-label') || ''))
      .filter(Boolean)
      .slice(0, 50),
    sections,
  };
}

function elementRect(element: Element | null) {
  if (!element) return null;
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
