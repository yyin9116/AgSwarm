import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Radar, ArrowRightLeft, Settings, MessageSquareText } from 'lucide-react';
import { ActionIcon, Button, Group, Loader, MantineProvider, Modal, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { DevicesView, Device, FileTransfer, RecentTask } from './components/DevicesView';
import { TasksView, Task } from './components/TasksView';
import { SettingsView } from './components/SettingsView';
import { SendModal } from './components/SendModal';
import {
  getLocalPeerStatus,
  getRuntimeConfig,
  getSystemDeviceName,
  runAgSwarmCli,
  saveChatAttachment,
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

type DroppedFile = {
  name: string;
  size: number;
  sourcePath?: string;
  file?: File;
};

type ChatActivityEvent = {
  id: number;
  label: string;
  detail?: string;
  tone?: 'neutral' | 'error';
};

function piProviderFromSetting(providerUrl: string): string {
  const value = providerUrl.trim();
  if (!value) return 'local-openai';
  return /^https?:\/\//i.test(value) ? 'local-openai' : value;
}

function normalizeAbsoluteWorkspace(value: string, fallback?: string): string {
  const trimmed = value.trim();
  if (trimmed && isAbsoluteWorkspacePath(trimmed)) return trimmed;
  const fallbackValue = fallback?.trim() || '';
  if (fallbackValue && isAbsoluteWorkspacePath(fallbackValue)) return fallbackValue;
  return '';
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function formatBytes(value: number): string {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

function deviceIdAtWindowPoint(x: number, y: number, scaleFactor = 1): string | undefined {
  const candidates = [
    { x, y },
    ...(scaleFactor && scaleFactor !== 1 ? [{ x: x / scaleFactor, y: y / scaleFactor }] : []),
  ];
  for (const point of candidates) {
    const precise = deviceIdAtDomPoint(point.x, point.y, 0);
    if (precise) return precise;
  }
  for (const point of candidates) {
    const forgiving = deviceIdAtDomPoint(point.x, point.y, 16);
    if (forgiving) return forgiving;
  }
  return undefined;
}

function deviceIdAtDomPoint(x: number, y: number, tolerance: number): string | undefined {
  if (tolerance === 0) {
    const element = document.elementFromPoint(x, y)?.closest('[data-device-drop-id]');
    if (element instanceof HTMLElement && element.dataset.deviceDropId) return element.dataset.deviceDropId;
  }

  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-device-drop-id]'));
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const inside =
      x >= rect.left - tolerance
      && x <= rect.right + tolerance
      && y >= rect.top - tolerance
      && y <= rect.bottom + tolerance;
    if (inside && card.dataset.deviceDropId) return card.dataset.deviceDropId;
  }
  return undefined;
}

function pathToDroppedFile(path: string): DroppedFile {
  return {
    name: basename(path),
    size: 0,
    sourcePath: path,
  };
}

function fileToDroppedFile(file: File): DroppedFile {
  return {
    name: file.name || 'attachment',
    size: file.size,
    file,
  };
}

async function saveDroppedBrowserFile(file: DroppedFile, workspaceRoot: string) {
  if (!file.file) throw new Error('Dropped file is missing file content.');
  const bytes = Array.from(new Uint8Array(await file.file.arrayBuffer()));
  return saveChatAttachment({
    name: file.name || 'attachment',
    workspaceRoot,
    bytes,
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || 'attachment';
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
  theme: 'system',
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
  const [pendingDeviceDrop, setPendingDeviceDrop] = useState<{ device: Device; files: DroppedFile[] } | null>(null);
  const [windowDrag, setWindowDrag] = useState<{ active: boolean; paths: string[]; overDeviceId?: string }>({ active: false, paths: [] });
  const [chatAttachmentDrop, setChatAttachmentDrop] = useState<{ id: number; paths: string[] } | null>(null);
  const [chatActivityEvent, setChatActivityEvent] = useState<ChatActivityEvent | null>(null);
  const [deliveryAnimation, setDeliveryAnimation] = useState<{ deviceId: string; fileName: string; id: number } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [settings, setSettings] = useState(() => loadAppSettings(DEFAULT_SETTINGS));
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
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
  const windowScaleFactorRef = useRef(1);
  const dragOverDeviceIdRef = useRef<string | undefined>(undefined);
  const [deviceStatusMessage, setDeviceStatusMessage] = useState('No devices loaded yet. Refresh to query NATS.');
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const hasStartedLocalPeerRef = useRef(false);
  const isDeviceSurfaceActive = currentTab === 'devices';
  const effectivePiCwd = useMemo(() => normalizeAbsoluteWorkspace(piCwd, runtimeConfig?.repoRoot), [piCwd, runtimeConfig?.repoRoot]);
  const effectiveTheme = theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    localPeerStatusForMergeRef.current = localPeerStatusForMerge;
  }, [localPeerStatusForMerge]);

  useEffect(() => {
    saveAppSettings(settings);
  }, [settings]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const update = () => setSystemPrefersDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setDevices(prev => applyDeviceAliases(prev, deviceAliases));
  }, [deviceAliases]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().scaleFactor()
      .then(value => {
        if (!disposed && Number.isFinite(value) && value > 0) windowScaleFactorRef.current = value;
      })
      .catch(() => undefined);
    const deviceIdAtPosition = (x: number, y: number) => deviceIdAtWindowPoint(x, y, windowScaleFactorRef.current);
    getCurrentWebview().onDragDropEvent(event => {
      if (disposed) return;
      if (event.payload.type === 'enter') {
        const overDeviceId = deviceIdAtPosition(event.payload.position.x, event.payload.position.y);
        dragOverDeviceIdRef.current = overDeviceId;
        setWindowDrag({
          active: true,
          paths: event.payload.paths,
          overDeviceId,
        });
        return;
      }
      if (event.payload.type === 'over') {
        const { position } = event.payload;
        const overDeviceId = deviceIdAtPosition(position.x, position.y);
        dragOverDeviceIdRef.current = overDeviceId || dragOverDeviceIdRef.current;
        setWindowDrag(current => ({
          ...current,
          active: true,
          overDeviceId,
        }));
        return;
      }
      if (event.payload.type === 'drop') {
        const overDeviceId = deviceIdAtPosition(event.payload.position.x, event.payload.position.y) || dragOverDeviceIdRef.current;
        const targetDevice = devices.find(device => device.id === overDeviceId);
        const paths = event.payload.paths;
        setWindowDrag({ active: false, paths: [] });
        dragOverDeviceIdRef.current = undefined;
        if (targetDevice && paths.length) {
          setPendingDeviceDrop({ device: targetDevice, files: paths.map(pathToDroppedFile) });
        } else if (currentTab === 'chat' && paths.length) {
          setChatAttachmentDrop({ id: Date.now(), paths });
        } else if (currentTab === 'devices' && paths.length) {
          notifications.show({
            color: 'gray',
            title: 'Choose a device',
            message: 'Drop files directly on a device card to send them.',
          });
        }
        return;
      }
      dragOverDeviceIdRef.current = undefined;
      setWindowDrag({ active: false, paths: [] });
    }).then(unlistenFn => {
      if (disposed) unlistenFn();
      else unlisten = unlistenFn;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentTab, devices]);

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
          piCwd: effectivePiCwd,
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
  }, [runtimeConfigLoaded, effectivePiCwd]);

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
      piCwd: effectivePiCwd,
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
    const transferId = taskData.type === 'File' ? `tf-${Date.now()}` : '';
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
    if (taskData.type === 'File') {
      setTransfers(prev => [{
        id: transferId,
        fileName: taskData.fileName || taskData.sourcePath || 'uploaded file',
        targetDeviceName: options.targetDeviceName || target,
        progress: 18,
        status: 'transferring',
        size: taskData.fileSize || '',
      }, ...prev]);
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
        setTransfers(prev => prev.map(transfer => transfer.id === transferId ? {
          ...transfer,
          progress: 100,
          status: 'completed',
        } : transfer));
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
        setTransfers(prev => prev.map(transfer => transfer.id === transferId ? {
          ...transfer,
          progress: 0,
          status: 'failed',
        } : transfer));
      }
      throw error;
    } finally {
      setDevices(prev => prev.map(device => device.id === target ? { ...device, status: 'online', activeTask: null } : device));
    }
  }, [agentModel, deviceLabel, latexMcpDir, natsUrl, nodeId]);

  const handleSendTask = async (taskData: SendTaskData) => {
    await dispatchTask(taskData, { switchToTasks: true });
  };

  const handleConfirmDeviceDrop = useCallback(async () => {
    const drop = pendingDeviceDrop;
    if (!drop) return;
    const { device, files } = drop;
    setPendingDeviceDrop(null);
    if (!files.length) return;
    if (!effectivePiCwd) {
      notifications.show({
        color: 'red',
        title: 'Working directory required',
        message: 'Set an absolute Host Working Directory before sending files.',
      });
      return;
    }
    notifications.show({
      color: 'teal',
      title: files.length === 1 ? `Sending ${files[0].name}` : `Sending ${files.length} files`,
      message: `Target: ${device.name}`,
    });
    for (const file of files) {
      try {
        setDeliveryAnimation({ deviceId: device.id, fileName: file.name, id: Date.now() });
        window.setTimeout(() => {
          setDeliveryAnimation(current => current?.deviceId === device.id && current.fileName === file.name ? null : current);
        }, 1200);
        const staged = file.sourcePath
          ? {
              name: file.name,
              stagedPath: file.sourcePath,
              sizeBytes: file.size,
            }
          : await saveDroppedBrowserFile(file, effectivePiCwd);
        await dispatchTask({
          type: 'File',
          target: device.id,
          payload: file.name || staged.name,
          sourcePath: staged.stagedPath,
          fileName: staged.name,
          fileSize: formatBytes(staged.sizeBytes),
        }, {
          targetDeviceName: device.name,
        });
        setChatActivityEvent({
          id: Date.now(),
          label: `Sent ${staged.name} to ${device.name}`,
          detail: 'The file transfer was dispatched to the selected device.',
        });
      } catch (error) {
        setChatActivityEvent({
          id: Date.now(),
          label: `Failed to send ${file.name || 'file'} to ${device.name}`,
          detail: formatError(error),
          tone: 'error',
        });
        notifications.show({
          color: 'red',
          title: `Failed to send ${file.name || 'file'}`,
          message: formatError(error),
        });
      }
    }
  }, [dispatchTask, effectivePiCwd, pendingDeviceDrop]);

  const handleDropFilesToDevice = useCallback((device: Device, files: File[]) => {
    if (!files.length) return;
    setPendingDeviceDrop({ device, files: files.map(fileToDroppedFile) });
  }, []);

  return (
    <MantineProvider forceColorScheme={effectiveTheme}>
      <Notifications position="top-center" />
      <div className={`h-screen overflow-hidden font-sans selection:bg-teal-500/30 ${effectiveTheme === 'dark' ? 'dark' : ''}`} data-theme-mode={theme}>
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
                piCwd={effectivePiCwd}
                localNodeId={nodeId}
                localDeviceLabel={deviceLabel}
                userDisplayName={userDisplayName}
                userAvatarSeed={userAvatarSeed}
                agDisplayName={agDisplayName}
                agAvatarSeed={agAvatarSeed}
                deviceAliases={deviceAliases}
                devices={devices}
                deviceStatusMessage={deviceStatusMessage}
                externalAttachmentDrop={chatAttachmentDrop}
                externalActivity={chatActivityEvent}
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
              onDropFilesToDevice={handleDropFilesToDevice}
              onCancelTransfer={handleCancelTransfer}
              onRefreshDevices={handleRefreshDevices}
              isRefreshing={isRefreshingDevices}
              statusMessage={deviceStatusMessage}
              localNodeId={nodeId}
              externalDragOverDeviceId={windowDrag.active ? windowDrag.overDeviceId : undefined}
              deliveryAnimation={deliveryAnimation}
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
                  className="agswarm-nav-button"
                  data-active={isActive ? 'true' : undefined}
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
      {windowDrag.active && (
        <div className={`agswarm-window-drop-overlay ${currentTab === 'devices' ? 'is-device-drag' : ''}`}>
          <div>
            <Text fw={700}>{currentTab === 'devices' ? 'Drop on a device to send' : currentTab === 'chat' ? 'Drop to attach to chat' : 'Drop files into AgSwarm'}</Text>
            <Text size="sm" c="dimmed">
              {currentTab === 'devices'
                ? (windowDrag.overDeviceId ? 'Release to confirm file transfer.' : 'Move over a device card before releasing.')
                : currentTab === 'chat'
                  ? 'Release to add files to the message composer.'
                  : 'Switch to Devices to send files to a device, or Chat to attach files.'}
            </Text>
          </div>
        </div>
      )}
      <Modal
        opened={Boolean(pendingDeviceDrop)}
        onClose={() => setPendingDeviceDrop(null)}
        title={pendingDeviceDrop ? `Send to ${pendingDeviceDrop.device.name}` : 'Send files'}
        centered
        radius="md"
      >
        {pendingDeviceDrop && (
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Confirm sending {pendingDeviceDrop.files.length === 1 ? pendingDeviceDrop.files[0].name : `${pendingDeviceDrop.files.length} files`} to this device.
            </Text>
            <Stack gap={6}>
              {pendingDeviceDrop.files.slice(0, 6).map((file, index) => (
                <Group key={`${file.name}-${file.size}-${file.sourcePath || index}`} justify="space-between" wrap="nowrap">
                  <Text size="sm" truncate>{file.name}</Text>
                  <Text size="xs" c="dimmed">{formatBytes(file.size)}</Text>
                </Group>
              ))}
              {pendingDeviceDrop.files.length > 6 && (
                <Text size="xs" c="dimmed">+{pendingDeviceDrop.files.length - 6} more</Text>
              )}
            </Stack>
            <Group justify="flex-end">
              <Button variant="subtle" color="gray" onClick={() => setPendingDeviceDrop(null)}>Cancel</Button>
              <Button color="teal" onClick={() => void handleConfirmDeviceDrop()}>Send</Button>
            </Group>
          </Stack>
        )}
      </Modal>
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
