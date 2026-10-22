import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  RawEpisodeOverride,
  RawSeasonOverride,
  RawTvdbOverrides,
} from '../anime/tvdb-overrides';
import {
  CATALOG_DB_FILE_NAME,
  CATALOG_JSON_FILE_NAME,
  closeCatalogDb,
  deleteSingleShowFromDb,
  getCatalogDb,
  getCatalogDbPath,
  getSingleShowFromDb,
  loadCatalogFromDb,
  saveCatalogToDb,
  saveSingleShowToDb,
} from './catalog-db';
import type { CatalogData } from './catalog-types';

export {
  CATALOG_DB_FILE_NAME,
  CATALOG_JSON_FILE_NAME,
  closeCatalogDb,
  deleteSingleShowFromDb,
  getCatalogDb,
  getCatalogDbPath,
  getSingleShowFromDb,
  saveSingleShowToDb,
};

export const CATALOG_FILE_NAME = CATALOG_JSON_FILE_NAME;

export const getCatalogFilePath = (customPath?: string): string => {
  if (customPath) {
    return resolve(customPath);
  }
  if (existsSync('/config/data')) {
    return resolve('/config/data', CATALOG_FILE_NAME);
  }
  const inConfig = resolve('/config', CATALOG_FILE_NAME);
  if (existsSync(inConfig)) {
    return inConfig;
  }
  if (existsSync('data')) {
    return resolve('data', CATALOG_FILE_NAME);
  }
  if (existsSync('/config/config.toml')) {
    return inConfig;
  }
  return resolve('data', CATALOG_FILE_NAME);
};

/**
 * Loads the Jellyfin anime catalog from SQLite database (with automatic JSON migration if first run).
 */
export const loadCatalog = (customPath?: string): CatalogData => {
  return loadCatalogFromDb(customPath);
};

/**
 * Saves catalog data to SQLite database (and updates JSON if explicitly targeting a .json path, e.g. in tests).
 */
export const saveCatalog = (data: CatalogData, customPath?: string): void => {
  saveCatalogToDb(data, customPath);

  // If customPath is provided and ends with .json, also sync to file for unit test compatibility
  if (customPath && customPath.endsWith('.json')) {
    try {
      const dir = dirname(customPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(customPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }
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
