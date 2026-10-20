import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { appConfig } from '../shared/config';
import { buildSyncPayload, enqueueScrobble, sendSyncPayload } from './batcher';

describe('Simkl Scrobble Batcher & Debouncer', () => {
  let originalConfig: any;
  let fetchMock: any;

  beforeEach(() => {
    originalConfig = JSON.parse(JSON.stringify(appConfig));
    appConfig.simkl.client_id = 'test-client-id';
    appConfig.simkl.app_name = 'test-app';

    fetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            added: { movies: 1, shows: 1, episodes: 12, statuses: [] },
            not_found: { movies: [], shows: [], episodes: [] },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    Object.assign(appConfig, originalConfig);
    mock.restore();
  });

  test('buildSyncPayload should group 12 episodes of the same anime season using TVDB fallback into 1 show entry', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      kind: 'anime_episode' as const,
      tvdbId: '267440',
      episodeNumber: i + 1,
      isSpecial: false,
      seriesName: 'Attack on Titan',
      episodeName: `Episode ${i + 1}`,
    }));

    const { payload } = buildSyncPayload(items);

    expect(payload.movies).toBeUndefined();
    expect(payload.shows).toBeDefined();
    expect(payload.shows?.length).toBe(1);

    const show = payload.shows![0]!;
    expect(show.ids.tvdb).toBe('267440');
    expect(show.seasons.length).toBe(1);
    expect(show.seasons[0]!.number).toBe(1);
    expect(show.seasons[0]!.episodes.length).toBe(12);
    expect(show.seasons[0]!.episodes.map((e) => e.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  test('buildSyncPayload should group standard TV show episodes and movies together', () => {
    const items: any[] = [
      {
        kind: 'standard_episode',
        seriesName: 'Breaking Bad',
        seasonNumber: 1,
        episodeNumber: 1,
        ids: { tvdb: '81189' },
        episodeName: 'Pilot',
      },
      {
        kind: 'standard_episode',
        seriesName: 'Breaking Bad',
        seasonNumber: 1,
        episodeNumber: 2,
        ids: { tvdb: '81189' },
        episodeName: 'Cat in the Bag...',
      },
      {
        kind: 'standard_movie',
        name: 'Inception',
        ids: { tmdb: '27205' },
      },
    ];

    const { payload } = buildSyncPayload(items);

    expect(payload.shows?.length).toBe(1);
    expect(payload.shows![0]!.ids.tvdb).toBe('81189');
    expect(payload.shows![0]!.seasons[0]!.episodes.length).toBe(2);

    expect(payload.movies?.length).toBe(1);
    expect(payload.movies![0]!.title).toBe('Inception');
    expect(payload.movies![0]!.ids.tmdb).toBe('27205');
  });

  test('enqueueScrobble should debounce multiple rapid calls into 1 single POST request', async () => {
    const username = 'binge-user';
    const token = 'token-123';

    // Send 10 rapid episodes with 50ms debounce
    for (let i = 1; i <= 10; i++) {
      enqueueScrobble(
        username,
        token,
        {
          kind: 'anime_episode',
          tvdbId: '267440',
          episodeNumber: i,
          isSpecial: false,
        },
        { debounceMs: 50 },
      );
    }

    // Immediately after queueing, fetch should not have fired yet
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Wait 100ms for debounce timer to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Exactly 1 request should have been made for all 10 episodes!
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toContain('api.simkl.com/sync/history');

    const sentBody = JSON.parse(options.body);
    expect(sentBody.shows.length).toBe(1);
    expect(sentBody.shows[0].seasons[0].episodes.length).toBe(10);
  });

  test('sendSyncPayload should retry when Simkl returns 400 RATE_LIMIT and succeed', async () => {
    let callCount = 0;
    fetchMock = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'RATE_LIMIT', message: 'Rate limit' }), {
            status: 400,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            added: { movies: 0, shows: 1, episodes: 1, statuses: [] },
            not_found: { movies: [], shows: [], episodes: [] },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await sendSyncPayload(
      { shows: [{ ids: { tvdb: '123' }, seasons: [{ number: 1, episodes: [{ number: 1 }] }] }] },
      'test-token',
      new Map(),
      3,
    );

    expect(result.success).toBe(true);
    expect(result.addedCount).toBe(2);
    expect(callCount).toBe(2);
  });

  test('buildSyncPayload should route anime with anilistId to payload.anime with flat episodes', () => {
    const items = [
      {
        kind: 'anime_episode' as const,
        anilistId: 7740,
        anilistEpisode: 2,
        episodeNumber: 2,
        seasonNumber: 1,
        isSpecial: false,
        seriesName: "Queen's Blade 2",
        episodeName: 'Episode 2',
        tvdbId: '87491',
      },
    ];

    const { payload, notFoundMap } = buildSyncPayload(items);

    expect(payload.anime).toBeDefined();
    expect(payload.anime?.length).toBe(1);
    expect(payload.shows).toBeUndefined();

    const animeEntry = payload.anime![0]!;
    expect(animeEntry.ids.anilist).toBe('7740');
    expect(animeEntry.ids.tvdb).toBe('87491');
    expect(animeEntry.episodes).toEqual([{ number: 2 }]);

    const meta = notFoundMap.get('7740');
    expect(meta).toBeDefined();
    expect(meta?.isSpecial).toBe(false);
    expect(meta?.isAnime).toBe(true);
  });

  test('buildSyncPayload should exclude anime specials (isSpecial: true or seasonNumber: 0) from Simkl payload', () => {
    const items = [
      {
        kind: 'anime_episode' as const,
        anilistId: 7740,
        anilistEpisode: 1,
        episodeNumber: 1,
        seasonNumber: 0,
        isSpecial: true,
        seriesName: "Queen's Blade Specials",
        episodeName: 'Special 1',
        tvdbId: '87491',
      },
    ];

    const { payload, notFoundMap } = buildSyncPayload(items);

    expect(payload.anime).toBeUndefined();
    expect(payload.shows).toBeUndefined();
    expect(notFoundMap.size).toBe(0);
  });

  test('buildSyncPayload should route anime without anilistId to payload.shows (TVDB fallback)', () => {
    const items = [
      {
        kind: 'anime_episode' as const,
        episodeNumber: 5,
        seasonNumber: 1,
        isSpecial: false,
        seriesName: 'Some Anime',
        episodeName: 'Episode 5',
        tvdbId: '12345',
      },
    ];

    const { payload, notFoundMap } = buildSyncPayload(items);

    expect(payload.anime).toBeUndefined();
    expect(payload.shows).toBeDefined();
    expect(payload.shows?.length).toBe(1);

    const showEntry = payload.shows![0]!;
    expect(showEntry.ids.tvdb).toBe('12345');
    expect(showEntry.seasons[0]!.number).toBe(1);
    expect(showEntry.seasons[0]!.episodes).toEqual([{ number: 5 }]);

    const meta = notFoundMap.get('12345');
    expect(meta).toBeDefined();
    expect(meta?.isSpecial).toBe(false);
  });

  test('sendSyncPayload should suppress ntfy for not_found specials, but notify for regular episodes', async () => {
    appConfig.ntfy = { url: 'http://ntfy.test', token: 'test-token', topic: 'test' };
    const ntfyCalls: string[] = [];

    fetchMock = mock((url: string | URL) => {
      const u = url.toString();
      if (u.includes('api.simkl.com')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              added: { movies: 0, shows: 0, episodes: 0 },
              not_found: {
                shows: [{ ids: { anilist: '7740' }, title: 'Special Show' }],
                episodes: [{ ids: { anilist: '9999' }, title: 'Regular Show' }],
              },
            }),
          ),
        );
      }
      if (u.includes('ntfy.test')) {
        ntfyCalls.push(u);
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return Promise.resolve(new Response('ok'));
    });
    global.fetch = fetchMock as any;

    const notFoundMap = new Map();
    notFoundMap.set('7740', {
      id: '7740',
      title: 'Queen Blade Special',
      link: 'https://anilist.co/anime/7740',
      mediaType: 'anime special',
      isAnime: true,
      isSpecial: true,
    });
    notFoundMap.set('9999', {
      id: '9999',
      title: 'Regular Anime Ep 1',
      link: 'https://anilist.co/anime/9999',
      mediaType: 'anime series',
      isAnime: true,
      isSpecial: false,
    });

    await sendSyncPayload(
      {
        anime: [
          { ids: { anilist: '7740' }, episodes: [{ number: 1 }] },
          { ids: { anilist: '9999' }, episodes: [{ number: 1 }] },
        ],
      },
      'test-token',
      notFoundMap,
    );

    // Only the regular episode (9999) should trigger an ntfy call, NOT the special (7740)!
    expect(ntfyCalls.length).toBe(1);
  });
});
