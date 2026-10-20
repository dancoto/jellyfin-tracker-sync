import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { importJellyfinAnimeMappings } from './importer';
import { appConfig } from '../shared/config';

describe('Jellyfin Mappings Bulk Importer', () => {
  let tempOverridesPath: string;
  let originalConfig: any;
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: any;

  beforeEach(() => {
    tempOverridesPath = `/tmp/test-importer-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    originalConfig = JSON.parse(JSON.stringify(appConfig));
    originalFetch = globalThis.fetch;
    appConfig.jellyfin = { url: 'http://jellyfin-mock:8096', token: 'mock-jf-token' };

    // Initial manual overrides file with custom mappings
    const initialOverrides = {
      '70861': {
        title: 'Love Hina',
        seasons: {
          '1': {
            episodes: {
              '25': {
                name: 'Final Special',
                anilistId: null, // explicitly unmapped
              },
            },
          },
        },
      },
      '82310': {
        title: 'Princess Lover!',
        seasons: {
          '0': {
            episodes: {
              '1': {
                name: 'OVA 1',
                anilistId: 8231, // manual override differing from official
                anilistEpisode: 1,
              },
            },
          },
        },
      },
      '75003': {
        title: 'Maburaho',
        seasons: {
          '0': {
            episodes: {
              '1': {
                name: 'Special 1',
                skipAniList: true, // explicit skip
              },
            },
          },
        },
      },
    };

    writeFileSync(tempOverridesPath, JSON.stringify(initialOverrides, null, 2), 'utf-8');

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
                // Existing episode in Princess Lover (S0E1)
                {
                  Id: 'jf-ep-1',
                  SeriesId: 'jf-series-1',
                  ParentIndexNumber: 0,
                  IndexNumber: 1,
                  Name: 'OVA 1 Official Name',
                  LocationType: 'FileSystem',
                  Path: '/anime/Princess Lover/ova1.mkv',
                },
                // New episode in Princess Lover (S0E2)
                {
                  Id: 'jf-ep-2',
                  SeriesId: 'jf-series-1',
                  ParentIndexNumber: 0,
                  IndexNumber: 2,
                  Name: 'OVA 2',
                  LocationType: 'FileSystem',
                  Path: '/anime/Princess Lover/ova2.mkv',
                },
                // New series episodes (Brand New Anime S1E1, S1E2)
                {
                  Id: 'jf-ep-3',
                  SeriesId: 'jf-series-2',
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  Name: 'New Ep 1',
                },
                {
                  Id: 'jf-ep-4',
                  SeriesId: 'jf-series-2',
                  ParentIndexNumber: 1,
                  IndexNumber: 2,
                  Name: 'New Ep 2',
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
              Items: [],
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
    if (existsSync(tempOverridesPath)) {
      unlinkSync(tempOverridesPath);
    }
  });

  test('should bulk import anime from Jellyfin while strictly preserving manual mappings', async () => {
    const summary = await importJellyfinAnimeMappings({
      libraryNames: ['Anime'],
      customOverridesPath: tempOverridesPath,
    });

    expect(summary.totalSeriesScanned).toBe(2);
    expect(summary.totalEpisodesScanned).toBe(4);
    expect(summary.showsAdded).toBe(1); // Brand New Anime added
    expect(summary.episodesAdded).toBe(3); // S0E2 in Princess Lover, S1E1 & S1E2 in Brand New Anime
    expect(summary.preservedManualEpisodes).toBe(1); // S0E1 in Princess Lover preserved

    // Check file content
    const updated = JSON.parse(readFileSync(tempOverridesPath, 'utf-8'));

    // 1. Existing Princess Lover S0E1 manual override (8231) preserved!
    expect(updated['82310'].seasons['0'].episodes['1'].anilistId).toBe(8231);
    expect(updated['82310'].seasons['0'].episodes['1'].anilistEpisode).toBe(1);

    // 2. Newly imported Princess Lover S0E2 added without overwriting
    expect(updated['82310'].seasons['0'].episodes['2']).toBeDefined();
    expect(updated['82310'].seasons['0'].episodes['2'].name).toBe('OVA 2');
    expect(updated['82310'].seasons['0'].episodes['2'].anilistId).toBeUndefined();

    // 3. Existing Love Hina null mapping preserved!
    expect(updated['70861'].seasons['1'].episodes['25'].anilistId).toBeNull();

    // 4. Existing Maburaho skip mapping preserved!
    expect(updated['75003'].seasons['0'].episodes['1'].skipAniList).toBe(true);

    // 5. Brand New Anime imported cleanly
    expect(updated['999111']).toBeDefined();
    expect(updated['999111'].title).toBe('Brand New Anime');
    expect(updated['999111'].seasons['1'].episodes['1'].name).toBe('New Ep 1');
    expect(updated['999111'].seasons['1'].episodes['2'].name).toBe('New Ep 2');

    // 6. Verify backup file was created
    expect(summary.backupPath).toBeDefined();
    expect(existsSync(summary.backupPath!)).toBe(true);
    unlinkSync(summary.backupPath!);
  });
});
