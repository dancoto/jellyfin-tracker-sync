import { readFileSync } from 'node:fs';
import { AniBridgeIndex } from './anibridge';
import { AnimeListIndex } from './animelist';
import {
  ANIBRIDGE_MAPPINGS_URL,
  ANIME_LISTS_URL,
  getOrDownloadFile,
  type CacheOptions,
} from './cache';
import type {
  AniBridgeEntry,
  AnimeSeasonSegment,
  AnimeEpisodeResult,
  AnimeMovieResult,
  EpisodeKind,
  MovieLookupQuery,
  SeriesLookupQuery,
} from './models';
import { loadOverrides } from './overrides';
import {
  TvdbOverridesIndex,
  type EnsureShowOverrideParams,
  type EnsureShowOverrideResult,
} from './tvdb-overrides';
import { retireRedundantOverrides } from '../overrides/retire';

interface InternalEpisodeCandidate {
  internalAnimeId?: string;
  episodeNumber: number;
  isSpecial: boolean;
  kind: EpisodeKind;
  source: 'overrides' | 'anibridge' | 'animelist';
}

interface InternalMovieCandidate {
  internalAnimeId?: string;
  episodeNumber: number;
  source: 'overrides' | 'anibridge' | 'animelist';
}

export interface ResolverOptions extends CacheOptions {
  overridesPath?: string;
  tvdbOverridesPath?: string;
  enableAnimeListFallback?: boolean;
  autoRetireRedundant?: boolean;
}

export class AnimeResolver {
  private tvdbOverrides: TvdbOverridesIndex | null = null;
  private tvdbOverridesPath?: string;
  private overrides: AniBridgeIndex | null = null;
  private aniBridge: AniBridgeIndex | null = null;
  private animeList: AnimeListIndex | null = null;
  private initialized = false;

  public async initialize(options: ResolverOptions = {}): Promise<void> {
    // 1. Load manual overrides
    this.tvdbOverridesPath = options.tvdbOverridesPath;
    this.tvdbOverrides = TvdbOverridesIndex.load(options.tvdbOverridesPath);
    this.overrides = loadOverrides(options.overridesPath);

    // 2. Load AniBridge mappings
    try {
      const aniBridgePath = await getOrDownloadFile(
        'anibridge-mappings.json',
        ANIBRIDGE_MAPPINGS_URL,
        options,
      );
      if (aniBridgePath) {
        const content = readFileSync(aniBridgePath, 'utf-8');
        this.aniBridge = AniBridgeIndex.parse(content);
        console.log(
          `AniBridge initialized: ${this.aniBridge.entriesByAnimeId.size} entries across ${this.aniBridge.entriesByTvdb.size} TVDB shows, ${this.aniBridge.moviesByKey.size} movies.`,
        );
      }
    } catch (error) {
      console.error('Failed to initialize AniBridge mappings:', error);
    }

    // 3. Load Anime-Lists fallback if enabled (default true)
    if (options.enableAnimeListFallback !== false) {
      try {
        const animeListPath = await getOrDownloadFile('anime-list.xml', ANIME_LISTS_URL, options);
        if (animeListPath) {
          const content = readFileSync(animeListPath, 'utf-8');
          this.animeList = AnimeListIndex.parse(content);
          console.log(
            `Anime-Lists initialized: ${this.animeList.entriesByAnimeId.size} entries across ${this.animeList.entriesByTvdb.size} TVDB shows.`,
          );
        }
      } catch (error) {
        console.error('Failed to initialize Anime-Lists fallback:', error);
      }
    }

    this.initialized = true;

    // 4. Automatically retire redundant overrides that are identical to newly loaded official mappings
    if (options.autoRetireRedundant !== false && this.aniBridge) {
      try {
        const retireSummary = retireRedundantOverrides({
          customOverridesPath: this.tvdbOverridesPath,
          resolver: this,
        });
        if (retireSummary.retiredCount > 0) {
          console.log(
            `[AnimeResolver] Automatically retired ${retireSummary.retiredCount} redundant override(s) across ${retireSummary.affectedShowsCount} show(s) matching upstream AniBridge.`,
          );
        }
      } catch (err) {
        console.error('[AnimeResolver] Failed retiring redundant overrides:', err);
      }
    }
  }

  public setIndices(
    aniBridge: AniBridgeIndex | null,
    overrides: AniBridgeIndex | null = null,
    animeList: AnimeListIndex | null = null,
    tvdbOverrides: TvdbOverridesIndex | null = null,
  ): void {
    this.aniBridge = aniBridge;
    this.overrides = overrides;
    this.animeList = animeList;
    this.tvdbOverrides = tvdbOverrides;
    this.initialized = true;
  }

  public isInitialized(): boolean {
    return this.initialized && this.aniBridge !== null;
  }

  public reset(): void {
    this.aniBridge = null;
    this.overrides = null;
    this.animeList = null;
    this.tvdbOverrides = null;
    this.tvdbOverridesPath = undefined;
    this.initialized = false;
  }

  public setTvdbOverrides(tvdbOverrides: TvdbOverridesIndex | null): void {
    this.tvdbOverrides = tvdbOverrides;
  }

  public setTvdbOverridesPath(path?: string): void {
    this.tvdbOverridesPath = path;
  }

  public hasTvdbShow(tvdbIdOrKeys: string | string[] | undefined): boolean {
    return this.tvdbOverrides?.hasShow(tvdbIdOrKeys) ?? false;
  }

  public ensureShowInOverrides(
    params: EnsureShowOverrideParams,
    customPath?: string,
  ): EnsureShowOverrideResult {
    const targetPath = customPath ?? this.tvdbOverridesPath;
    const result = TvdbOverridesIndex.ensureShowInOverrides(params, targetPath);
    if (result.added && result.data) {
      this.tvdbOverrides = TvdbOverridesIndex.parse(result.data);
    }
    return result;
  }

  public resolveEpisode(
    series: SeriesLookupQuery,
    seasonNumber: number,
    episodeNumber: number,
  ): AnimeEpisodeResult | null {
    if (!this.initialized) {
      console.warn('AnimeResolver: queried before initialization.');
    }

    // 0. Check TVDB-driven manual overrides first
    const candidateKeys = [
      series.tvdbId,
      series.tmdbId ? `tmdb-${series.tmdbId}` : undefined,
      series.jellyfinSeriesId ? `jf-${series.jellyfinSeriesId}` : undefined,
    ].filter((k): k is string => Boolean(k));

    const tvdbOverride = this.tvdbOverrides?.getEpisodeOverride(
      candidateKeys,
      seasonNumber,
      episodeNumber,
    );

    if (tvdbOverride) {
      if (tvdbOverride.skip) {
        return {
          episodeNumber,
          isSpecial: seasonNumber === 0,
          kind: seasonNumber === 0 ? 'special' : 'regular',
          source: 'overrides',
          isSkipped: true,
          skipAniList: true,
        };
      }

      if (tvdbOverride.anilistId !== undefined) {
        return {
          episodeNumber: tvdbOverride.anilistEpisode ?? episodeNumber,
          isSpecial: tvdbOverride.isSpecial ?? seasonNumber === 0,
          kind: (tvdbOverride.isSpecial ?? seasonNumber === 0) ? 'special' : 'regular',
          source: 'overrides',
          anilist: {
            mediaId: tvdbOverride.anilistId,
            episodeNumber: tvdbOverride.anilistEpisode ?? episodeNumber,
          },
          skipAniList: false,
        };
      }

      if (tvdbOverride.skipAniList) {
        return {
          episodeNumber,
          isSpecial: seasonNumber === 0,
          kind: seasonNumber === 0 ? 'special' : 'regular',
          source: 'overrides',
          skipAniList: true,
        };
      }

      if (tvdbOverride.isExplicitNull) {
        return {
          episodeNumber: tvdbOverride.anilistEpisode ?? episodeNumber,
          isSpecial: tvdbOverride.isSpecial ?? seasonNumber === 0,
          kind: (tvdbOverride.isSpecial ?? seasonNumber === 0) ? 'special' : 'regular',
          source: 'overrides',
          skipAniList: false,
        };
      }

      // If anilistId is undefined in override, check official mapping first
      const official = this.resolveOfficialEpisode(series, seasonNumber, episodeNumber);
      if (official) {
        return official;
      }

      return {
        episodeNumber: tvdbOverride.anilistEpisode ?? episodeNumber,
        isSpecial: tvdbOverride.isSpecial ?? seasonNumber === 0,
        kind: (tvdbOverride.isSpecial ?? seasonNumber === 0) ? 'special' : 'regular',
        source: 'overrides',
        skipAniList: false,
      };
    }

    return this.resolveOfficialEpisode(series, seasonNumber, episodeNumber);
  }

  public resolveOfficialEpisode(
    series: SeriesLookupQuery,
    seasonNumber: number,
    episodeNumber: number,
  ): AnimeEpisodeResult | null {
    if (!this.initialized) {
      console.warn('AnimeResolver: queried before initialization.');
    }

    let candidate: InternalEpisodeCandidate | null = null;

    // 1. Check specials (Season 0)
    if (seasonNumber === 0) {
      candidate = this.resolveSpecial(series, episodeNumber);
    } else {
      // 2. Regular Season: Check Overrides -> AniBridge -> AnimeList
      candidate =
        this.resolveRegularFromIndex(
          this.overrides,
          series,
          seasonNumber,
          episodeNumber,
          'overrides',
        ) ||
        this.resolveRegularFromIndex(
          this.aniBridge,
          series,
          seasonNumber,
          episodeNumber,
          'anibridge',
        ) ||
        this.resolveRegularFromAnimeList(series, seasonNumber, episodeNumber);
    }

    if (candidate) {
      return this.attachAniListMapping(
        candidate,
        series.anilistId,
        series.tvdbId,
        seasonNumber,
        episodeNumber,
      );
    }

    // Direct TVDB -> AniList mapping from AniBridge index if no spans matched
    if (this.aniBridge && series.tvdbId) {
      const anilistMatch = this.aniBridge.resolveAniListFromTvdb(
        series.tvdbId,
        seasonNumber,
        episodeNumber,
      );
      if (anilistMatch) {
        return {
          episodeNumber,
          isSpecial: seasonNumber === 0,
          kind: seasonNumber === 0 ? 'special' : 'regular',
          source: 'anibridge',
          anilist: anilistMatch,
        };
      }
    }

    return null;
  }

  public resolveMovie(movie: MovieLookupQuery): AnimeMovieResult | null {
    if (!this.initialized) {
      console.warn('AnimeResolver: queried before initialization.');
    }

    // 1. TVDB / JSON overrides (mapping-overrides.json)
    const candidateKeys = [
      movie.tvdbId,
      movie.tmdbId ? `tmdb-${movie.tmdbId}` : undefined,
      movie.jellyfinSeriesId ? `jf-${movie.jellyfinSeriesId}` : undefined,
    ].filter((k): k is string => Boolean(k));

    if (this.tvdbOverrides && candidateKeys.length > 0) {
      const tvdbOverride = this.tvdbOverrides.getEpisodeOverride(candidateKeys, 0, 1);
      if (tvdbOverride) {
        if (tvdbOverride.skip || tvdbOverride.skipAniList) {
          return {
            episodeNumber: 1,
            source: 'overrides',
            skipAniList: true,
          };
        }
        if (tvdbOverride.anilistId !== undefined) {
          return {
            episodeNumber: tvdbOverride.anilistEpisode ?? 1,
            source: 'overrides',
            anilist: {
              mediaId: tvdbOverride.anilistId,
              episodeNumber: tvdbOverride.anilistEpisode ?? 1,
            },
            skipAniList: false,
          };
        }
      }
    }

    // 2. AniBridge-format manual overrides
    if (this.overrides) {
      const match = this.overrides.resolveMovie(movie.tmdbId, movie.imdbId, movie.tvdbId);
      if (match) {
        const candidate: InternalMovieCandidate = {
          internalAnimeId: match.animeId,
          episodeNumber: match.episodeNumber,
          source: 'overrides',
        };
        return this.attachAniListMovieMapping(candidate, movie);
      }
    }

    // 3. Fall back to official movie mappings
    return this.resolveOfficialMovie(movie);
  }

  public resolveOfficialMovie(movie: MovieLookupQuery): AnimeMovieResult | null {
    if (!this.initialized) {
      console.warn('AnimeResolver: queried before initialization.');
    }

    let candidate: InternalMovieCandidate | null = null;

    // 1. AniBridge
    if (this.aniBridge) {
      const match = this.aniBridge.resolveMovie(movie.tmdbId, movie.imdbId, movie.tvdbId);
      if (match) {
        candidate = {
          internalAnimeId: match.animeId,
          episodeNumber: match.episodeNumber,
          source: 'anibridge',
        };
      }
    }

    // 2. AnimeList
    if (!candidate && this.animeList) {
      const match = this.animeList.resolveMovie(movie.tmdbId, movie.imdbId, movie.tvdbId);
      if (match) {
        candidate = {
          internalAnimeId: match.animeId,
          episodeNumber: match.episodeNumber,
          source: 'animelist',
        };
      }
    }

    if (candidate) {
      return this.attachAniListMovieMapping(candidate, movie);
    }

    // Fallback: If direct AniList movie mapping is known
    if (this.aniBridge) {
      const anilistMatch = this.aniBridge.resolveAniListMovie(
        movie.tmdbId,
        movie.imdbId,
        movie.tvdbId,
      );
      if (anilistMatch) {
        return {
          episodeNumber: anilistMatch.episodeNumber,
          source: 'anibridge',
          anilist: anilistMatch,
        };
      }
    }

    return null;
  }

  private attachAniListMapping(
    candidate: InternalEpisodeCandidate,
    anilistId?: string,
    tvdbId?: string,
    seasonNumber?: number,
    episodeNumber?: number,
  ): AnimeEpisodeResult {
    let anilistMatch: { mediaId: number; episodeNumber: number } | null = null;
    if (anilistId) {
      const parsed = parseInt(anilistId, 10);
      if (Number.isInteger(parsed)) {
        anilistMatch = { mediaId: parsed, episodeNumber: candidate.episodeNumber };
      }
    }
    if (!anilistMatch && this.overrides && candidate.internalAnimeId) {
      anilistMatch = this.overrides.resolveAniList(
        candidate.internalAnimeId,
        candidate.kind,
        candidate.episodeNumber,
      );
    }
    // Check direct TVDB Season -> AniList mapping from AniBridge index
    if (
      !anilistMatch &&
      this.aniBridge &&
      tvdbId &&
      seasonNumber !== undefined &&
      episodeNumber !== undefined
    ) {
      anilistMatch = this.aniBridge.resolveAniListFromTvdb(tvdbId, seasonNumber, episodeNumber);
    }
    // Fallback to internal entry -> AniList mapping
    if (!anilistMatch && this.aniBridge && candidate.internalAnimeId) {
      anilistMatch = this.aniBridge.resolveAniList(
        candidate.internalAnimeId,
        candidate.kind,
        candidate.episodeNumber,
      );
    }

    const result: AnimeEpisodeResult = {
      episodeNumber: candidate.episodeNumber,
      isSpecial: candidate.isSpecial,
      kind: candidate.kind,
      source: candidate.source,
    };
    if (anilistMatch) {
      result.anilist = anilistMatch;
    }
    return result;
  }

  private attachAniListMovieMapping(
    candidate: InternalMovieCandidate,
    movie: MovieLookupQuery,
  ): AnimeMovieResult {
    let anilistMatch: { mediaId: number; episodeNumber: number } | null = null;
    if (movie.anilistId) {
      const parsed = parseInt(movie.anilistId, 10);
      if (Number.isInteger(parsed)) {
        anilistMatch = { mediaId: parsed, episodeNumber: 1 };
      }
    }
    if (!anilistMatch && this.overrides && candidate.internalAnimeId) {
      anilistMatch = this.overrides.resolveAniList(candidate.internalAnimeId, 'regular', 1);
    }
    if (!anilistMatch && this.aniBridge) {
      anilistMatch = this.aniBridge.resolveAniListMovie(movie.tmdbId, movie.imdbId, movie.tvdbId);
    }
    if (!anilistMatch && this.aniBridge && candidate.internalAnimeId) {
      anilistMatch = this.aniBridge.resolveAniList(candidate.internalAnimeId, 'regular', 1);
    }

    const result: AnimeMovieResult = {
      episodeNumber: candidate.episodeNumber,
      source: candidate.source,
    };
    if (anilistMatch) {
      result.anilist = anilistMatch;
    }
    return result;
  }

  private resolveSpecial(
    series: SeriesLookupQuery,
    episodeNumber: number,
  ): InternalEpisodeCandidate | null {
    // 1. Overrides
    if (this.overrides) {
      const siblings = this.getSiblingsFromAniBridge(this.overrides, series);
      if (siblings) {
        const match = this.overrides.placeSpecial(siblings, episodeNumber);
        if (match) {
          return {
            internalAnimeId: match.animeId,
            episodeNumber: match.episodeNumber,
            isSpecial: match.kind === 'special',
            kind: match.kind,
            source: 'overrides',
          };
        }
      }
    }

    // 2. AniBridge
    if (this.aniBridge) {
      const siblings = this.getSiblingsFromAniBridge(this.aniBridge, series);
      if (siblings) {
        const match = this.aniBridge.placeSpecial(siblings, episodeNumber);
        if (match) {
          return {
            internalAnimeId: match.animeId,
            episodeNumber: match.episodeNumber,
            isSpecial: match.kind === 'special',
            kind: match.kind,
            source: 'anibridge',
          };
        }
      }
    }

    // 3. AnimeList
    if (this.animeList && series.tvdbId) {
      const siblings = this.animeList.getEntriesForShow(series.tvdbId);
      if (siblings) {
        const match = this.animeList.placeSpecial(siblings, episodeNumber);
        if (match) {
          return {
            internalAnimeId: match.animeId,
            episodeNumber: match.episodeNumber,
            isSpecial: match.kind === 'special',
            kind: match.kind,
            source: 'animelist',
          };
        }
      }
    }

    return null;
  }

  private resolveRegularFromIndex(
    index: AniBridgeIndex | null,
    series: SeriesLookupQuery,
    seasonNumber: number,
    episodeNumber: number,
    source: 'overrides' | 'anibridge',
  ): InternalEpisodeCandidate | null {
    if (!index) return null;

    const siblings = this.getSiblingsFromAniBridge(index, series);
    if (!siblings || siblings.length === 0) return null;

    const segments = index.placeSeason(siblings, seasonNumber);
    const segment = this.findMatchingSegment(segments, episodeNumber);
    if (!segment) return null;

    const offset = episodeNumber - segment.firstEpisodeNumber;
    return {
      internalAnimeId: segment.animeId,
      episodeNumber: segment.firstEpisodeInEntry + offset,
      isSpecial: segment.kind === 'special',
      kind: segment.kind,
      source,
    };
  }

  private resolveRegularFromAnimeList(
    series: SeriesLookupQuery,
    seasonNumber: number,
    episodeNumber: number,
  ): InternalEpisodeCandidate | null {
    if (!this.animeList) return null;

    const siblings = series.tvdbId ? this.animeList.getEntriesForShow(series.tvdbId) : null;
    if (!siblings || siblings.length === 0) return null;

    const segments = this.animeList.placeSeason(siblings, seasonNumber);
    const segment = this.findMatchingSegment(segments, episodeNumber);
    if (!segment) return null;

    const offset = episodeNumber - segment.firstEpisodeNumber;
    return {
      internalAnimeId: segment.animeId,
      episodeNumber: segment.firstEpisodeInEntry + offset,
      isSpecial: false,
      kind: 'regular',
      source: 'animelist',
    };
  }

  private getSiblingsFromAniBridge(
    index: AniBridgeIndex,
    series: SeriesLookupQuery,
  ): AniBridgeEntry[] | null {
    if (series.tvdbId) {
      const entries = index.getEntriesForShow(series.tvdbId);
      if (entries) return entries;
    }

    if (series.tmdbId) {
      const entries = index.getEntriesForTmdbShow(series.tmdbId);
      if (entries) return entries;
    }

    return null;
  }

  private findMatchingSegment(
    segments: AnimeSeasonSegment[],
    episodeNumber: number,
  ): AnimeSeasonSegment | null {
    for (const seg of segments) {
      if (episodeNumber < seg.firstEpisodeNumber) continue;

      if (seg.episodeCount === 0) {
        return seg;
      }

      if (episodeNumber < seg.firstEpisodeNumber + seg.episodeCount) {
        return seg;
      }
    }
    return null;
  }
}

export const defaultAnimeResolver = new AnimeResolver();
