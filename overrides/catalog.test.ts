import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  getCatalogFilePath,
  loadCatalog,
  pruneSparseOverrides,
  saveCatalog,
  syncJellyfinCatalog,
  syncJellyfinSeries,
  type CatalogData,
} from './catalog';
import { appConfig } from '../shared/config';

describe('Jellyfin Anime Catalog & Sparse Overrides Pruner', () => {
  let tempCatalogPath: string;
  let originalConfig: any;
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: any;

  beforeEach(() => {
    tempCatalogPath = `/tmp/test-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    originalConfig = JSON.parse(JSON.stringify(appConfig));
    originalFetch = globalThis.fetch;
    appConfig.jellyfin = {
      url: 'http://jellyfin-mock:8096',
      token: 'mock-jf-token',
      anime_libraries: ['Anime'],
      private_anime_libraries: ['Other Anime', 'Other Anime Movies'],
    };

    fetchMock = mock((urlInput: string | URL) => {
      const url = urlInput.toString();

      // Virtual folders
      if (url.includes('/Library/VirtualFolders')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { Name: 'Anime', ItemId: 'folder-anime' },
              { Name: 'Movies', ItemId: 'folder-movies' },
              { Name: 'Other Anime', ItemId: 'folder-other-anime' },
              { Name: 'Other Anime Movies', ItemId: 'folder-other-anime-movies' },
            ]),
          ),
        );
      }

      // Direct item lookup by ID
      if (url.includes('/Items') && url.includes('ids=')) {
        if (url.includes('ids=jf-series-1')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                Items: [
                  {
                    Id: 'jf-series-1',
                    Name: 'Princess Lover!',
                    Type: 'Series',
                    ProviderIds: { Tvdb: '82310', Tmdb: '33333' },
                  },
                ],
              }),
            ),
          );
        }
      }

      // Series in Anime folder
      if (url.includes('/Items') && url.includes('includeItemTypes=Series')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Items: [
                {
                  Id: 'jf-series-1',
                  Name: 'Princess Lover!',
                  ProviderIds: { Tvdb: '82310', Tmdb: '33333' },
                },
                {
                  Id: 'jf-series-2',
                  Name: 'Brand New Anime',
                  ProviderIds: { Tvdb: '999111', Tmdb: '44444' },
                },
              ],
            }),
          ),
        );
      }

      // Episodes in Anime folder
      if (url.includes('/Items') && url.includes('includeItemTypes=Episode')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Items: [
                {
                  Id: 'jf-ep-1',
                  SeriesId: 'jf-series-1',
                  ParentIndexNumber: 0,
                  IndexNumber: 1,
                  Name: 'OVA 1',
                  LocationType: 'FileSystem',
                  Path: '/media/anime/Princess Lover/s00e01.mkv',
                  ProviderIds: { Tvdb: '1001' },
                },
                {
                  Id: 'jf-ep-2',
                  SeriesId: 'jf-series-1',
                  ParentIndexNumber: 0,
                  IndexNumber: 2,
                  Name: 'OVA 2 (Virtual Missing)',
                  LocationType: 'Virtual',
                  ProviderIds: { Tvdb: '1002' },
                },
                {
                  Id: 'jf-ep-3',
                  SeriesId: 'jf-series-2',
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  Name: 'New Ep 1 (Virtual Future)',
                  SeasonName: 'The Exiled Virgin',
                  LocationType: 'Virtual',
                },
              ],
            }),
          ),
        );
      }

      // Movies in Anime folder
      if (url.includes('/Items') && url.includes('includeItemTypes=Movie')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Items: [
                {
                  Id: 'jf-movie-1',
                  Name: 'Anime Movie',
                  ProviderIds: { Tvdb: '555666' },
                },
              ],
            }),
          ),
        );
      }

      return Promise.resolve(new Response('{}'));
    });

    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appConfig.jellyfin = originalConfig.jellyfin;
    if (existsSync(tempCatalogPath)) {
      unlinkSync(tempCatalogPath);
    }
  });

  test('pruneSparseOverrides should only keep explicit numeric, null, or skipped overrides', () => {
    const rawOverrides: any = {
      '82310': {
        title: 'Princess Lover!',
        seasons: {
          '0': {
            episodes: {
              '1': { name: 'OVA 1', anilistId: 8231, anilistEpisode: 1 },
              '2': { name: 'OVA 2' }, // no override -> should be pruned!
            },
          },
          '1': {
            episodes: {
              '1': { name: 'Ep 1' }, // no override -> season 1 pruned completely!
            },
          },
        },
      },
      '70861': {
        title: 'Love Hina',
        seasons: {
          '1': {
            episodes: {
              '25': { name: 'Final Special', anilistId: null }, // explicit null -> kept!
            },
          },
        },
      },
      '75003': {
        title: 'Maburaho',
        seasons: {
          '0': {
            episodes: {
              '1': { name: 'Special 1', skipAniList: true }, // skip -> kept!
            },
          },
        },
      },
      '999999': {
        title: 'Completely Unmodified Anime',
        seasons: {
          '1': {
            episodes: {
              '1': { name: 'Ep 1' },
              '2': { name: 'Ep 2' },
            },
          },
        },
      },
    };

    const pruned = pruneSparseOverrides(rawOverrides);

    // 82310 should only have Season 0 Episode 1
    expect(pruned['82310']).toBeDefined();
    expect(pruned['82310']?.seasons?.['0']?.episodes?.['1']?.anilistId).toBe(8231);
    expect(pruned['82310']?.seasons?.['0']?.episodes?.['2']).toBeUndefined();
    expect(pruned['82310']?.seasons?.['1']).toBeUndefined();

    // 70861 should keep explicit null
    expect(pruned['70861']?.seasons?.['1']?.episodes?.['25']?.anilistId).toBeNull();

    // 75003 should keep skipAniList
    expect(pruned['75003']?.seasons?.['0']?.episodes?.['1']?.skipAniList).toBe(true);

    // 999999 should be completely pruned
    expect(pruned['999999']).toBeUndefined();
  });

  test('loadCatalog and saveCatalog should read and write catalog correctly', () => {
    const data: CatalogData = {
      lastUpdated: '2026-10-13T10:00:00.000Z',
      shows: {
        '82310': {
          tvdbId: '82310',
          title: 'Princess Lover!',
          seasons: {
            '0': {
              seasonNumber: 0,
              episodes: {
                '1': { episodeNumber: 1, name: 'OVA 1' },
              },
            },
          },
        },
      },
    };

    saveCatalog(data, tempCatalogPath);
    const loaded = loadCatalog(tempCatalogPath);

    expect(loaded.lastUpdated).toBe('2026-10-13T10:00:00.000Z');
    expect(loaded.shows['82310']).toBeDefined();
    expect(loaded.shows['82310']?.title).toBe('Princess Lover!');
    expect(loaded.shows['82310']?.seasons?.['0']?.episodes?.['1']?.name).toBe('OVA 1');
  });

  test('syncJellyfinCatalog should scan Jellyfin and build catalog without touching overrides', async () => {
    const summary = await syncJellyfinCatalog({
      customCatalogPath: tempCatalogPath,
    });

    expect(summary.librariesScanned).toEqual(['Anime', 'Other Anime', 'Other Anime Movies']);
    expect(summary.totalSeriesScanned).toBe(6);
    expect(summary.totalEpisodesScanned).toBe(9);
    expect(summary.totalMoviesScanned).toBe(3);
    expect(summary.catalogShowsCount).toBe(3); // 2 series + 1 movie
    expect(summary.catalogEpisodesCount).toBe(3); // 1 real special + 1 virtual regular episode + 1 movie

    const loaded = loadCatalog(tempCatalogPath);
    expect(loaded.shows['82310']).toBeDefined();
    expect(loaded.shows['82310']?.isPrivate).toBe(true);
    expect(loaded.shows['82310']?.seasons?.['0']?.episodes?.['1']?.name).toBe('OVA 1');
    expect(loaded.shows['82310']?.seasons?.['0']?.episodes?.['1']?.exists).toBe(true);
    // Virtual special was excluded!
    expect(loaded.shows['82310']?.seasons?.['0']?.episodes?.['2']).toBeUndefined();
    // Virtual regular episode was included!
    expect(loaded.shows['999111']).toBeDefined();
    expect(loaded.shows['999111']?.seasons?.['1']?.episodes?.['1']?.name).toBe(
      'New Ep 1 (Virtual Future)',
    );
    expect(loaded.shows['999111']?.seasons?.['1']?.name).toBe('The Exiled Virgin');
    expect(loaded.shows['999111']?.seasons?.['1']?.episodes?.['1']?.exists).toBe(false);
    expect(loaded.shows['555666']).toBeDefined(); // Movie
    expect(loaded.shows['555666']?.isMovie).toBe(true);
  });

  test('syncJellyfinSeries should sync a single series from Jellyfin without scanning other shows', async () => {
    const summary = await syncJellyfinSeries('82310', {
      customCatalogPath: tempCatalogPath,
    });

    expect(summary.tvdbId).toBe('82310');
    expect(summary.title).toBe('Princess Lover!');
    expect(summary.deleted).toBe(false);
    expect(summary.totalEpisodes).toBe(1); // Real special only; virtual special excluded
    expect(summary.show).toBeDefined();
    expect(summary.show?.seasons['0']?.episodes['1']?.name).toBe('OVA 1');

    const loaded = loadCatalog(tempCatalogPath);
    expect(loaded.shows['82310']).toBeDefined();
    expect(loaded.shows['999111']).toBeUndefined(); // Other shows were NOT scanned
  });

  test('syncJellyfinSeries should sync a single movie from Jellyfin', async () => {
    const summary = await syncJellyfinSeries('555666', {
      customCatalogPath: tempCatalogPath,
    });

    expect(summary.tvdbId).toBe('555666');
    expect(summary.title).toBe('Anime Movie');
    expect(summary.deleted).toBe(false);
    expect(summary.totalEpisodes).toBe(1);
    expect(summary.show?.seasons['0']?.episodes['1']?.name).toBe('Anime Movie');

    const loaded = loadCatalog(tempCatalogPath);
    expect(loaded.shows['555666']).toBeDefined();
  });

  test('syncJellyfinSeries should mark deleted when series does not exist in Jellyfin', async () => {
    const summary = await syncJellyfinSeries('9999999', {
      customCatalogPath: tempCatalogPath,
    });

    expect(summary.tvdbId).toBe('9999999');
    expect(summary.deleted).toBe(true);
    expect(summary.totalEpisodes).toBe(0);
  });

  test('syncJellyfinSeries should sync directly using jellyfinSeriesId option without searching folders', async () => {
    const summary = await syncJellyfinSeries('', {
      jellyfinSeriesId: 'jf-series-1',
      customCatalogPath: tempCatalogPath,
    });

    expect(summary.tvdbId).toBe('82310');
    expect(summary.title).toBe('Princess Lover!');
    expect(summary.deleted).toBe(false);
    expect(summary.totalEpisodes).toBe(1);

    const loaded = loadCatalog(tempCatalogPath);
    expect(loaded.shows['82310']).toBeDefined();
  });

  test('getCatalogFilePath should return customPath when provided or resolve default location', () => {
    expect(getCatalogFilePath('/custom/path/catalog.json')).toBe('/custom/path/catalog.json');
    const defaultPath = getCatalogFilePath();
    expect(defaultPath.endsWith('anime-catalog.json')).toBe(true);
  });
});
