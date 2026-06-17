export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppSettings {
  providerUrl: string;
  agentModel: string;
  agentApiKey: string;
  natsUrl: string;
  latexMcpDir: string;
  piCwd: string;
  defaultSavePath: string;
  agentSkills: string;
  enablePi: boolean;
  theme: ThemeMode;
  userDisplayName: string;
  userAvatarSeed: string;
  agDisplayName: string;
  agAvatarSeed: string;
  deviceAliases: Record<string, DeviceAliasSettings>;
}

export interface DeviceAliasSettings {
  displayName?: string;
  avatarSeed?: string;
}

const SETTINGS_KEY = 'agswarm.settings.v1';

export function loadAppSettings(defaults: AppSettings): AppSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...defaults,
      ...parsed,
      theme: normalizeThemeMode(parsed.theme),
      enablePi: typeof parsed.enablePi === 'boolean' ? parsed.enablePi : defaults.enablePi,
      userDisplayName: normalizeText(parsed.userDisplayName, defaults.userDisplayName),
      userAvatarSeed: normalizeText(parsed.userAvatarSeed, defaults.userAvatarSeed),
      agDisplayName: normalizeText(parsed.agDisplayName, defaults.agDisplayName),
      agAvatarSeed: normalizeText(parsed.agAvatarSeed, defaults.agAvatarSeed),
      deviceAliases: normalizeDeviceAliases(parsed.deviceAliases),
    };
  } catch {
    localStorage.removeItem(SETTINGS_KEY);
    return defaults;
  }
}

function normalizeThemeMode(value: unknown): ThemeMode {
  if (value === 'dark' || value === 'light' || value === 'system') return value;
  return 'system';
}

export function saveAppSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizeDeviceAliases(value: unknown): Record<string, DeviceAliasSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const aliases: Record<string, DeviceAliasSettings> = {};
  for (const [nodeId, rawAlias] of Object.entries(value)) {
    if (!nodeId.trim() || !rawAlias || typeof rawAlias !== 'object' || Array.isArray(rawAlias)) continue;
    const alias = rawAlias as Record<string, unknown>;
    const displayName = typeof alias.displayName === 'string' ? alias.displayName.trim() : '';
    const avatarSeed = typeof alias.avatarSeed === 'string' ? alias.avatarSeed.trim() : '';
    if (displayName || avatarSeed) aliases[nodeId] = { displayName, avatarSeed };
  }
  return aliases;
}
