import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const ANIBRIDGE_MAPPINGS_URL =
  'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json';

export const ANIME_LISTS_URL =
  'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-full.xml';

const DEFAULT_MAX_AGE_DAYS = 7;

export interface CacheOptions {
  cacheDir?: string;
  maxAgeDays?: number;
  forceRefresh?: boolean;
}

export const getCacheDir = (customDir?: string): string => {
  // If deployed in container with /config, prefer /config/cache, otherwise ./data/cache
  if (customDir) {
    return resolve(customDir);
  }
  if (existsSync('/config')) {
    return '/config/cache';
  }
  return resolve('./data/cache');
};

export const ensureCacheDir = (cacheDir: string): void => {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
};

export const getOrDownloadFile = async (
  filename: string,
  url: string,
  options: CacheOptions = {},
): Promise<string | null> => {
  const cacheDir = getCacheDir(options.cacheDir);
  ensureCacheDir(cacheDir);

  const filePath = resolve(cacheDir, filename);
  const maxAgeMs = (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const fileExists = existsSync(filePath);
  if (fileExists && !options.forceRefresh) {
    try {
      const stats = statSync(filePath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < maxAgeMs && stats.size > 1024) {
        return filePath;
      }
    } catch {
      // Fall through to download
    }
  }

  // File is missing or expired, attempt download
  console.log(`Downloading mapping data from ${url}...`);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'jellyfin-tracker-sync/1.0',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
      if (fileExists) {
        console.warn(`Falling back to expired cache at ${filePath}`);
        return filePath;
      }
      return null;
    }

    const content = await response.text();
    if (content.length < 1024) {
      console.warn(
        `Downloaded content from ${url} is suspiciously small (${content.length} bytes), ignoring.`,
      );
      if (fileExists) {
        try {
          if (statSync(filePath).size > 1024) {
            return filePath;
          }
        } catch {}
      }
      return null;
    }
    await Bun.write(filePath, content);
    console.log(`Successfully cached ${filename} to ${filePath}`);
    return filePath;
  } catch (error) {
    console.error(`Error downloading ${url}:`, error);
    if (fileExists) {
      console.warn(`Falling back to expired cache at ${filePath}`);
      return filePath;
    }
    return null;
  }
};
