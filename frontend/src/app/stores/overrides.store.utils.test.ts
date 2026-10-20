import { describe, expect, it } from 'bun:test';
import {
  applyBatchSeasonOverride,
  applyEpisodeUpdate,
  applyOfficialEpisode,
  applyOfficialSeasonOverride,
  calculateFilterCounts,
  calculateStatsSummary,
  clearEpisodeOverride,
  countMissingInShow,
  countOverriddenInShow,
  countSkippedInShow,
  filterAndSortShows,
  getOfficialEp,
  getOverrideEp,
  isEpisodeMissingAniList,
  isEpisodeOnDisk,
  isEpisodeOverridden,
  isEpisodeSkipped,
  isEpMissingAniList,
  isEpOverridden,
  isEpSkipped,
  paginateShows,
  removeSeriesFromCatalog,
  resolveFilterSort,
  revertShowOverride,
  skipUnmappedSeasonOverride,
  toggleCardId,
  toggleSkipEpisodeOverride,
} from './overrides.store.utils';
import { CatalogShow, OfficialMappingsMap, RawTvdbOverrides } from '../models/types';

describe('OverridesStore Utils', () => {
  const sampleOfficial: OfficialMappingsMap = {
    '12345': {
      '1': {
        '1': { anilistId: 99901, anilistEpisode: 1 },
        '2': { anilistId: 99901, anilistEpisode: 2 },
      },
    },
  };

  const sampleCatalog: Record<string, CatalogShow> = {
    '12345': {
      tvdbId: '12345',
      title: 'Anime Alpha',
      seasons: {
        '1': {
          seasonNumber: 1,
          episodes: {
            '1': { episodeNumber: 1, name: 'Episode 1' },
            '2': { episodeNumber: 2, name: 'Episode 2' },
            '3': { episodeNumber: 3, name: 'Episode 3' },
          },
        },
      },
    },
    '67890': {
      tvdbId: '67890',
      title: 'Anime Beta',
      seasons: {
        '1': {
          seasonNumber: 1,
          episodes: {
            '1': { episodeNumber: 1, name: 'Episode 1' },
          },
        },
      },
    },
  };

  const sampleOverrides: RawTvdbOverrides = {
    '12345': {
      title: 'Anime Alpha',
      seasons: {
        '1': {
          episodes: {
            '2': { anilistId: 99999, anilistEpisode: 10 }, // overridden
            '3': { skipAniList: true }, // skipped
          },
        },
      },
    },
    '67890': {
      title: 'Anime Beta',
      seasons: {
        '1': {
          episodes: {
            '1': { anilistId: null }, // explicitly missing
          },
        },
      },
    },
  };

  describe('Episode Predicates', () => {
    it('isEpisodeOnDisk correctly identifies disk existence', () => {
      expect(isEpisodeOnDisk({ episodeNumber: 1, exists: true })).toBe(true);
      expect(isEpisodeOnDisk({ episodeNumber: 1, exists: false })).toBe(false);
      expect(isEpisodeOnDisk({ episodeNumber: 1, locationType: 'Virtual' })).toBe(false);
      expect(isEpisodeOnDisk({ episodeNumber: 1, locationType: 'FileSystem' })).toBe(true);
      expect(isEpisodeOnDisk({ episodeNumber: 1, path: '/media/anime/ep1.mkv' })).toBe(true);
      expect(isEpisodeOnDisk({ episodeNumber: 1, path: '' })).toBe(false);
      // Unspecified defaults to true for backwards compatibility with test fixtures
      expect(isEpisodeOnDisk({ episodeNumber: 1 })).toBe(true);
      // Movies always considered on disk
      expect(isEpisodeOnDisk({ episodeNumber: 1, exists: false }, { tvdbId: '1', title: 'Movie', seasons: {}, isMovie: true })).toBe(true);
    });
    it('isEpisodeSkipped correctly identifies skip flag', () => {
      expect(isEpisodeSkipped({ skipAniList: true })).toBe(true);
      expect(isEpisodeSkipped({ skipAniList: false })).toBe(false);
      expect(isEpisodeSkipped(undefined)).toBe(false);
    });

    it('isEpisodeMissingAniList identifies missing mappings', () => {
      expect(isEpisodeMissingAniList({ skipAniList: true }, null)).toBe(false);
      expect(isEpisodeMissingAniList({ anilistId: 100 }, null)).toBe(false);
      expect(isEpisodeMissingAniList({ anilistId: null }, { anilistId: 100, anilistEpisode: 1 })).toBe(true);
      expect(isEpisodeMissingAniList(undefined, null)).toBe(true);
      expect(isEpisodeMissingAniList(undefined, { anilistId: 100, anilistEpisode: 1 })).toBe(false);
    });

    it('isEpisodeOverridden identifies divergences from official mappings', () => {
      expect(isEpisodeOverridden({ skipAniList: true }, null)).toBe(false);
      expect(isEpisodeOverridden({ anilistId: 100, anilistEpisode: 1 }, null)).toBe(true);
      expect(isEpisodeOverridden(
        { anilistId: 100, anilistEpisode: 1 },
        { anilistId: 100, anilistEpisode: 1 }
      )).toBe(false);
      expect(isEpisodeOverridden(
        { anilistId: 200, anilistEpisode: 1 },
        { anilistId: 100, anilistEpisode: 1 }
      )).toBe(true);
    });
  });

  describe('Lookup & Evaluation Functions', () => {
    it('getOfficialEp and getOverrideEp return corresponding entries', () => {
      expect(getOfficialEp(sampleOfficial, '12345', '1', '1')).toEqual({ anilistId: 99901, anilistEpisode: 1 });
      expect(getOfficialEp(sampleOfficial, '12345', '1', '99')).toBeNull();

      expect(getOverrideEp(sampleOverrides, '12345', '1', '2')).toEqual({ anilistId: 99999, anilistEpisode: 10 });
      expect(getOverrideEp(sampleOverrides, '12345', '1', '99')).toBeUndefined();
    });

    it('isEpSkipped, isEpMissingAniList, isEpOverridden work across datasets', () => {
      expect(isEpSkipped(sampleOverrides, '12345', '1', '3')).toBe(true);
      expect(isEpSkipped(sampleOverrides, '12345', '1', '1')).toBe(false);

      // 12345 Ep 1: official exists, not overridden -> not missing
      expect(isEpMissingAniList(sampleOverrides, sampleOfficial, '12345', '1', '1')).toBe(false);
      // 67890 Ep 1: anilistId is null -> missing
      expect(isEpMissingAniList(sampleOverrides, sampleOfficial, '67890', '1', '1')).toBe(true);

      // 12345 Ep 2: overridden to 99999
      expect(isEpOverridden(sampleOverrides, sampleOfficial, '12345', '1', '2')).toBe(true);
      expect(isEpOverridden(sampleOverrides, sampleOfficial, '12345', '1', '1')).toBe(false);
    });
  });

  describe('Show Aggregations', () => {
    it('counts missing, overridden, and skipped per show', () => {
      const show1 = sampleCatalog['12345'];
      expect(countMissingInShow(sampleOverrides, sampleOfficial, '12345', show1)).toBe(0);
      expect(countOverriddenInShow(sampleOverrides, sampleOfficial, '12345', show1)).toBe(1);
      expect(countSkippedInShow(sampleOverrides, '12345', show1)).toBe(1);

      const show2 = sampleCatalog['67890'];
      expect(countMissingInShow(sampleOverrides, sampleOfficial, '67890', show2)).toBe(1);
      expect(countOverriddenInShow(sampleOverrides, sampleOfficial, '67890', show2)).toBe(0);
      expect(countSkippedInShow(sampleOverrides, '67890', show2)).toBe(0);

      // Virtual missing episode not on disk should NOT count towards missing
      const showWithVirtual: CatalogShow = {
        tvdbId: '99999',
        title: 'Virtual Anime',
        seasons: {
          '1': {
            seasonNumber: 1,
            episodes: {
              '1': { episodeNumber: 1, name: 'Ep 1', exists: false }, // missing anilist but not on disk
            },
          },
        },
      };
      expect(countMissingInShow({}, {}, '99999', showWithVirtual)).toBe(0);
    });
  });

  describe('Stats & Filter Counts', () => {
    it('calculateStatsSummary correctly aggregates library numbers', () => {
      const stats = calculateStatsSummary(sampleCatalog, sampleOverrides, sampleOfficial);
      expect(stats.totalShows).toBe(2);
      expect(stats.totalEpisodes).toBe(4);
      expect(stats.showsWithOverrides).toBe(1);
      expect(stats.skippedEpisodes).toBe(1);
      expect(stats.unmappedEpisodes).toBe(1);
      expect(stats.mappedEpisodes).toBe(2);
    });

    it('calculateFilterCounts counts categories accurately', () => {
      const counts = calculateFilterCounts(sampleCatalog, sampleOverrides, sampleOfficial);
      expect(counts.all).toBe(2);
      expect(counts.unmapped).toBe(1); // 67890 has missing
      expect(counts.complete).toBe(1); // 12345 has 0 missing
      expect(counts.overrides).toBe(1);
      expect(counts.skipped).toBe(1);
    });

    it('respects includePrivate flag in calculateStatsSummary, calculateFilterCounts, and filterAndSortShows', () => {
      const catalogWithPrivate: Record<string, CatalogShow> = {
        ...sampleCatalog,
        'jf-private-1': {
          tvdbId: 'jf-private-1',
          title: 'Private Anime',
          isPrivate: true,
          seasons: {
            '1': {
              seasonNumber: 1,
              episodes: {
                '1': { episodeNumber: 1, name: 'Secret Ep' },
              },
            },
          },
        },
      };

      // By default (includePrivate = false): private show excluded
      const statsExcluded = calculateStatsSummary(catalogWithPrivate, sampleOverrides, sampleOfficial, false);
      expect(statsExcluded.totalShows).toBe(2);

      const countsExcluded = calculateFilterCounts(catalogWithPrivate, sampleOverrides, sampleOfficial, false);
      expect(countsExcluded.all).toBe(2);

      const showsExcluded = filterAndSortShows(catalogWithPrivate, sampleOverrides, sampleOfficial, '', 'all', 'title-asc', false);
      expect(showsExcluded.length).toBe(2);
      expect(showsExcluded.some(([id]) => id === 'jf-private-1')).toBe(false);

      // When includePrivate = true: private show included
      const statsIncluded = calculateStatsSummary(catalogWithPrivate, sampleOverrides, sampleOfficial, true);
      expect(statsIncluded.totalShows).toBe(3);

      const countsIncluded = calculateFilterCounts(catalogWithPrivate, sampleOverrides, sampleOfficial, true);
      expect(countsIncluded.all).toBe(3);

      const showsIncluded = filterAndSortShows(catalogWithPrivate, sampleOverrides, sampleOfficial, '', 'all', 'title-asc', true);
      expect(showsIncluded.length).toBe(3);
      expect(showsIncluded.some(([id]) => id === 'jf-private-1')).toBe(true);
    });
  });

  describe('Filter, Sort, & Pagination', () => {
    it('filters shows by text query and category', () => {
      const results = filterAndSortShows(
        sampleCatalog,
        sampleOverrides,
        sampleOfficial,
        'Beta',
        'all',
        'title-asc'
      );
      expect(results).toHaveLength(1);
      expect(results[0][0]).toBe('67890');
    });

    it('sorts shows by missing-desc stably using saved baseline overrides', () => {
      // Show 67890 has 1 missing episode; Show 12345 has 0 missing
      const initial = filterAndSortShows(
        sampleCatalog,
        sampleOverrides,
        sampleOfficial,
        '',
        'all',
        'missing-desc'
      );
      expect(initial[0][0]).toBe('67890'); // 67890 first because it has missing
      expect(initial[1][0]).toBe('12345');

      // If user edits 67890 in-progress to map it (0 missing), but we pass the saved baseline,
      // it remains in its sorted position until saved:
      const inProgressEdits = applyEpisodeUpdate(
        sampleOverrides,
        sampleCatalog,
        '67890',
        '1',
        '1',
        'anilistId',
        '99999'
      );
      // Passing saved baseline (sampleOverrides) keeps order stable:
      const stableResult = filterAndSortShows(
        sampleCatalog,
        sampleOverrides,
        sampleOfficial,
        '',
        'all',
        'missing-desc'
      );
      expect(stableResult[0][0]).toBe('67890');

      // Once committed/saved, passing the updated overrides re-sorts:
      const reSortedResult = filterAndSortShows(
        sampleCatalog,
        inProgressEdits,
        sampleOfficial,
        '',
        'all',
        'missing-desc'
      );
      // Both now have 0 missing; ties break by title ("Anime Alpha" < "Anime Beta")
      expect(reSortedResult[0][0]).toBe('12345');
      expect(reSortedResult[1][0]).toBe('67890');
    });

    it('paginates show arrays properly', () => {
      const items: [string, CatalogShow][] = [
        ['1', sampleCatalog['12345']],
        ['2', sampleCatalog['67890']],
      ];
      expect(paginateShows(items, 1, 1)).toHaveLength(1);
      expect(paginateShows(items, 1, 1)[0][0]).toBe('1');
      expect(paginateShows(items, 2, 1)[0][0]).toBe('2');
      expect(paginateShows(items, 1, 100)).toHaveLength(2);
    });
  });

  describe('Pure Mutations & Overrides Updates', () => {
    it('applyEpisodeUpdate updates anilistId or anilistEpisode', () => {
      const updated = applyEpisodeUpdate(
        sampleOverrides,
        sampleCatalog,
        '12345',
        '1',
        '1',
        'anilistId',
        '77777'
      );
      expect(updated['12345'].seasons?.['1']?.episodes?.['1']?.anilistId).toBe(77777);
      // Ensure immutability: original sampleOverrides should not have ep 1
      expect(sampleOverrides['12345'].seasons?.['1']?.episodes?.['1']).toBeUndefined();
    });

    it('applyOfficialEpisode sets official mapping on episode', () => {
      const { overrides: updated, official } = applyOfficialEpisode(
        sampleOverrides,
        sampleCatalog,
        sampleOfficial,
        '12345',
        '1',
        '1'
      );
      expect(official).toEqual({ anilistId: 99901, anilistEpisode: 1 });
      expect(updated['12345'].seasons?.['1']?.episodes?.['1']?.anilistId).toBe(99901);
      expect(updated['12345'].seasons?.['1']?.episodes?.['1']?.anilistEpisode).toBe(1);
    });

    it('toggleSkipEpisodeOverride toggles skipAniList', () => {
      const toggledOn = toggleSkipEpisodeOverride(
        sampleOverrides,
        sampleCatalog,
        '12345',
        '1',
        '1'
      );
      expect(toggledOn['12345'].seasons?.['1']?.episodes?.['1']?.skipAniList).toBe(true);

      const toggledOff = toggleSkipEpisodeOverride(
        toggledOn,
        sampleCatalog,
        '12345',
        '1',
        '1'
      );
      expect(toggledOff['12345'].seasons?.['1']?.episodes?.['1']?.skipAniList).toBeUndefined();
    });

    it('clearEpisodeOverride removes episode override and cleans empty parents', () => {
      const cleared = clearEpisodeOverride(sampleOverrides, '67890', '1', '1');
      expect(cleared['67890']).toBeUndefined();
    });

    it('applyBatchSeasonOverride applies anilistId to all episodes in season', () => {
      const batchApplied = applyBatchSeasonOverride(
        sampleOverrides,
        sampleCatalog,
        '12345',
        '1',
        54321
      );
      const eps = batchApplied['12345'].seasons?.['1']?.episodes;
      expect(eps?.['1']?.anilistId).toBe(54321);
      expect(eps?.['2']?.anilistId).toBe(54321);
      expect(eps?.['3']?.anilistId).toBe(54321);
    });

    it('applyOfficialSeasonOverride applies available official mappings', () => {
      const { overrides: updated, appliedCount } = applyOfficialSeasonOverride(
        {},
        sampleCatalog,
        sampleOfficial,
        '12345',
        '1'
      );
      expect(appliedCount).toBe(2); // Ep 1 and 2 exist in official
      expect(updated['12345'].seasons?.['1']?.episodes?.['1']?.anilistId).toBe(99901);
      expect(updated['12345'].seasons?.['1']?.episodes?.['2']?.anilistId).toBe(99901);
    });

    it('skipUnmappedSeasonOverride marks only unmapped episodes as skipped', () => {
      const { overrides: updated, changedCount } = skipUnmappedSeasonOverride(
        {},
        sampleCatalog,
        sampleOfficial,
        '12345',
        '1'
      );
      // Ep 1 & 2 have official mappings. Ep 3 is unmapped.
      expect(changedCount).toBe(1);
      expect(updated['12345'].seasons?.['1']?.episodes?.['3']?.skipAniList).toBe(true);
    });

    it('removeSeriesFromCatalog removes target ID from all 3 maps', () => {
      const res = removeSeriesFromCatalog(sampleCatalog, sampleOverrides, sampleOfficial, '12345');
      expect(res.catalog['12345']).toBeUndefined();
      expect(res.overrides['12345']).toBeUndefined();
      expect(res.official['12345']).toBeUndefined();
      expect(res.catalog['67890']).toBeDefined();
    });

    it('toggleCardId and resolveFilterSort work as expected', () => {
      expect(toggleCardId(['1', '2'], '3')).toEqual(['1', '2', '3']);
      expect(toggleCardId(['1', '2'], '1')).toEqual(['2']);

      expect(resolveFilterSort('unmapped', 'title-asc')).toBe('missing-desc');
      expect(resolveFilterSort('overrides', 'title-asc')).toBe('overridden-desc');
      expect(resolveFilterSort('all', 'title-asc')).toBe('title-asc');
    });

    it('revertShowOverride restores saved show state and removes newly added overrides', () => {
      // 1. Revert modified show back to saved baseline
      const modified = applyEpisodeUpdate(
        sampleOverrides,
        sampleCatalog,
        '12345',
        '1',
        '2',
        'anilistId',
        '11111'
      );
      expect(modified['12345'].seasons?.['1']?.episodes?.['2']?.anilistId).toBe(11111);

      const reverted = revertShowOverride(modified, sampleOverrides, '12345');
      // Should revert to original 99999
      expect(reverted['12345'].seasons?.['1']?.episodes?.['2']?.anilistId).toBe(99999);

      // 2. Revert show that originally had no overrides in saved baseline
      const addedShowOverrides = applyEpisodeUpdate(
        sampleOverrides,
        sampleCatalog,
        '99999',
        '1',
        '1',
        'anilistId',
        '88888'
      );
      expect(addedShowOverrides['99999']).toBeDefined();

      const revertedAdded = revertShowOverride(addedShowOverrides, sampleOverrides, '99999');
      // Should be removed completely since 99999 was not in sampleOverrides
      expect(revertedAdded['99999']).toBeUndefined();
    });
  });
});
