import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  RawEpisodeOverride,
  RawSeasonOverride,
  RawTvdbOverrides,
} from '../anime/tvdb-overrides';
import { logger } from '../shared/logger';
import type { CatalogData } from './catalog-types';

export const CATALOG_FILE_NAME = 'anime-catalog.json';

export const getCatalogFilePath = (customPath?: string): string => {
  if (customPath) {
    return resolve(customPath);
  }
  const inConfigData = resolve('/config/data', CATALOG_FILE_NAME);
  if (existsSync(inConfigData)) {
    return inConfigData;
  }
  const inConfig = resolve('/config', CATALOG_FILE_NAME);
  if (existsSync(inConfig)) {
    return inConfig;
  }
  const inLocalData = resolve('data', CATALOG_FILE_NAME);
  if (existsSync(inLocalData)) {
    return inLocalData;
  }
  if (existsSync('/config/config.toml')) {
    return inConfig;
  }
  return inLocalData;
};

/**
 * Loads the Jellyfin anime catalog cache from disk.
 * If the file does not exist or is invalid, returns an empty catalog structure.
 */
export const loadCatalog = (customPath?: string): CatalogData => {
  const filePath = getCatalogFilePath(customPath);
  if (!existsSync(filePath)) {
    return { lastUpdated: '', shows: {} };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CatalogData;
    if (parsed && typeof parsed.shows === 'object') {
      return parsed;
    }
    return { lastUpdated: '', shows: {} };
  } catch (err) {
    logger.error(`[Catalog] Failed reading catalog at ${filePath}:`, err);
    return { lastUpdated: '', shows: {} };
  }
};

/**
 * Saves catalog data to disk.
 */
export const saveCatalog = (data: CatalogData, customPath?: string): void => {
  const filePath = getCatalogFilePath(customPath);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.info(`[Catalog] Saved ${Object.keys(data.shows).length} shows to ${filePath}`);
};

/**
 * Prunes an overrides object so only shows, seasons, and episodes with
 * explicit overrides (numeric ID, null ID, or skipAniList) are retained.
 * Keeps mapping-overrides.json strictly sparse.
 */
export const pruneSparseOverrides = (overrides: RawTvdbOverrides): RawTvdbOverrides => {
  const pruned: RawTvdbOverrides = {};

  for (const [tvdbId, show] of Object.entries(overrides)) {
    const prunedSeasons: Record<string, RawSeasonOverride> = {};

    for (const [sKey, season] of Object.entries(show.seasons || {})) {
      const prunedEpisodes: Record<string, RawEpisodeOverride> = {};

      for (const [eKey, ep] of Object.entries(season.episodes || {})) {
        if (ep.anilistId !== undefined || ep.skipAniList) {
          prunedEpisodes[eKey] = ep;
        }
      }

      if (
        Object.keys(prunedEpisodes).length > 0 ||
        season.anilistId !== undefined ||
        season.anilistEpisodeOffset !== undefined
      ) {
        prunedSeasons[sKey] = {
          ...season,
          episodes: prunedEpisodes,
        };
      }
    }

    if (Object.keys(prunedSeasons).length > 0) {
      pruned[tvdbId] = {
        ...show,
        seasons: prunedSeasons,
      };
    }
  }

  return pruned;
};
