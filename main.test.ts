import { existsSync, unlinkSync } from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { AniBridgeIndex, defaultAnimeResolver } from './anime';
import { TvdbOverridesIndex } from './anime/tvdb-overrides';
import { defaultJellyfinClient } from './jellyfin';
import { clearNotificationCooldowns, handleWebhook } from './main';
import {
  clearSeriesSyncQueue,
  flushAllPendingSeriesSync,
  getPendingSeriesSyncCount,
  resetSeriesSyncRunner,
  setSeriesSyncRunner,
} from './overrides/series-debouncer';
import { appConfig } from './shared/config';

describe('Main Webhook Handler', () => {
  let fetchMock: any;
  let originalConfig: any;
  let tempOverridesPath: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearSeriesSyncQueue();
    tempOverridesPath = `/tmp/test-main-overrides-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    defaultAnimeResolver.setTvdbOverridesPath(tempOverridesPath);
    clearNotificationCooldowns();
    originalConfig = JSON.parse(JSON.stringify(appConfig));
    appConfig.jellyfin = { url: 'http://jellyfin-mock:8096', token: 'mock-jf-token' };
    appConfig.simkl = {
      app_name: 'mock-simkl-app',
      client_id: 'mock-simkl-client-id',
      users: { 'test-user': 'mock-simkl-user-token' },
    };
    appConfig.ntfy = {
      url: 'http://ntfy-mock',
      token: 'mock-ntfy-token',
      topic: 'mock-ntfy-topic',
    };

    // Setup AniBridge test mappings in resolver
    const testAniBridge = AniBridgeIndex.parse({
      // Attack on Titan TVDB 267440 Season 1 -> AniDB 9541 -> AniList 16498
      'anidb:9541:R': {
        'tvdb_show:267440:s1': { '1-25': '1-25' },
        'anilist:16498': { '1-25': '1-25' },
      },
      // Test Movie: TMDB 54321 -> AniDB 54321 -> AniList 54321
      'anidb:54321:R': {
        'tmdb_movie:54321': { '1': '1' },
        'anilist:54321': { '1': '1' },
      },
      // Valid Movie: TMDB 12345 -> AniDB 12345 -> AniList 164
      'anidb:12345:R': {
        'tmdb_movie:12345': { '1': '1' },
        'anilist:164': { '1': '1' },
      },
      // Anime with AniDB mapping but NO AniList mapping: TVDB 77777 -> AniDB 7777
      'anidb:7777:R': {
        'tvdb_show:77777:s1': { '1-12': '1-12' },
      },
    });
    defaultAnimeResolver.setIndices(testAniBridge);
    defaultJellyfinClient.clearCache();

    fetchMock = mock((urlInput: string | URL, options?: any) => {
      const url = urlInput.toString();

      // Mock Jellyfin API: GET /Items/{id}/Ancestors
      if (url.includes('/Ancestors')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { Name: 'Season 1', Type: 'Season' },
              { Name: 'Attack on Titan', Type: 'Series' },
              { Name: 'Anime TV', Type: 'CollectionFolder' },
            ]),
          ),
        );
      }

      // Mock Jellyfin API: GET /Items/{SeriesId} or /Items?ids={SeriesId}
      if (url.includes('series-jf-1')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Id: 'series-jf-1',
              Name: 'Attack on Titan',
              ProviderIds: {
                Tvdb: '267440',
              },
              Items: [
                {
                  Id: 'series-jf-1',
                  Name: 'Attack on Titan',
                  ProviderIds: {
                    Tvdb: '267440',
                  },
                },
              ],
            }),
          ),
        );
      }

      // Mock Simkl API: /sync/history
      if (url.includes('api.simkl.com/sync/history')) {
        const body = JSON.parse(options?.body || '{}');
        const isMovie = 'movies' in body;
        const anilistId = isMovie
          ? (body.movies?.[0]?.ids?.anilist ?? body.movies?.[0]?.ids?.tmdb)
          : (body.anime?.[0]?.ids?.anilist ?? body.shows?.[0]?.ids?.tvdb);
        const isNotFoundTest = String(anilistId) === '54321'; // 54321 simulates not_found

        return Promise.resolve(
          new Response(
            JSON.stringify({
              added: {
                movies: isMovie && !isNotFoundTest ? 1 : 0,
                shows: !isMovie && !isNotFoundTest ? 1 : 0,
                anime: !isMovie && !isNotFoundTest ? 1 : 0,
                episodes: !isMovie && !isNotFoundTest ? 1 : 0,
                statuses: isNotFoundTest
                  ? []
                  : [
                      {
                        request: {
                          ids: isMovie
                            ? body.movies?.[0]?.ids
                            : (body.anime?.[0]?.ids ?? body.shows?.[0]?.ids),
                          type: isMovie ? 'movie' : 'show',
                        },
                      },
                    ],
              },
              not_found: {
                movies: isMovie && isNotFoundTest ? [anilistId] : [],
                shows: !isMovie && isNotFoundTest ? [anilistId] : [],
                anime: !isMovie && isNotFoundTest ? [anilistId] : [],
                episodes: !isMovie && isNotFoundTest ? [anilistId] : [],
              },
            }),
          ),
        );
      }

      // Mock AniList GraphQL API
      if (url.includes('graphql.anilist.co')) {
        const body = JSON.parse(options?.body || '{}');
        if (body.query.includes('mutation')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  SaveMediaListEntry: {
                    id: 101,
                    mediaId: body.variables.mediaId,
                    progress: body.variables.progress,
                    status: body.variables.status,
                  },
                },
              }),
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: body.variables.mediaId,
                  episodes: body.variables.mediaId === 164 ? 1 : 25,
                  title: { english: 'Mock Anime' },
                  mediaListEntry: { progress: 0, status: 'CURRENT' },
                },
              },
            }),
          ),
        );
      }

      // Default mock response for ntfy
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });

    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearSeriesSyncQueue();
    resetSeriesSyncRunner();
    defaultAnimeResolver.setTvdbOverridesPath(undefined);
    if (existsSync(tempOverridesPath)) {
      unlinkSync(tempOverridesPath);
    }
    Object.assign(appConfig, originalConfig);
    mock.restore();
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    defaultAnimeResolver.reset();
    await defaultAnimeResolver.initialize();
  });

  test('should exit early if user has no Simkl or AniList token', async () => {
    const payload: any = {
      NotificationUsername: 'unknown-user',
    };

    await handleWebhook(payload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('should exit early if playback is not completed (< 80%)', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 200, // 20%
    };

    await handleWebhook(payload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('should route to anime pipeline when LibraryName contains Anime', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900, // 90%
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(1);

    expect(calls[0][0].toString()).toContain('api.simkl.com/sync/history');
    const simklBody = JSON.parse(calls[0][1].body);
    expect(simklBody.anime[0].ids.anilist).toBe('16498');
    expect(simklBody.anime[0].episodes[0].number).toBe(1);
  });

  test('should route to standard pipeline when LibraryName does not contain Anime', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Pilot',
      SeriesName: 'Breaking Bad',
      LibraryName: 'TV Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      Year: 2008,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '81189',
      Series_Provider_tmdb: '1396',
    };

    await handleWebhook(payload);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(1);

    expect(calls[0][0].toString()).toContain('api.simkl.com/sync/history');
    const simklBody = JSON.parse(calls[0][1].body);
    // Should NOT have anidb ID! Should have TVDB/TMDB
    expect(simklBody.shows[0].ids.tvdb).toBe('81189');
    expect(simklBody.shows[0].ids.tmdb).toBe('1396');
    expect(simklBody.shows[0].title).toBe('Breaking Bad');
  });

  test('should skip Simkl and send private: true to AniList when library is in private_anime_libraries', async () => {
    appConfig.jellyfin = {
      ...appConfig.jellyfin!,
      private_anime_libraries: ['Other Anime', 'Other Anime Movies'],
    };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-token' },
    };

    defaultAnimeResolver.ensureShowInOverrides({
      tvdbId: '364395',
      title: 'Bible Black',
      seasonNumber: 1,
      episodeNumber: 1,
      anilistId: 99911,
      anilistEpisode: 1,
    });

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Episode 1',
      SeriesName: 'Bible Black',
      LibraryName: 'Other Anime',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '364395',
    };

    await handleWebhook(payload, { debounceMs: 0 });

    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0]?.toString().includes('simkl.com'),
    );
    expect(simklCalls.length).toBe(0);

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0]?.toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBeGreaterThan(0);
    const anilistMutationCall = anilistCalls.find((c: any) => {
      const b = JSON.parse(c[1]?.body ?? '{}');
      return b.query?.includes('SaveMediaListEntry');
    });
    expect(anilistMutationCall).toBeDefined();
    const mutationBody = JSON.parse(anilistMutationCall[1].body);
    expect(mutationBody.variables.private).toBe(true);
  });

  test('should skip Simkl and send private: true to AniList for private anime movies', async () => {
    appConfig.jellyfin = {
      ...appConfig.jellyfin!,
      private_anime_libraries: ['Other Anime', 'Other Anime Movies'],
    };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-token' },
    };

    defaultAnimeResolver.ensureShowInOverrides({
      tvdbId: 'tmdb-999999',
      title: 'Adult Anime Movie',
      seasonNumber: 0,
      episodeNumber: 1,
      anilistId: 88822,
      anilistEpisode: 1,
    });

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Adult Anime Movie',
      LibraryName: 'Other Anime Movies',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Provider_tmdb: '999999',
    };

    await handleWebhook(payload, { debounceMs: 0 });

    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0]?.toString().includes('simkl.com'),
    );
    expect(simklCalls.length).toBe(0);

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0]?.toString().includes('graphql.anilist.co'),
    );
    const anilistMutationCall = anilistCalls.find((c: any) => {
      const b = JSON.parse(c[1]?.body ?? '{}');
      return b.query?.includes('SaveMediaListEntry');
    });
    expect(anilistMutationCall).toBeDefined();
    const mutationBody = JSON.parse(anilistMutationCall[1].body);
    expect(mutationBody.variables.private).toBe(true);
  });

  test('should completely exclude and skip webhook sync when LibraryName is in excluded_libraries', async () => {
    appConfig.jellyfin = {
      ...appConfig.jellyfin!,
      excluded_libraries: ['Excluded Shows'],
    };
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Episode 1',
      SeriesName: 'Excluded Series',
      LibraryName: 'Excluded Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '364395',
    };

    await handleWebhook(payload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('should route standard movie when Library is Movies', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Inception',
      Library: 'Movies',
      Year: 2010,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Provider_tmdb: '27205',
      Provider_imdb: 'tt1375666',
    };

    await handleWebhook(payload);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(1);

    expect(calls[0][0].toString()).toContain('api.simkl.com/sync/history');
    const simklBody = JSON.parse(calls[0][1].body);
    expect(simklBody.movies[0].title).toBe('Inception');
    expect(simklBody.movies[0].ids.tmdb).toBe('27205');
    expect(simklBody.movies[0].ids.imdb).toBe('tt1375666');
  });

  test('should query Jellyfin for library name and series metadata when missing in payload', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      SeriesId: 'series-jf-1',
      SeasonNumber: 1,
      EpisodeNumber: 2,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
    };

    await handleWebhook(payload);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    // 1 call for Ancestors (library name), 1 call for Series metadata, 1 call for Simkl
    expect(calls.length).toBe(3);

    expect(calls[0][0].toString()).toContain('/Ancestors');
    expect(calls[1][0].toString()).toContain('series-jf-1');
    expect(calls[2][0].toString()).toContain('api.simkl.com/sync/history');
    const simklBody = JSON.parse(calls[2][1].body);
    expect(simklBody.anime[0].ids.anilist).toBe('16498');
    expect(simklBody.anime[0].episodes[0].number).toBe(2);
  });

  test('should send ntfy notification if movie returns not_found', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Not Found Anime Movie',
      LibraryName: 'Anime Movies',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Provider_tmdb: '54321', // Triggers not_found in our mock
    };

    await handleWebhook(payload);

    // Yield execution for fetch promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(2);

    expect(calls[0][0].toString()).toContain('api.simkl.com/sync/history');
    expect(calls[1][0].toString()).toBe('http://ntfy-mock');

    const ntfyBody = JSON.parse(calls[1][1].body);
    expect(ntfyBody).toEqual({
      title: 'Failed to update Simkl for anime movie',
      message: 'Item: Not Found Anime Movie\nID: 54321\nLink: https://anilist.co/anime/54321',
      priority: 4,
      topic: 'mock-ntfy-topic',
    });
  });

  test('should fallback to standard pipeline if anime episode is NOT a special and has NO matching AniList mapping', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      SeriesName: 'Unmapped Anime',
      Name: 'Episode 1',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      LibraryName: 'Anime Shows',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '999999',
      Series_Provider_tmdb: '888888',
    };

    await handleWebhook(payload);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    const simklCalls = calls.filter((c: any) => c[0].toString().includes('api.simkl.com'));
    expect(simklCalls.length).toBe(1);

    const ntfyCalls = calls.filter((c: any) => c[0].toString().includes('http://ntfy-mock'));
    expect(ntfyCalls.length).toBe(1);
    expect(JSON.parse(ntfyCalls[0][1].body).title).toContain('Missing Anime Mapping');

    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.shows[0].title).toBe('Unmapped Anime');
    expect(simklBody.shows[0].ids.tvdb).toBe('999999');
    expect(simklBody.shows[0].ids.tmdb).toBe('888888');
    expect(simklBody.shows[0].seasons[0].number).toBe(1);
    expect(simklBody.shows[0].seasons[0].episodes[0].number).toBe(1);
  });

  test('should skip Simkl scrobble if anime episode is a special (S0) and has NO matching AniList mapping', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      SeriesName: 'Unmapped Anime',
      Name: 'Special 1',
      SeasonNumber: 0,
      EpisodeNumber: 1,
      LibraryName: 'Anime Shows',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '999999',
    };

    await handleWebhook(payload);

    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(0);

    const ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(1);
    expect(JSON.parse(ntfyCalls[0][1].body).title).toContain('Missing Anime Mapping');
  });

  test('should debounce and batch multiple rapid episode completions of a season into a single Simkl request', async () => {
    // Simulate user marking 5 episodes of Attack on Titan watched at once
    for (let ep = 1; ep <= 5; ep++) {
      handleWebhook(
        {
          NotificationUsername: 'test-user',
          ItemType: 'Episode',
          Name: `Episode ${ep}`,
          SeriesName: 'Attack on Titan',
          LibraryName: 'Anime Shows',
          SeasonNumber: 1,
          EpisodeNumber: ep,
          NotificationType: 'PlaybackStop',
          RunTimeTicks: 1000,
          PlaybackPositionTicks: 900,
          Series_Provider_tvdb: '267440',
        } as any,
        { debounceMs: 50 },
      );
    }

    // Immediately after, no Simkl fetch should have fired yet
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Wait 100ms for debounce timer to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Exactly 1 batch request sent to Simkl containing all 5 episodes!
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const calls = fetchMock.mock.calls;
    expect(calls[0][0].toString()).toContain('api.simkl.com/sync/history');

    const simklBody = JSON.parse(calls[0][1].body);
    expect(simklBody.anime.length).toBe(1);
    expect(simklBody.anime[0].ids.anilist).toBe('16498');
    expect(simklBody.anime[0].episodes.length).toBe(5);
    expect(simklBody.anime[0].episodes.map((e: any) => e.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test('should fallback to standard movie pipeline if anime movie has NO matching AniList mapping', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Voltage Fighter Gowcaizer',
      LibraryName: 'anime-movies',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Provider_tmdb: '94505',
      Provider_imdb: 'tt0204034',
      Provider_tvdb: '202176',
    };

    await handleWebhook(payload);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    const simklCalls = calls.filter((c: any) => c[0].toString().includes('api.simkl.com'));
    expect(simklCalls.length).toBe(1);

    const ntfyCalls = calls.filter((c: any) => c[0].toString().includes('http://ntfy-mock'));
    expect(ntfyCalls.length).toBe(1);
    expect(JSON.parse(ntfyCalls[0][1].body).title).toContain('Missing Anime Movie Mapping');

    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.movies).toBeDefined();
    expect(simklBody.movies.length).toBe(1);
    expect(simklBody.movies[0].title).toBe('Voltage Fighter Gowcaizer');
    expect(simklBody.movies[0].ids.tmdb).toBe('94505');
    expect(simklBody.movies[0].ids.imdb).toBe('tt0204034');
    expect(simklBody.movies[0].ids.tvdb).toBe('202176');
  });

  test('should handle multi-episode file (e.g. S01E01-E02) by batching all episodes in range', async () => {
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      SeriesName: 'Attack on Titan',
      Name: 'Episode 1 & 2',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      IndexNumberEnd: 2,
      LibraryName: 'Anime Shows',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(1);

    expect(calls[0][0].toString()).toContain('api.simkl.com/sync/history');
    const simklBody = JSON.parse(calls[0][1].body);
    expect(simklBody.anime.length).toBe(1);
    expect(simklBody.anime[0].ids.anilist).toBe('16498');
    expect(simklBody.anime[0].episodes.map((e: any) => e.number)).toEqual([1, 2]);
  });

  test('should scrobble anime episode to AniList when only AniList token is configured', async () => {
    appConfig.simkl.users = {};
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;

    // Simkl API should NOT have been called
    const simklCalls = calls.filter((c: any) => c[0].toString().includes('api.simkl.com'));
    expect(simklCalls.length).toBe(0);

    // AniList GraphQL should have been called (1 query + 1 mutation)
    const anilistCalls = calls.filter((c: any) => c[0].toString().includes('graphql.anilist.co'));
    expect(anilistCalls.length).toBe(2);

    // Verify GraphQL query for Media entry
    const queryCall = anilistCalls[0];
    expect(queryCall[1].headers.Authorization).toBe('Bearer mock-anilist-user-token');
    const queryBody = JSON.parse(queryCall[1].body);
    expect(queryBody.variables.mediaId).toBe(16498);

    // Verify GraphQL mutation for SaveMediaListEntry
    const mutationCall = anilistCalls[1];
    expect(mutationCall[1].headers.Authorization).toBe('Bearer mock-anilist-user-token');
    const mutationBody = JSON.parse(mutationCall[1].body);
    expect(mutationBody.variables.mediaId).toBe(16498);
    expect(mutationBody.variables.progress).toBe(1);
    expect(mutationBody.variables.status).toBe('CURRENT');
  });

  test('should scrobble to both Simkl and AniList when user has both tokens configured', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;

    // Both Simkl and AniList should be called
    const simklCalls = calls.filter((c: any) => c[0].toString().includes('api.simkl.com'));
    expect(simklCalls.length).toBe(1);
    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.anime[0].ids.anilist).toBe('16498');
    expect(simklBody.anime[0].episodes[0].number).toBe(1);

    const anilistCalls = calls.filter((c: any) => c[0].toString().includes('graphql.anilist.co'));
    expect(anilistCalls.length).toBe(2);
    const mutationCall = anilistCalls[1];
    const mutationBody = JSON.parse(mutationCall[1].body);
    expect(mutationBody.variables.mediaId).toBe(16498);
    expect(mutationBody.variables.progress).toBe(1);
  });

  test('should debounce and scrobble multi-episode file (S01E01-E02) to AniList with highest progress', async () => {
    appConfig.simkl.users = {};
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      SeriesName: 'Attack on Titan',
      Name: 'Episode 1 & 2',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      IndexNumberEnd: 2,
      LibraryName: 'Anime Shows',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    // Should query once and mutate once with progress: 2
    expect(anilistCalls.length).toBe(2);
    const mutationBody = JSON.parse(anilistCalls[1][1].body);
    expect(mutationBody.variables.mediaId).toBe(16498);
    expect(mutationBody.variables.progress).toBe(2);
  });

  test('should scrobble anime movie with COMPLETED status to AniList', async () => {
    appConfig.simkl.users = {};
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Test Anime Movie',
      LibraryName: 'Anime Movies',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Provider_tmdb: '12345',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(2);
    const mutationBody = JSON.parse(anilistCalls[1][1].body);
    expect(mutationBody.variables.mediaId).toBe(164);
    expect(mutationBody.variables.progress).toBe(1);
    expect(mutationBody.variables.status).toBe('COMPLETED');
  });

  test('should skip AniList when anime has no AniList mapping but still scrobble to Simkl', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    // TVDB 77777 has no AniList mapping
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Episode 1',
      SeriesName: 'Anime Without AniList',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '77777',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(1);
    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.shows[0].ids.tvdb).toBe('77777');

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(0);
  });

  test('should not scrobble standard non-anime media to AniList', async () => {
    appConfig.simkl.users = {};
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Pilot',
      SeriesName: 'Breaking Bad',
      LibraryName: 'TV Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      Year: 2008,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '81189',
      Series_Provider_tmdb: '1396',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(0);
  });

  test('should still attempt and execute AniList scrobble if Simkl fails with error', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    // Override fetchMock so Simkl responds with HTTP 500 error
    const baseFetch = fetchMock;
    fetchMock = mock((urlInput: string | URL, options?: any) => {
      const url = urlInput.toString();
      if (url.includes('api.simkl.com')) {
        return Promise.resolve(new Response('Simkl internal error', { status: 500 }));
      }
      return baseFetch(urlInput, options);
    });
    global.fetch = fetchMock;

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simkl was attempted
    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBeGreaterThan(0);

    // AniList mutation still successfully executed!
    const anilistMutationCalls = fetchMock.mock.calls.filter(
      (c: any) =>
        c[0].toString().includes('graphql.anilist.co') &&
        c[1]?.body?.includes('SaveMediaListEntry'),
    );
    expect(anilistMutationCalls.length).toBe(1);
    const body = JSON.parse(anilistMutationCalls[0][1].body);
    expect(body.variables.mediaId).toBe(16498);
    expect(body.variables.progress).toBe(1);
  });

  test('should still attempt and execute Simkl scrobble if AniList fails with error', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    // Override fetchMock so AniList responds with HTTP 500
    const baseFetch = fetchMock;
    fetchMock = mock((urlInput: string | URL, options?: any) => {
      const url = urlInput.toString();
      if (url.includes('graphql.anilist.co')) {
        return Promise.resolve(new Response('AniList service error', { status: 500 }));
      }
      return baseFetch(urlInput, options);
    });
    global.fetch = fetchMock;

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // AniList was attempted
    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBeGreaterThan(0);

    // Simkl was successfully called!
    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(1);
    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.anime[0].ids.anilist).toBe('16498');
  });

  test('should fall back to standard TVDB episode scrobble for Simkl when anime has no AniList mapping, while AniList is skipped', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    // TVDB override where anilistId is null
    const tvdbOverrides = TvdbOverridesIndex.parse({
      '88888': {
        title: 'Anime Without AniList',
        seasons: {
          '1': {
            episodes: {
              '1': {
                name: 'Fallback Episode 1',
                anilistId: null,
              },
            },
          },
        },
      },
    });
    defaultAnimeResolver.setIndices(null, null, null, tvdbOverrides);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Fallback Episode 1',
      SeriesName: 'Anime Without AniList',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '88888',
      Series_Provider_tmdb: '55555',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simkl receives standard TV show scrobble with TVDB ID
    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(1);
    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.shows[0].ids.tvdb).toBe('88888');

    // AniList has no mapping, so should not be called
    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(0);
  });

  test('should fall back to standard movie pipeline for Simkl when anime movie has no AniList mapping', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    defaultAnimeResolver.setIndices(null, null, null, null);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Unmapped Anime Movie',
      LibraryName: 'Anime Movies',
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Provider_tmdb: '998877',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simkl receives standard movie scrobble with TMDB ID
    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(1);
    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.movies[0].ids.tmdb).toBe('998877');

    // AniList has no mapping, so should not be called
    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(0);
  });

  test('should send ntfy notification and automatically add anime to mapping overrides when missing mappings', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = { users: { 'test-user': 'mock-anilist-user-token' } };

    const tvdbId = '776655';
    // Ensure show is not in overrides index initially
    expect(defaultAnimeResolver.hasTvdbShow(tvdbId)).toBe(false);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Episode 1',
      SeriesName: 'Unmapped Catch Anime',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: tvdbId,
      Series_Provider_tmdb: '112233',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Ntfy notification was sent
    const ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(1);
    const ntfyBody = JSON.parse(ntfyCalls[0][1].body);
    expect(ntfyBody.title).toBe('Missing Anime Mapping: Unmapped Catch Anime');
    expect(ntfyBody.message).toContain('Show: Unmapped Catch Anime');
    expect(ntfyBody.message).toContain('Episode: S1E1');
    expect(ntfyBody.message).toContain('TVDB: 776655');
    expect(ntfyBody.message).toContain('Missing: AniList');
    expect(ntfyBody.message).toContain('Added to mapping-overrides.json');

    // And show was automatically added to resolver overrides!
    expect(defaultAnimeResolver.hasTvdbShow(tvdbId)).toBe(true);
  });

  test('should respect notification cooldown and avoid sending duplicate notifications for the same show', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = { users: { 'test-user': 'mock-anilist-user-token' } };

    const payloadEp1: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Episode 1',
      SeriesName: 'Cooldown Anime',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '887766',
    };

    const payloadEp2: any = {
      ...payloadEp1,
      Name: 'Episode 2',
      EpisodeNumber: 2,
    };

    // First episode sends notification
    await handleWebhook(payloadEp1, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    let ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(1);

    // Second episode within cooldown does NOT send another notification
    await handleWebhook(payloadEp2, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(1);

    // Clearing cooldown allows notification again
    clearNotificationCooldowns();
    await handleWebhook(payloadEp2, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(2);
  });

  test('should trigger ntfy notification and add anime to mapping overrides on PlaybackStart without scrobbling', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = { users: { 'test-user': 'mock-anilist-user-token' } };

    const tvdbId = '665544';
    expect(defaultAnimeResolver.hasTvdbShow(tvdbId)).toBe(false);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Episode 1',
      SeriesName: 'Unmapped PlaybackStart Anime',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStart',
      RunTimeTicks: 10000000,
      PlaybackPositionTicks: 0,
      Series_Provider_tvdb: tvdbId,
    };

    await handleWebhook(payload);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Ntfy notification was sent
    const ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(1);
    const ntfyBody = JSON.parse(ntfyCalls[0][1].body);
    expect(ntfyBody.title).toBe('Missing Anime Mapping: Unmapped PlaybackStart Anime');
    expect(ntfyBody.message).toContain('Show: Unmapped PlaybackStart Anime');
    expect(ntfyBody.message).toContain('TVDB: 665544');
    expect(ntfyBody.message).toContain('Added to mapping-overrides.json');

    // Show added to resolver overrides
    expect(defaultAnimeResolver.hasTvdbShow(tvdbId)).toBe(true);

    // Absolutely NO scrobble requests were sent to Simkl or AniList
    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(0);

    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(0);
  });

  test('should trigger ntfy notification and add anime movie to mapping overrides on PlaybackStart without scrobbling', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = { users: { 'test-user': 'mock-anilist-user-token' } };

    const tvdbId = '554433';
    expect(defaultAnimeResolver.hasTvdbShow(tvdbId)).toBe(false);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Movie',
      Name: 'Unmapped PlaybackStart Movie',
      LibraryName: 'Anime Movies',
      NotificationType: 'PlaybackStart',
      RunTimeTicks: 10000000,
      PlaybackPositionTicks: 0,
      Provider_tvdb: tvdbId,
      Provider_tmdb: '332211',
    };

    await handleWebhook(payload);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(1);
    const ntfyBody = JSON.parse(ntfyCalls[0][1].body);
    expect(ntfyBody.title).toBe('Missing Anime Movie Mapping: Unmapped PlaybackStart Movie');
    expect(ntfyBody.message).toContain('Movie: Unmapped PlaybackStart Movie');
    expect(ntfyBody.message).toContain('TVDB: 554433');
    expect(ntfyBody.message).toContain('Added to mapping-overrides.json');

    expect(defaultAnimeResolver.hasTvdbShow(tvdbId)).toBe(true);

    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(0);
  });

  test('should not trigger ntfy notification on PlaybackStart if anime is already mapped', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = { users: { 'test-user': 'mock-anilist-user-token' } };

    // TVDB 267440 is Attack on Titan which is mapped in testAniBridge
    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'To You, in 2000 Years',
      SeriesName: 'Attack on Titan',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStart',
      RunTimeTicks: 10000000,
      PlaybackPositionTicks: 0,
      Series_Provider_tvdb: '267440',
    };

    await handleWebhook(payload);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('should scrobble to Simkl using TVDB ID and skip AniList when episode has skipAniList: true in overrides without sending ntfy', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = {
      users: { 'test-user': 'mock-anilist-user-token' },
    };

    const tvdbOverrides = TvdbOverridesIndex.parse({
      '444333': {
        title: 'Special Anime OVA',
        seasons: {
          '1': {
            episodes: {
              '1': {
                name: 'Unmapped Anime Ep',
                skipAniList: true,
              },
            },
          },
        },
      },
    });
    defaultAnimeResolver.setIndices(null, null, null, tvdbOverrides);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Unmapped Anime Ep',
      SeriesName: 'Special Anime OVA',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStop',
      RunTimeTicks: 1000,
      PlaybackPositionTicks: 900,
      Series_Provider_tvdb: '444333',
    };

    await handleWebhook(payload, { debounceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simkl receives standard TV show scrobble with TVDB ID (Season 1)
    const simklCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('api.simkl.com'),
    );
    expect(simklCalls.length).toBe(1);
    const simklBody = JSON.parse(simklCalls[0][1].body);
    expect(simklBody.shows[0].ids.tvdb).toBe('444333');
    expect(simklBody.shows[0].seasons[0].number).toBe(1);
    expect(simklBody.shows[0].seasons[0].episodes[0].number).toBe(1);

    // AniList is skipped
    const anilistCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('graphql.anilist.co'),
    );
    expect(anilistCalls.length).toBe(0);

    // No ntfy missing mapping notification should be sent
    const ntfyCalls = fetchMock.mock.calls.filter((c: any) =>
      c[0].toString().includes('http://ntfy-mock'),
    );
    expect(ntfyCalls.length).toBe(0);
  });

  test('should not send ntfy notification on PlaybackStart if episode has skipAniList: true in overrides', async () => {
    appConfig.simkl.users = { 'test-user': 'mock-simkl-user-token' };
    appConfig.anilist = { users: { 'test-user': 'mock-anilist-user-token' } };

    const tvdbOverrides = TvdbOverridesIndex.parse({
      '444333': {
        title: 'Special Anime OVA',
        seasons: {
          '0': {
            episodes: {
              '1': {
                name: 'Unmapped Special OVA',
                skipAniList: true,
              },
            },
          },
        },
      },
    });
    defaultAnimeResolver.setIndices(null, null, null, tvdbOverrides);

    const payload: any = {
      NotificationUsername: 'test-user',
      ItemType: 'Episode',
      Name: 'Unmapped Special OVA',
      SeriesName: 'Special Anime OVA',
      LibraryName: 'Anime Shows',
      SeasonNumber: 0,
      EpisodeNumber: 1,
      NotificationType: 'PlaybackStart',
      RunTimeTicks: 10000000,
      PlaybackPositionTicks: 0,
      Series_Provider_tvdb: '444333',
    };

    await handleWebhook(payload);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('Continuous Sync (ItemAdded Webhooks)', () => {
    test('should queue and sync series when ItemAdded received for an episode in Anime library without requiring user token', async () => {
      const syncMock = mock(async (tvdbId: string, _options?: any) => ({
        tvdbId,
        title: 'Frieren: Beyond Journey’s End',
        deleted: false,
        totalEpisodes: 28,
        prunedOverridesCount: 0,
      }));
      setSeriesSyncRunner(syncMock);

      const payload: any = {
        NotificationType: 'ItemAdded',
        ItemType: 'Episode',
        Name: 'The Journey Begins',
        SeriesName: 'Frieren: Beyond Journey’s End',
        SeriesId: 'jf-series-guid-1',
        LibraryName: 'Anime Shows',
        Series_Provider_tvdb: '439265',
      };

      // Notice: No user token or username is configured in this payload
      await handleWebhook(payload, { debounceMs: 10 });
      expect(getPendingSeriesSyncCount()).toBe(1);

      await flushAllPendingSeriesSync();
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(syncMock.mock.calls[0]![0]).toBe('439265');
      expect(syncMock.mock.calls[0]![1]?.jellyfinSeriesId).toBe('jf-series-guid-1');
    });

    test('should queue and sync movie when ItemAdded received for an anime movie in Anime Movies library', async () => {
      const syncMock = mock(async (tvdbId: string, _options?: any) => ({
        tvdbId,
        title: 'Spirited Away',
        deleted: false,
        totalEpisodes: 1,
        prunedOverridesCount: 0,
      }));
      setSeriesSyncRunner(syncMock);

      const payload: any = {
        NotificationType: 'ItemAdded',
        ItemType: 'Movie',
        Name: 'Spirited Away',
        ItemId: 'jf-movie-guid-1',
        LibraryName: 'Anime Movies',
        Provider_tvdb: '276',
      };

      await handleWebhook(payload, { debounceMs: 10 });
      expect(getPendingSeriesSyncCount()).toBe(1);

      await flushAllPendingSeriesSync();
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(syncMock.mock.calls[0]![0]).toBe('276');
      expect(syncMock.mock.calls[0]![1]?.jellyfinSeriesId).toBe('jf-movie-guid-1');
    });

    test('should ignore ItemAdded for items in explicitly excluded libraries', async () => {
      appConfig.jellyfin = {
        ...appConfig.jellyfin!,
        excluded_libraries: ['Excluded Anime'],
      };
      const syncMock = mock(async () => ({}));
      setSeriesSyncRunner(syncMock as any);

      await handleWebhook({
        NotificationType: 'ItemAdded',
        ItemType: 'Episode',
        Name: 'Side Episode',
        SeriesName: 'Other Anime Show',
        LibraryName: 'Excluded Anime',
        Series_Provider_tvdb: '99999',
      });
      expect(getPendingSeriesSyncCount()).toBe(0);
      expect(syncMock).not.toHaveBeenCalled();
    });

    test('should ignore ItemAdded for non-anime items in standard libraries (e.g. TV Shows)', async () => {
      const syncMock = mock(async () => ({}));
      setSeriesSyncRunner(syncMock as any);

      await handleWebhook({
        NotificationType: 'ItemAdded',
        ItemType: 'Episode',
        Name: 'Pilot',
        SeriesName: 'Breaking Bad',
        LibraryName: 'TV Shows',
        Series_Provider_tvdb: '81189',
      });

      expect(getPendingSeriesSyncCount()).toBe(0);
      expect(syncMock).not.toHaveBeenCalled();
    });

    test('should ignore ItemAdded for Season items to avoid corrupt sync with 0 episodes', async () => {
      const syncMock = mock(async () => ({}));
      setSeriesSyncRunner(syncMock as any);

      await handleWebhook({
        NotificationType: 'ItemAdded',
        ItemType: 'Season',
        Name: 'Season 1',
        SeriesName: 'Chainsaw Man',
        SeriesId: 'jf-series-guid',
        ItemId: 'jf-season-guid',
        LibraryName: 'Anime Shows',
        Provider_tvdb: '2229470',
        Series_Provider_tvdb: '393199',
      });

      expect(getPendingSeriesSyncCount()).toBe(0);
      expect(syncMock).not.toHaveBeenCalled();
    });
  });
});
