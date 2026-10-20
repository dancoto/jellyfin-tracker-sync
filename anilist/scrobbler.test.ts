import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  enqueueAniListScrobble,
  fetchAniListMediaEntry,
  mutateAniListMediaEntry,
  scrobbleToAniList,
} from './scrobbler';

describe('AniList Scrobbler', () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              Media: {
                id: 16498,
                episodes: 25,
                title: { english: 'Attack on Titan' },
                mediaListEntry: {
                  id: 101,
                  status: 'CURRENT',
                  progress: 4,
                },
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    mock.restore();
  });

  test('fetchAniListMediaEntry should return media details and list entry', async () => {
    const media = await fetchAniListMediaEntry(16498, 'mock-token');
    expect(media).not.toBeNull();
    expect(media?.id).toBe(16498);
    expect(media?.episodes).toBe(25);
    expect(media?.mediaListEntry?.progress).toBe(4);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe('https://graphql.anilist.co');
    expect(options.headers.Authorization).toBe('Bearer mock-token');
  });

  test('mutateAniListMediaEntry should execute SaveMediaListEntry mutation', async () => {
    fetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              SaveMediaListEntry: {
                id: 101,
                mediaId: 16498,
                status: 'CURRENT',
                progress: 5,
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await mutateAniListMediaEntry(16498, 5, 'CURRENT', 'mock-token');
    expect(result).not.toBeNull();
    expect(result?.mediaId).toBe(16498);
    expect(result?.progress).toBe(5);
    expect(result?.status).toBe('CURRENT');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.mediaId).toBe(16498);
    expect(body.variables.progress).toBe(5);
    expect(body.variables.status).toBe('CURRENT');
    expect(body.variables.private).toBeUndefined();
  });

  test('mutateAniListMediaEntry should pass private: true when isPrivate is true', async () => {
    fetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              SaveMediaListEntry: {
                id: 102,
                mediaId: 16498,
                status: 'CURRENT',
                progress: 1,
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await mutateAniListMediaEntry(16498, 1, 'CURRENT', 'mock-token', true);
    expect(result).not.toBeNull();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.private).toBe(true);
    expect(body.query).toContain('$private: Boolean');
    expect(body.query).toContain('private: $private');
  });

  test('scrobbleToAniList should advance progress and update status', async () => {
    let callCount = 0;
    fetchMock = mock(() => {
      callCount++;
      if (callCount === 1) {
        // Query Media
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 16498,
                  episodes: 25,
                  title: { english: 'Attack on Titan' },
                  mediaListEntry: { progress: 4, status: 'CURRENT' },
                },
              },
            }),
          ),
        );
      }
      // Mutation
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              SaveMediaListEntry: {
                id: 101,
                mediaId: 16498,
                progress: 5,
                status: 'CURRENT',
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await scrobbleToAniList('mock-token', 'testuser', {
      mediaId: 16498,
      episodeNumber: 5,
    });

    expect(result.success).toBe(true);
    expect(result.progress).toBe(5);
    expect(result.status).toBe('CURRENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('scrobbleToAniList should set COMPLETED when final episode is watched', async () => {
    let callCount = 0;
    fetchMock = mock(() => {
      callCount++;
      if (callCount === 1) {
        // Query Media
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 16498,
                  episodes: 25,
                  title: { english: 'Attack on Titan' },
                  mediaListEntry: { progress: 24, status: 'CURRENT' },
                },
              },
            }),
          ),
        );
      }
      // Mutation
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              SaveMediaListEntry: {
                id: 101,
                mediaId: 16498,
                progress: 25,
                status: 'COMPLETED',
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await scrobbleToAniList('mock-token', 'testuser', {
      mediaId: 16498,
      episodeNumber: 25,
    });

    expect(result.success).toBe(true);
    expect(result.progress).toBe(25);
    expect(result.status).toBe('COMPLETED');

    const mutationBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(mutationBody.variables.status).toBe('COMPLETED');
  });

  test('scrobbleToAniList should set progress 1 and COMPLETED for movies', async () => {
    let callCount = 0;
    fetchMock = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 164,
                  episodes: 1,
                  title: { english: 'Princess Mononoke' },
                  mediaListEntry: null,
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
              SaveMediaListEntry: {
                id: 202,
                mediaId: 164,
                progress: 1,
                status: 'COMPLETED',
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await scrobbleToAniList('mock-token', 'testuser', {
      mediaId: 164,
      episodeNumber: 1,
      isMovie: true,
      title: 'Princess Mononoke',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(result.progress).toBe(1);

    const mutationBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(mutationBody.variables.status).toBe('COMPLETED');
    expect(mutationBody.variables.progress).toBe(1);
  });

  test('scrobbleToAniList should skip mutation if current progress is already greater or equal', async () => {
    fetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              Media: {
                id: 16498,
                episodes: 25,
                mediaListEntry: { progress: 10, status: 'CURRENT' },
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    const result = await scrobbleToAniList('mock-token', 'testuser', {
      mediaId: 16498,
      episodeNumber: 5,
    });

    expect(result.success).toBe(true);
    expect(result.progress).toBe(10);
    // Only queried media, did not call mutation
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('enqueueAniListScrobble should debounce multiple rapid episodes and send highest progress', async () => {
    let mutationProgress = 0;
    fetchMock = mock((url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 16498,
                  episodes: 25,
                  mediaListEntry: { progress: 0, status: 'PLANNING' },
                },
              },
            }),
          ),
        );
      }
      mutationProgress = body.variables.progress;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              SaveMediaListEntry: {
                id: 101,
                mediaId: 16498,
                progress: body.variables.progress,
                status: 'CURRENT',
              },
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock as any;

    // Enqueue 3 episodes rapidly
    await enqueueAniListScrobble('testuser', 'mock-token', { mediaId: 16498, episodeNumber: 1 });
    await enqueueAniListScrobble('testuser', 'mock-token', { mediaId: 16498, episodeNumber: 2 });
    await enqueueAniListScrobble('testuser', 'mock-token', { mediaId: 16498, episodeNumber: 3 });

    // Wait 120ms for debounce
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mutationProgress).toBe(3);
    // 1 query, 1 mutation
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
