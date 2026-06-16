import { isTauri } from '@tauri-apps/api/core';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateCheckResult =
  | { status: 'unavailable'; message: string }
  | { status: 'current'; currentVersion?: string; message: string }
  | { status: 'available'; update: AppUpdateInfo };

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

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    return {
      status: 'unavailable',
      message: 'Software updates are only available in the desktop app.',
    };
  }

  const update = await check({ timeout: 15_000 });
  pendingUpdate?.close().catch(() => undefined);
  pendingUpdate = update;

  if (!update) {
    return {
      status: 'current',
      message: 'AgSwarm is up to date.',
    };
  }

  return {
    status: 'available',
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

function normalizeUpdate(update: Update): AppUpdateInfo {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    notes: update.body,
  };
}

function percent(downloadedBytes: number, totalBytes?: number): number | undefined {
  if (!totalBytes || totalBytes <= 0) return undefined;
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
}
