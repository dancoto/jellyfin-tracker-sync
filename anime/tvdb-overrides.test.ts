import { describe, expect, test } from 'bun:test';
import { AnimeResolver } from './resolver';
import { TvdbOverridesIndex, type RawTvdbOverrides } from './tvdb-overrides';

describe('TVDB Overrides Index & Resolver Integration', () => {
  const sampleOverridesData = {
    '70861': {
      title: 'Love Hina',
      seasons: {
        '1': {
          episodes: {
            '25': {
              name: 'Final Special',
              anilistId: null, // null means unmapped/missing AniList
            },
            '26': {
              name: 'Christmas Special',
              anilistId: 444, // valid AniList ID
              anilistEpisode: 1,
            },
          },
        },
      },
    },
    '72172': {
      title: 'MegaMan: NT Warrior',
      seasons: {
        '1': {
          episodes: {
            '1': {
              name: 'Jack In! MegaMan!',
              skip: true,
            },
          },
        },
        '2': {
          // Season level 1:1 shorthand
          anilistId: 3000,
        },
      },
    },
    '99999': {
      title: 'Contiguous OVA',
      seasons: {
        '0': {
          episodes: {
            '1-3': {
              name: 'OVA Trilogy',
              anilistId: 9999,
            },
          },
        },
      },
    },
  };

  test('should leave anilist undefined when anilistId is null (unmapped)', () => {
    const tvdbOverrides = TvdbOverridesIndex.parse(sampleOverridesData);
    const resolver = new AnimeResolver();
    resolver.setIndices(null, null, null, tvdbOverrides);

    const result = resolver.resolveEpisode({ tvdbId: '70861' }, 1, 25);
    expect(result).not.toBeNull();
    expect(result?.episodeNumber).toBe(25);
    expect(result?.isSkipped).toBeFalsy();
    expect(result?.skipAniList).toBe(false);
    expect(result?.anilist).toBeUndefined();
  });

  test('should resolve skipAniList: true with isSkipped falsy for TVDB fallback', () => {
    const customData = {
      '55555': {
        title: 'Special Show',
        seasons: {
          '0': {
            episodes: {
              '1': {
                name: 'Special with No AniList entry',
                skipAniList: true,
              },
            },
          },
        },
      },
    };
    const tvdbOverrides = TvdbOverridesIndex.parse(customData);
    const epOverride = tvdbOverrides.getEpisodeOverride('55555', 0, 1);
    expect(epOverride).toEqual({
      skip: false,
      skipAniList: true,
      isExplicitNull: false,
      anilistId: undefined,
      anilistEpisode: undefined,
      isSpecial: true,
    });

    const resolver = new AnimeResolver();
    resolver.setIndices(null, null, null, tvdbOverrides);
    const result = resolver.resolveEpisode({ tvdbId: '55555' }, 0, 1);
    expect(result).not.toBeNull();
    expect(result?.isSkipped).toBeFalsy();
    expect(result?.skipAniList).toBe(true);
    expect(result?.anilist).toBeUndefined();
  });

  test('should map AniList when valid ID is provided', () => {
    const tvdbOverrides = TvdbOverridesIndex.parse(sampleOverridesData);
    const resolver = new AnimeResolver();
    resolver.setIndices(null, null, null, tvdbOverrides);

    const result = resolver.resolveEpisode({ tvdbId: '70861' }, 1, 26);
    expect(result).not.toBeNull();
    expect(result?.anilist).toEqual({ mediaId: 444, episodeNumber: 1 });
  });

  test('should mark isSkipped when skip is true', () => {
    const tvdbOverrides = TvdbOverridesIndex.parse(sampleOverridesData);
    const resolver = new AnimeResolver();
    resolver.setIndices(null, null, null, tvdbOverrides);

    const result = resolver.resolveEpisode({ tvdbId: '72172' }, 1, 1);
    expect(result).not.toBeNull();
    expect(result?.isSkipped).toBe(true);
    expect(result?.skipAniList).toBe(true);
  });

  test('should resolve season-level 1:1 default mapping', () => {
    const tvdbOverrides = TvdbOverridesIndex.parse(sampleOverridesData);
    const resolver = new AnimeResolver();
    resolver.setIndices(null, null, null, tvdbOverrides);

    const result = resolver.resolveEpisode({ tvdbId: '72172' }, 2, 5);
    expect(result).not.toBeNull();
    expect(result?.episodeNumber).toBe(5);
    expect(result?.anilist).toEqual({ mediaId: 3000, episodeNumber: 5 });
  });

  test('should expand episode range like 1-3', () => {
    const tvdbOverrides = TvdbOverridesIndex.parse(sampleOverridesData);
    const resolver = new AnimeResolver();
    resolver.setIndices(null, null, null, tvdbOverrides);

    const ep2 = resolver.resolveEpisode({ tvdbId: '99999' }, 0, 2);
    expect(ep2).not.toBeNull();
    expect(ep2?.anilist?.mediaId).toBe(9999);
    expect(ep2?.anilist?.episodeNumber).toBe(2);

    // Episode 4 is not in the 1-3 range
    const ep4 = resolver.resolveEpisode({ tvdbId: '99999' }, 0, 4);
    expect(ep4).toBeNull();
  });

  test('ensureShowInOverrides should add a new show and episodes to overrides file', () => {
    const tempPath = `/tmp/test-overrides-${Date.now()}.json`;

    try {
      // 1. Add new show
      const res1 = TvdbOverridesIndex.ensureShowInOverrides(
        {
          tvdbId: '112233',
          title: 'Brand New Anime',
          tmdbId: '9988',
          seasonNumber: 1,
          episodeNumber: 1,
          episodeName: 'Episode 1',
        },
        tempPath,
      );
      expect(res1.added).toBe(true);
      expect(res1.reason).toBe('show_added');

      // 2. Add second episode to same show
      const res2 = TvdbOverridesIndex.ensureShowInOverrides(
        {
          tvdbId: '112233',
          title: 'Brand New Anime',
          seasonNumber: 1,
          episodeNumber: 2,
          episodeName: 'Episode 2',
        },
        tempPath,
      );
      expect(res2.added).toBe(true);
      expect(res2.reason).toBe('episode_added');

      // 3. Duplicate check - should not overwrite
      const res3 = TvdbOverridesIndex.ensureShowInOverrides(
        {
          tvdbId: '112233',
          title: 'Brand New Anime',
          seasonNumber: 1,
          episodeNumber: 1,
        },
        tempPath,
      );
      expect(res3.added).toBe(false);
      expect(res3.reason).toBe('already_exists');

      // 4. Verify loaded file
      const loaded = TvdbOverridesIndex.load(tempPath);
      expect(loaded).not.toBeNull();
      expect(loaded?.hasShow('112233')).toBe(true);
      expect(loaded?.hasShow('999999')).toBe(false);

      const ep1 = loaded?.getEpisodeOverride('112233', 1, 1);
      expect(ep1).not.toBeNull();
      expect(ep1?.skipAniList).toBe(false);
      expect(ep1?.anilistId).toBeUndefined();

      const ep2 = loaded?.getEpisodeOverride('112233', 1, 2);
      expect(ep2).not.toBeNull();
    } finally {
      const { unlinkSync, existsSync } = require('node:fs');
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  });

  test('should support fallback candidate keys like tmdb- and jf- in hasShow and getEpisodeOverride', () => {
    const rawOverrides: RawTvdbOverrides = {
      'jf-series-xyz': {
        title: 'Jellyfin Only Private Show',
        seasons: {
          '1': {
            episodes: {
              '1': {
                anilistId: 998877,
                anilistEpisode: 1,
              },
            },
          },
        },
      },
    };

    const index = TvdbOverridesIndex.parse(rawOverrides);
    expect(index.hasShow('jf-series-xyz')).toBe(true);
    expect(index.hasShow(['unknown-tvdb', 'tmdb-12345', 'jf-series-xyz'])).toBe(true);
    expect(index.hasShow(['unknown-tvdb', 'tmdb-12345'])).toBe(false);

    const override = index.getEpisodeOverride(
      ['unknown-tvdb', 'tmdb-12345', 'jf-series-xyz'],
      1,
      1,
    );
    expect(override).not.toBeNull();
    expect(override?.anilistId).toBe(998877);
    expect(override?.anilistEpisode).toBe(1);
  });
});
