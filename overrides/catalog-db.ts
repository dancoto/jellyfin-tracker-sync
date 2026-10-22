import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../shared/logger';
import type {
  AnimeCatalog,
  CatalogData,
  CatalogShow,
} from './catalog-types';

export const CATALOG_DB_FILE_NAME = 'anime-catalog.db';
export const CATALOG_JSON_FILE_NAME = 'anime-catalog.json';

const dbCache = new Map<string, Database>();

export const getCatalogDbPath = (customPath?: string): string => {
  if (customPath) {
    const resolved = resolve(customPath);
    if (resolved.endsWith('.json')) {
      return resolved.replace(/\.json$/, '.db');
    }
    return resolved.endsWith('.db') ? resolved : `${resolved}.db`;
  }

  if (existsSync('/config/data')) {
    return resolve('/config/data', CATALOG_DB_FILE_NAME);
  }
  const inConfig = resolve('/config', CATALOG_DB_FILE_NAME);
  if (existsSync(inConfig)) {
    return inConfig;
  }
  if (existsSync('data')) {
    return resolve('data', CATALOG_DB_FILE_NAME);
  }
  if (existsSync('/config/config.toml')) {
    return inConfig;
  }
  return resolve('data', CATALOG_DB_FILE_NAME);
};

export const initCatalogDb = (db: Database): void => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_shows (
      tvdb_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      tmdb_id TEXT,
      jellyfin_series_id TEXT,
      is_movie INTEGER DEFAULT 0,
      is_private INTEGER DEFAULT 0,
      library_name TEXT,
      last_seen_sync INTEGER DEFAULT 0
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_seasons (
      tvdb_id TEXT NOT NULL REFERENCES catalog_shows(tvdb_id) ON DELETE CASCADE,
      season_number INTEGER NOT NULL,
      name TEXT,
      last_seen_sync INTEGER DEFAULT 0,
      PRIMARY KEY (tvdb_id, season_number)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_episodes (
      tvdb_id TEXT NOT NULL REFERENCES catalog_shows(tvdb_id) ON DELETE CASCADE,
      season_number INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      name TEXT,
      jellyfin_episode_id TEXT,
      tvdb_episode_id TEXT,
      location_type TEXT,
      path TEXT,
      exists_flag INTEGER DEFAULT 1,
      last_seen_sync INTEGER DEFAULT 0,
      PRIMARY KEY (tvdb_id, season_number, episode_number)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_shows_jf ON catalog_shows(jellyfin_series_id);');
  db.run('CREATE INDEX IF NOT EXISTS idx_episodes_jf ON catalog_episodes(jellyfin_episode_id);');
  db.run('CREATE INDEX IF NOT EXISTS idx_episodes_sync ON catalog_episodes(last_seen_sync);');
  db.run('CREATE INDEX IF NOT EXISTS idx_shows_sync ON catalog_shows(last_seen_sync);');
};

const insertCatalogData = (db: Database, data: CatalogData): void => {
  const insMeta = db.prepare(
    "INSERT INTO catalog_meta (key, value) VALUES ('last_updated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const insShow = db.prepare(`
    INSERT INTO catalog_shows (tvdb_id, title, tmdb_id, jellyfin_series_id, is_movie, is_private, library_name, last_seen_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tvdb_id) DO UPDATE SET
      title = excluded.title,
      tmdb_id = excluded.tmdb_id,
      jellyfin_series_id = excluded.jellyfin_series_id,
      is_movie = excluded.is_movie,
      is_private = excluded.is_private,
      library_name = excluded.library_name,
      last_seen_sync = excluded.last_seen_sync
  `);
  const insSeason = db.prepare(`
    INSERT INTO catalog_seasons (tvdb_id, season_number, name, last_seen_sync)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tvdb_id, season_number) DO UPDATE SET
      name = excluded.name,
      last_seen_sync = excluded.last_seen_sync
  `);
  const insEp = db.prepare(`
    INSERT INTO catalog_episodes (tvdb_id, season_number, episode_number, name, jellyfin_episode_id, tvdb_episode_id, location_type, path, exists_flag, last_seen_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tvdb_id, season_number, episode_number) DO UPDATE SET
      name = excluded.name,
      jellyfin_episode_id = excluded.jellyfin_episode_id,
      tvdb_episode_id = excluded.tvdb_episode_id,
      location_type = excluded.location_type,
      path = excluded.path,
      exists_flag = excluded.exists_flag,
      last_seen_sync = excluded.last_seen_sync
  `);

  const syncId = Date.now();

  db.transaction(() => {
    insMeta.run(data.lastUpdated || new Date().toISOString());

    // If completely replacing (e.g. from tests with empty data), clean first
    if (Object.keys(data.shows).length === 0) {
      db.run('DELETE FROM catalog_episodes;');
      db.run('DELETE FROM catalog_seasons;');
      db.run('DELETE FROM catalog_shows;');
      return;
    }

    for (const show of Object.values(data.shows)) {
      insShow.run(
        show.tvdbId,
        show.title,
        show.tmdbId ?? null,
        show.jellyfinSeriesId ?? null,
        show.isMovie ? 1 : 0,
        show.isPrivate ? 1 : 0,
        show.libraryName ?? null,
        syncId,
      );

      for (const season of Object.values(show.seasons || {})) {
        insSeason.run(show.tvdbId, season.seasonNumber, season.name ?? null, syncId);

        for (const ep of Object.values(season.episodes || {})) {
          insEp.run(
            show.tvdbId,
            season.seasonNumber,
            ep.episodeNumber,
            ep.name ?? null,
            ep.jellyfinEpisodeId ?? null,
            ep.tvdbEpisodeId ?? null,
            ep.locationType ?? null,
            ep.path ?? null,
            ep.exists === false ? 0 : 1,
            syncId,
          );
        }
      }
    }
  })();
};

const autoMigrateFromJsonIfAvailable = (db: Database, dbPath: string): void => {
  const countRow = db.query('SELECT COUNT(*) as count FROM catalog_shows').get() as { count: number };
  if (countRow && countRow.count > 0) {
    return; // Already populated
  }

  // Check if matching JSON file exists
  const jsonPath = dbPath.replace(/\.db$/, '.json');
  if (!existsSync(jsonPath)) {
    return;
  }

  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as CatalogData;
    if (parsed && typeof parsed.shows === 'object' && Object.keys(parsed.shows).length > 0) {
      logger.info(`[Catalog DB] Migrating ${Object.keys(parsed.shows).length} shows from ${jsonPath} to SQLite...`);
      insertCatalogData(db, parsed);
      logger.info(`[Catalog DB] Successfully migrated catalog to SQLite database at ${dbPath}`);
    }
  } catch (err) {
    logger.warn(`[Catalog DB] Could not auto-migrate from ${jsonPath}:`, err);
  }
};

export const getCatalogDb = (customPath?: string): Database => {
  const dbPath = getCatalogDbPath(customPath);
  const existing = dbCache.get(dbPath);
  if (existing) {
    return existing;
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  initCatalogDb(db);
  dbCache.set(dbPath, db);
  autoMigrateFromJsonIfAvailable(db, dbPath);
  return db;
};

export const closeCatalogDb = (customPath?: string): void => {
  const dbPath = getCatalogDbPath(customPath);
  const db = dbCache.get(dbPath);
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    dbCache.delete(dbPath);
  }
};

export const loadCatalogFromDb = (customPath?: string): CatalogData => {
  const db = getCatalogDb(customPath);

  const metaRow = db.query("SELECT value FROM catalog_meta WHERE key = 'last_updated'").get() as
    | { value: string }
    | null;
  const lastUpdated = metaRow?.value || '';

  const shows: AnimeCatalog = {};

  const showRows = db.query('SELECT * FROM catalog_shows').all() as Array<{
    tvdb_id: string;
    title: string;
    tmdb_id: string | null;
    jellyfin_series_id: string | null;
    is_movie: number;
    is_private: number;
    library_name: string | null;
  }>;

  for (const s of showRows) {
    shows[s.tvdb_id] = {
      tvdbId: s.tvdb_id,
      title: s.title,
      tmdbId: s.tmdb_id ?? undefined,
      jellyfinSeriesId: s.jellyfin_series_id ?? undefined,
      isMovie: s.is_movie === 1 ? true : undefined,
      isPrivate: s.is_private === 1 ? true : undefined,
      libraryName: s.library_name ?? undefined,
      seasons: {},
    };
  }

  const seasonRows = db.query('SELECT * FROM catalog_seasons').all() as Array<{
    tvdb_id: string;
    season_number: number;
    name: string | null;
  }>;

  for (const sea of seasonRows) {
    const show = shows[sea.tvdb_id];
    if (show) {
      show.seasons[String(sea.season_number)] = {
        seasonNumber: sea.season_number,
        name: sea.name ?? undefined,
        episodes: {},
      };
    }
  }

  const epRows = db.query('SELECT * FROM catalog_episodes').all() as Array<{
    tvdb_id: string;
    season_number: number;
    episode_number: number;
    name: string | null;
    jellyfin_episode_id: string | null;
    tvdb_episode_id: string | null;
    location_type: string | null;
    path: string | null;
    exists_flag: number;
  }>;

  for (const ep of epRows) {
    const show = shows[ep.tvdb_id];
    if (!show) continue;
    const sKey = String(ep.season_number);
    let season = show.seasons[sKey];
    if (!season) {
      season = { seasonNumber: ep.season_number, episodes: {} };
      show.seasons[sKey] = season;
    }
    season.episodes[String(ep.episode_number)] = {
      episodeNumber: ep.episode_number,
      name: ep.name ?? undefined,
      jellyfinEpisodeId: ep.jellyfin_episode_id ?? undefined,
      tvdbEpisodeId: ep.tvdb_episode_id ?? undefined,
      locationType: ep.location_type ?? undefined,
      path: ep.path ?? undefined,
      exists: ep.exists_flag === 1,
    };
  }

  return { lastUpdated, shows };
};

export const saveCatalogToDb = (data: CatalogData, customPath?: string): void => {
  const db = getCatalogDb(customPath);
  insertCatalogData(db, data);
};

export const getSingleShowFromDb = (tvdbId: string, customPath?: string): CatalogShow | null => {
  const db = getCatalogDb(customPath);

  const s = db.query('SELECT * FROM catalog_shows WHERE tvdb_id = ?').get(tvdbId) as {
    tvdb_id: string;
    title: string;
    tmdb_id: string | null;
    jellyfin_series_id: string | null;
    is_movie: number;
    is_private: number;
    library_name: string | null;
  } | null;

  if (!s) return null;

  const show: CatalogShow = {
    tvdbId: s.tvdb_id,
    title: s.title,
    tmdbId: s.tmdb_id ?? undefined,
    jellyfinSeriesId: s.jellyfin_series_id ?? undefined,
    isMovie: s.is_movie === 1 ? true : undefined,
    isPrivate: s.is_private === 1 ? true : undefined,
    libraryName: s.library_name ?? undefined,
    seasons: {},
  };

  const seasonRows = db.query('SELECT * FROM catalog_seasons WHERE tvdb_id = ?').all(tvdbId) as Array<{
    season_number: number;
    name: string | null;
  }>;

  for (const sea of seasonRows) {
    show.seasons[String(sea.season_number)] = {
      seasonNumber: sea.season_number,
      name: sea.name ?? undefined,
      episodes: {},
    };
  }

  const epRows = db.query('SELECT * FROM catalog_episodes WHERE tvdb_id = ?').all(tvdbId) as Array<{
    season_number: number;
    episode_number: number;
    name: string | null;
    jellyfin_episode_id: string | null;
    tvdb_episode_id: string | null;
    location_type: string | null;
    path: string | null;
    exists_flag: number;
  }>;

  for (const ep of epRows) {
    const sKey = String(ep.season_number);
    let season = show.seasons[sKey];
    if (!season) {
      season = { seasonNumber: ep.season_number, episodes: {} };
      show.seasons[sKey] = season;
    }
    season.episodes[String(ep.episode_number)] = {
      episodeNumber: ep.episode_number,
      name: ep.name ?? undefined,
      jellyfinEpisodeId: ep.jellyfin_episode_id ?? undefined,
      tvdbEpisodeId: ep.tvdb_episode_id ?? undefined,
      locationType: ep.location_type ?? undefined,
      path: ep.path ?? undefined,
      exists: ep.exists_flag === 1,
    };
  }

  return show;
};

export const saveSingleShowToDb = (show: CatalogShow, customPath?: string): void => {
  const db = getCatalogDb(customPath);
  const syncId = Date.now();

  const insShow = db.prepare(`
    INSERT INTO catalog_shows (tvdb_id, title, tmdb_id, jellyfin_series_id, is_movie, is_private, library_name, last_seen_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tvdb_id) DO UPDATE SET
      title = excluded.title,
      tmdb_id = excluded.tmdb_id,
      jellyfin_series_id = excluded.jellyfin_series_id,
      is_movie = excluded.is_movie,
      is_private = excluded.is_private,
      library_name = excluded.library_name,
      last_seen_sync = excluded.last_seen_sync
  `);

  const insSeason = db.prepare(`
    INSERT INTO catalog_seasons (tvdb_id, season_number, name, last_seen_sync)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tvdb_id, season_number) DO UPDATE SET
      name = excluded.name,
      last_seen_sync = excluded.last_seen_sync
  `);

  const insEp = db.prepare(`
    INSERT INTO catalog_episodes (tvdb_id, season_number, episode_number, name, jellyfin_episode_id, tvdb_episode_id, location_type, path, exists_flag, last_seen_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tvdb_id, season_number, episode_number) DO UPDATE SET
      name = excluded.name,
      jellyfin_episode_id = excluded.jellyfin_episode_id,
      tvdb_episode_id = excluded.tvdb_episode_id,
      location_type = excluded.location_type,
      path = excluded.path,
      exists_flag = excluded.exists_flag,
      last_seen_sync = excluded.last_seen_sync
  `);

  const insMeta = db.prepare(
    "INSERT INTO catalog_meta (key, value) VALUES ('last_updated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  db.transaction(() => {
    insMeta.run(new Date().toISOString());

    insShow.run(
      show.tvdbId,
      show.title,
      show.tmdbId ?? null,
      show.jellyfinSeriesId ?? null,
      show.isMovie ? 1 : 0,
      show.isPrivate ? 1 : 0,
      show.libraryName ?? null,
      syncId,
    );

    // Delete existing seasons and episodes for this show so stale ones disappear
    db.query('DELETE FROM catalog_episodes WHERE tvdb_id = ?').run(show.tvdbId);
    db.query('DELETE FROM catalog_seasons WHERE tvdb_id = ?').run(show.tvdbId);

    for (const season of Object.values(show.seasons || {})) {
      insSeason.run(show.tvdbId, season.seasonNumber, season.name ?? null, syncId);

      for (const ep of Object.values(season.episodes || {})) {
        insEp.run(
          show.tvdbId,
          season.seasonNumber,
          ep.episodeNumber,
          ep.name ?? null,
          ep.jellyfinEpisodeId ?? null,
          ep.tvdbEpisodeId ?? null,
          ep.locationType ?? null,
          ep.path ?? null,
          ep.exists === false ? 0 : 1,
          syncId,
        );
      }
    }
  })();

  if (customPath && customPath.endsWith('.json')) {
    try {
      const data = loadCatalogFromDb(customPath);
      writeFileSync(customPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }
};

export const deleteSingleShowFromDb = (tvdbId: string, customPath?: string): void => {
  const db = getCatalogDb(customPath);
  db.transaction(() => {
    db.query('DELETE FROM catalog_episodes WHERE tvdb_id = ?').run(tvdbId);
    db.query('DELETE FROM catalog_seasons WHERE tvdb_id = ?').run(tvdbId);
    db.query('DELETE FROM catalog_shows WHERE tvdb_id = ?').run(tvdbId);
    db.query(
      "INSERT INTO catalog_meta (key, value) VALUES ('last_updated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(new Date().toISOString());
  })();

  if (customPath && customPath.endsWith('.json')) {
    try {
      const data = loadCatalogFromDb(customPath);
      writeFileSync(customPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }
};

export const sweepDeletedFromDb = (
  syncId: number,
  customPath?: string,
): { prunedShows: string[]; prunedEpisodes: number } => {
  const db = getCatalogDb(customPath);

  const staleShows = db
    .query('SELECT tvdb_id FROM catalog_shows WHERE last_seen_sync < ?')
    .all(syncId) as Array<{ tvdb_id: string }>;
  const staleShowsList = staleShows.map((s) => s.tvdb_id);

  const staleEpisodesCount = (
    db.query('SELECT COUNT(*) as count FROM catalog_episodes WHERE last_seen_sync < ?').get(syncId) as {
      count: number;
    }
  ).count;

  db.transaction(() => {
    db.query('DELETE FROM catalog_episodes WHERE last_seen_sync < ?').run(syncId);
    db.query('DELETE FROM catalog_seasons WHERE last_seen_sync < ?').run(syncId);
    db.query('DELETE FROM catalog_shows WHERE last_seen_sync < ?').run(syncId);
  })();

  return {
    prunedShows: staleShowsList,
    prunedEpisodes: staleEpisodesCount,
  };
};
