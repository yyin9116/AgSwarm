import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateCheckResult =
  | { status: 'unavailable'; currentVersion?: string; checkedAt: string; feedUrl: string; message: string }
  | { status: 'current'; currentVersion?: string; checkedAt: string; feedUrl: string; message: string }
  | { status: 'available'; currentVersion?: string; checkedAt: string; feedUrl: string; update: AppUpdateInfo };

export type AppUpdateInfo = {
  version: string;
  currentVersion: string;
  date?: string;
  notes?: string;
};

export type UpdateDownloadProgress = {
  phase: 'started' | 'downloading' | 'finished';
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
};

let pendingUpdate: Update | null = null;
const UPDATE_FEED_URL = 'https://github.com/yyin9116/AgSwarm/releases/latest/download/latest.json';

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString();
  const currentVersion = await getCurrentAppVersion();
  if (!isTauri()) {
    return {
      status: 'unavailable',
      currentVersion,
      checkedAt,
      feedUrl: UPDATE_FEED_URL,
      message: 'Software updates are only available in the desktop app.',
    };
  }

  const update = await check({ timeout: 15_000 });
  pendingUpdate?.close().catch(() => undefined);
  pendingUpdate = update;

  if (!update) {
    return {
      status: 'current',
      currentVersion,
      checkedAt,
      feedUrl: UPDATE_FEED_URL,
      message: currentVersion ? `AgSwarm ${currentVersion} is up to date.` : 'AgSwarm is up to date.',
    };
  }

  return {
    status: 'available',
    currentVersion: update.currentVersion || currentVersion,
    checkedAt,
    feedUrl: UPDATE_FEED_URL,
    update: normalizeUpdate(update),
  };
}

export async function installPendingAppUpdate(
  onProgress: (progress: UpdateDownloadProgress) => void,
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No checked update is ready to install. Check for updates first.');
  }

  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  await pendingUpdate.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength;
      onProgress({ phase: 'started', downloadedBytes, totalBytes, percent: percent(downloadedBytes, totalBytes) });
      return;
    }
    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength;
      onProgress({ phase: 'downloading', downloadedBytes, totalBytes, percent: percent(downloadedBytes, totalBytes) });
      return;
    }
    onProgress({ phase: 'finished', downloadedBytes, totalBytes, percent: 100 });
  }, { timeout: 120_000 });

  pendingUpdate = null;
  await relaunch();
}

export function manualDownloadUrl(): string {
  return 'https://github.com/yyin9116/AgSwarm/releases/latest';
}

export function updateFeedUrl(): string {
  return UPDATE_FEED_URL;
}

export async function installedAppVersion(): Promise<string | undefined> {
  return getCurrentAppVersion();
}

function normalizeUpdate(update: Update): AppUpdateInfo {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    notes: update.body,
  };
}

async function getCurrentAppVersion(): Promise<string | undefined> {
  if (!isTauri()) {
    return (import.meta as unknown as { env?: { VITE_APP_VERSION?: string } }).env?.VITE_APP_VERSION;
  }
  try {
    return await getVersion();
  } catch {
    return undefined;
  }
}

function percent(downloadedBytes: number, totalBytes?: number): number | undefined {
  if (!totalBytes || totalBytes <= 0) return undefined;
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
}
