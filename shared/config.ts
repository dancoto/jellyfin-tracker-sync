import { resolve } from 'path';

export type UserTokenEntry =
  | string
  | {
      token: string;
      refresh_token?: string;
      expires_at?: number;
    };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AniListConfig {
  client_id?: string;
  client_secret?: string;
  redirect_uri?: string;
  users?: Record<string, UserTokenEntry>;
}

export type Config = {
  jellyfin?: {
    url: string;
    token: string;
    excluded_libraries?: string[];
    anime_libraries?: string[];
    private_anime_libraries?: string[];
    continuous_sync?: {
      enabled?: boolean;
      debounce_ms?: number;
    };
  };
  simkl: {
    app_name: string;
    client_id: string;
    client_secret?: string;
    redirect_uri?: string;
    users: Record<string, UserTokenEntry>;
  };
  anilist?: AniListConfig;
  ntfy?: { url: string; token: string; topic: string };
  logging?: {
    level?: LogLevel;
  };
};

let appConfig: Config;
let activeConfigPath: string | null = null;

const localConfigPath = resolve('./config.toml'); // local file for dev
const deployedConfigPath = '/config/config.toml'; // config file when deployed to container under /config

const localConfig = Bun.file(localConfigPath);
const deployedConfig = Bun.file(deployedConfigPath);

function validateConfig(config: any): asserts config is Config {
  if (!config || typeof config !== 'object') {
    throw new Error('Config is not a valid object.');
  }

  if (config.jellyfin) {
    if (!config.jellyfin.url || !config.jellyfin.token) {
      throw new Error('Optional "jellyfin" block is present but missing "url" or "token".');
    }
  }

  if (!config.simkl?.app_name || !config.simkl?.client_id) {
    throw new Error('Missing required "simkl" fields (app_name or client_id).');
  }

  if (!config.simkl.users || typeof config.simkl.users !== 'object') {
    config.simkl.users = {};
  }

  if (config.anilist) {
    if (!config.anilist.users || typeof config.anilist.users !== 'object') {
      config.anilist.users = {};
    }
  }

  if (config.ntfy) {
    if (!config.ntfy.url || !config.ntfy.token || !config.ntfy.topic) {
      throw new Error(
        'Optional "ntfy" block is present but missing required sub-properties (url, token, topic).',
      );
    }
  }

  if (config.logging) {
    if (config.logging.level) {
      const validLevels = ['debug', 'info', 'warn', 'error'];
      if (!validLevels.includes(String(config.logging.level).toLowerCase())) {
        throw new Error(
          `Invalid "logging.level" value "${config.logging.level}". Allowed values: debug, info, warn, error.`,
        );
      }
    }
  }
}

try {
  let targetPath: string | null = null;

  if (await localConfig.exists()) {
    targetPath = localConfigPath;
  } else if (await deployedConfig.exists()) {
    targetPath = deployedConfigPath;
  }

  if (!targetPath) {
    throw new Error('No config.toml file exists.');
  }
  const { default: config } = await import(targetPath);
  validateConfig(config);
  appConfig = config;
  activeConfigPath = targetPath;
} catch (error) {
  console.error('❌ Configuration Error:');
  if (error instanceof Error) {
    console.error(`${error.message}`);
  } else {
    console.error('Could not find, read, or parse "config.toml" at runtime.');
  }
  process.exit(1);
}

const escapeRegExp = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export const extractUserAccessToken = (entry?: UserTokenEntry): string | null => {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  return entry.token || null;
};

const saveTokenToTomlSection = async (
  sectionHeader: 'simkl.users' | 'anilist.users',
  username: string,
  token: UserTokenEntry,
): Promise<void> => {
  if (!activeConfigPath) {
    throw new Error('Active config.toml file path is unknown.');
  }

  const file = Bun.file(activeConfigPath);
  let content = await file.text();

  let tokenValueStr: string;
  if (typeof token === 'string') {
    tokenValueStr = `"${token}"`;
  } else {
    const parts = [`token = "${token.token}"`];
    if (token.refresh_token) parts.push(`refresh_token = "${token.refresh_token}"`);
    if (token.expires_at) parts.push(`expires_at = ${token.expires_at}`);
    tokenValueStr = `{ ${parts.join(', ')} }`;
  }

  const escapedHeader = escapeRegExp(`[${sectionHeader}]`);
  const sectionRegex = new RegExp(`${escapedHeader}([\\s\\S]*?)(?=\\n\\[|\\s*$)`);
  const match = content.match(sectionRegex);

  if (match) {
    const userLineRegex = new RegExp(`^(\\s*${escapeRegExp(username)}\\s*=\\s*).*$`, 'm');
    if (userLineRegex.test(match[0])) {
      const updatedSection = match[0].replace(userLineRegex, `${username} = ${tokenValueStr}`);
      content = content.replace(sectionRegex, updatedSection);
    } else {
      const updatedSection = `${match[0].trimEnd()}\n${username} = ${tokenValueStr}\n`;
      content = content.replace(sectionRegex, updatedSection);
    }
  } else {
    content = `${content.trimEnd()}\n\n[${sectionHeader}]\n${username} = ${tokenValueStr}\n`;
  }

  await Bun.write(activeConfigPath, content);
};

export const saveUserToken = async (username: string, token: UserTokenEntry): Promise<void> => {
  await saveTokenToTomlSection('simkl.users', username, token);
  if (!appConfig.simkl.users) {
    appConfig.simkl.users = {};
  }
  appConfig.simkl.users[username] = token;
};

export const saveAniListUserToken = async (
  username: string,
  token: UserTokenEntry,
): Promise<void> => {
  await saveTokenToTomlSection('anilist.users', username, token);
  if (!appConfig.anilist) {
    appConfig.anilist = { users: {} };
  }
  if (!appConfig.anilist.users) {
    appConfig.anilist.users = {};
  }
  appConfig.anilist.users[username] = token;
};

export { activeConfigPath, appConfig };
