import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeCatalogDb,
  deleteSingleShowFromDb,
  getCatalogDb,
  getCatalogDbPath,
  getSingleShowFromDb,
  loadCatalogFromDb,
  saveCatalogToDb,
  saveSingleShowToDb,
  sweepDeletedFromDb,
} from './catalog-db';
import type { CatalogData, CatalogShow } from './catalog-types';

describe('Catalog SQLite Database Engine', () => {
  let tempDbPath: string;
  let tempJsonPath: string;

  beforeEach(() => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempDbPath = `/tmp/test-db-${id}.db`;
    tempJsonPath = `/tmp/test-db-${id}.json`;
  });

  afterEach(() => {
    closeCatalogDb(tempDbPath);
    if (existsSync(tempDbPath)) unlinkSync(tempDbPath);
    if (existsSync(`${tempDbPath}-wal`)) unlinkSync(`${tempDbPath}-wal`);
    if (existsSync(`${tempDbPath}-shm`)) unlinkSync(`${tempDbPath}-shm`);
    if (existsSync(tempJsonPath)) unlinkSync(tempJsonPath);
  });

  test('getCatalogDbPath should resolve .json paths to .db and keep .db paths intact', () => {
    expect(getCatalogDbPath('/tmp/test.json')).toBe('/tmp/test.db');
    expect(getCatalogDbPath('/tmp/test.db')).toBe('/tmp/test.db');
  });

  test('saveCatalogToDb and loadCatalogFromDb should persist and restore catalog hierarchy', () => {
    const mockData: CatalogData = {
      lastUpdated: '2026-10-21T20:00:00.000Z',
      shows: {
        '100': {
          tvdbId: '100',
          title: 'Frieren: Beyond Journey’s End',
          tmdbId: '209867',
          jellyfinSeriesId: 'jf-frieren',
          isMovie: false,
          isPrivate: false,
          libraryName: 'Anime',
          seasons: {
            '1': {
              seasonNumber: 1,
              name: 'Season 1',
              episodes: {
                '1': {
                  episodeNumber: 1,
                  name: 'The Journey’s End',
                  jellyfinEpisodeId: 'jf-ep-1',
                  tvdbEpisodeId: '9001',
                  locationType: 'FileSystem',
                  path: '/media/anime/frieren/s01e01.mkv',
                  exists: true,
                },
              },
            },
          },
        },
      },
    };

    saveCatalogToDb(mockData, tempDbPath);
    const loaded = loadCatalogFromDb(tempDbPath);

    expect(loaded.lastUpdated).toBe('2026-10-21T20:00:00.000Z');
    expect(loaded.shows['100']).toBeDefined();
    expect(loaded.shows['100']?.title).toBe('Frieren: Beyond Journey’s End');
    expect(loaded.shows['100']?.seasons['1']?.episodes['1']?.name).toBe('The Journey’s End');
    expect(loaded.shows['100']?.seasons['1']?.episodes['1']?.exists).toBe(true);
  });

  test('getSingleShowFromDb and saveSingleShowToDb should handle single series atomic updates', () => {
    const initialShow: CatalogShow = {
      tvdbId: '200',
      title: 'Steins;Gate',
      tmdbId: '333',
      jellyfinSeriesId: 'jf-sg',
      isMovie: false,
      seasons: {
        '1': {
          seasonNumber: 1,
          name: 'Season 1',
          episodes: {
            '1': { episodeNumber: 1, name: 'Prologue of the Beginning and the End', exists: true },
          },
        },
      },
    };

    saveSingleShowToDb(initialShow, tempDbPath);

    const fetched = getSingleShowFromDb('200', tempDbPath);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('Steins;Gate');
    expect(fetched?.seasons['1']?.episodes['1']?.name).toBe('Prologue of the Beginning and the End');

    // Update with second episode
    initialShow.seasons['1']!.episodes['2'] = {
      episodeNumber: 2,
      name: 'Time Travel Paranoia',
      exists: true,
    };
    saveSingleShowToDb(initialShow, tempDbPath);

    const updated = getSingleShowFromDb('200', tempDbPath);
    expect(Object.keys(updated?.seasons['1']?.episodes || {}).length).toBe(2);
    expect(updated?.seasons['1']?.episodes['2']?.name).toBe('Time Travel Paranoia');
  });

  test('deleteSingleShowFromDb should remove show, seasons, and episodes', () => {
    const show: CatalogShow = {
      tvdbId: '300',
      title: 'Show to Delete',
      seasons: {
        '1': {
          seasonNumber: 1,
          episodes: {
            '1': { episodeNumber: 1, name: 'Ep 1', exists: true },
          },
        },
      },
    };

    saveSingleShowToDb(show, tempDbPath);
    expect(getSingleShowFromDb('300', tempDbPath)).not.toBeNull();

    deleteSingleShowFromDb('300', tempDbPath);
    expect(getSingleShowFromDb('300', tempDbPath)).toBeNull();

    const fullCatalog = loadCatalogFromDb(tempDbPath);
    expect(fullCatalog.shows['300']).toBeUndefined();
  });

  test('sweepDeletedFromDb should prune shows and episodes with old sync ID', () => {
    const show1: CatalogShow = {
      tvdbId: '401',
      title: 'Keep Me',
      seasons: {
        '1': { seasonNumber: 1, episodes: { '1': { episodeNumber: 1, exists: true } } },
      },
    };
    const show2: CatalogShow = {
      tvdbId: '402',
      title: 'Delete Me',
      seasons: {
        '1': { seasonNumber: 1, episodes: { '1': { episodeNumber: 1, exists: true } } },
      },
    };

    saveCatalogToDb({ lastUpdated: '', shows: { '401': show1, '402': show2 } }, tempDbPath);

    // Run sweep for a future sync timestamp where only 401 is refreshed
    const nextSyncId = Date.now() + 10000;
    saveSingleShowToDb(show1, tempDbPath);
    // Directly update 401's last_seen_sync
    const db = getCatalogDb(tempDbPath);
    db.run('UPDATE catalog_shows SET last_seen_sync = ? WHERE tvdb_id = ?', [nextSyncId, '401']);
    db.run('UPDATE catalog_episodes SET last_seen_sync = ? WHERE tvdb_id = ?', [nextSyncId, '401']);

    const result = sweepDeletedFromDb(nextSyncId, tempDbPath);
    expect(result.prunedShows).toContain('402');

    const remaining = loadCatalogFromDb(tempDbPath);
    expect(remaining.shows['401']).toBeDefined();
    expect(remaining.shows['402']).toBeUndefined();
  });

  test('should auto-migrate from JSON on first database access if JSON exists', () => {
    const jsonData: CatalogData = {
      lastUpdated: '2026-10-15T12:00:00.000Z',
      shows: {
        '500': {
          tvdbId: '500',
          title: 'Migrated Anime',
          seasons: {
            '0': {
              seasonNumber: 0,
              episodes: {
                '1': { episodeNumber: 1, name: 'Migrated Movie', exists: true },
              },
            },
          },
        },
      },
    };

    writeFileSync(tempJsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');

    // Access the DB at tempDbPath (matching tempJsonPath basename)
    const loaded = loadCatalogFromDb(tempDbPath);
    expect(loaded.shows['500']).toBeDefined();
    expect(loaded.shows['500']?.title).toBe('Migrated Anime');
    expect(loaded.shows['500']?.seasons['0']?.episodes['1']?.name).toBe('Migrated Movie');
  });
});
