import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TVDB_OVERRIDES_FILE_NAME = 'mapping-overrides.json';

export interface RawEpisodeOverride {
  name?: string;
  skip?: boolean;
  skipAniList?: boolean;
  anilistId?: string | number | null;
  anilistEpisode?: number | null;
  isSpecial?: boolean;
}

export interface RawSeasonOverride {
  name?: string;
  anilistId?: string | number | null;
  anilistEpisodeOffset?: number;
  episodes?: Record<string, RawEpisodeOverride>;
}

export interface RawShowOverride {
  title?: string;
  tmdbId?: string;
  seasons?: Record<string | number, RawSeasonOverride>;
}

export type RawTvdbOverrides = Record<string, RawShowOverride>;

export interface TvdbResolvedOverride {
  skip?: boolean;
  skipAniList?: boolean;
  isExplicitNull?: boolean;
  anilistId?: number;
  anilistEpisode?: number;
  isSpecial?: boolean;
}

export interface EnsureShowOverrideParams {
  tvdbId: string;
  title: string;
  tmdbId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeName?: string;
  anilistId?: string | number | null;
  anilistEpisode?: number | null;
}

export interface EnsureShowOverrideResult {
  added: boolean;
  reason: 'show_added' | 'season_added' | 'episode_added' | 'already_exists' | 'missing_tvdb_id';
  filePath?: string;
  data?: RawTvdbOverrides;
}

export class TvdbOverridesIndex {
  private shows: Map<string, RawShowOverride> = new Map();

  public static getFilePath(customPath?: string): string {
    if (customPath) {
      return resolve(customPath);
    }
    const inConfig = resolve('/config', TVDB_OVERRIDES_FILE_NAME);
    if (existsSync(inConfig)) {
      return inConfig;
    }
    return resolve('.', TVDB_OVERRIDES_FILE_NAME);
  }

  public static load(customPath?: string): TvdbOverridesIndex | null {
    const filePath = TvdbOverridesIndex.getFilePath(customPath);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as RawTvdbOverrides;
      console.log(`Loaded TVDB mapping overrides from ${filePath}`);
      return TvdbOverridesIndex.parse(parsed);
    } catch (error) {
      console.error(`Failed to load TVDB mapping overrides from ${filePath}:`, error);
      return null;
    }
  }

  public static parse(data: RawTvdbOverrides): TvdbOverridesIndex {
    const index = new TvdbOverridesIndex();
    for (const [tvdbId, show] of Object.entries(data)) {
      if (show && typeof show === 'object') {
        index.shows.set(String(tvdbId).trim(), show);
      }
    }
    return index;
  }

  public hasShow(tvdbIdOrKeys: string | string[] | undefined): boolean {
    if (!tvdbIdOrKeys) {
      return false;
    }
    const candidateKeys = Array.isArray(tvdbIdOrKeys) ? tvdbIdOrKeys : [tvdbIdOrKeys];
    return candidateKeys.some((k) => k && this.shows.has(String(k).trim()));
  }

  public static ensureShowInOverrides(
    params: EnsureShowOverrideParams,
    customPath?: string,
  ): EnsureShowOverrideResult {
    if (!params.tvdbId) {
      return { added: false, reason: 'missing_tvdb_id' };
    }

    const filePath = TvdbOverridesIndex.getFilePath(customPath);
    let data: RawTvdbOverrides = {};

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        data = JSON.parse(content) as RawTvdbOverrides;
      } catch (err) {
        console.error(`Failed to parse overrides file at ${filePath}:`, err);
        data = {};
      }
    }

    const showKey = String(params.tvdbId).trim();
    let show = data[showKey];
    let added = false;
    let reason: EnsureShowOverrideResult['reason'] = 'already_exists';

    if (!show) {
      show = {
        title: params.title,
        tmdbId: params.tmdbId,
        seasons: {},
      };
      data[showKey] = show;
      added = true;
      reason = 'show_added';
    } else {
      if (!show.title && params.title) {
        show.title = params.title;
      }
      if (!show.tmdbId && params.tmdbId) {
        show.tmdbId = params.tmdbId;
      }
      if (!show.seasons) {
        show.seasons = {};
      }
    }

    const seasons = show.seasons ?? {};
    show.seasons = seasons;

    const seasonNum = params.seasonNumber ?? 1;
    const epNum = params.episodeNumber ?? 1;
    const seasonKey = String(seasonNum);
    let season = seasons[seasonKey] ?? seasons[seasonNum];

    if (!season) {
      season = { episodes: {} };
      seasons[seasonKey] = season;
      if (!added) {
        added = true;
        reason = 'season_added';
      }
    }

    if (!season.episodes) {
      season.episodes = {};
    }
    const episodes = season.episodes;

    const epKey = String(epNum);
    if (!episodes[epKey]) {
      const epEntry: RawEpisodeOverride = {
        name: params.episodeName ?? `Episode ${epNum}`,
        anilistId: params.anilistId ?? null,
        anilistEpisode: params.anilistEpisode ?? (params.anilistId ? epNum : null),
      };
      episodes[epKey] = epEntry;
      if (!added) {
        added = true;
        reason = 'episode_added';
      }
    }

    if (added) {
      try {
        writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(
          `Updated TVDB mapping overrides at ${filePath} (${reason} for TVDB ${params.tvdbId})`,
        );
      } catch (err) {
        console.error(`Failed to write TVDB overrides to ${filePath}:`, err);
        return { added: false, reason: 'already_exists', filePath, data };
      }
    }

    return { added, reason, filePath, data };
  }

  public getEpisodeOverride(
    tvdbIdOrKeys: string | string[] | undefined,
    seasonNumber: number,
    episodeNumber: number,
  ): TvdbResolvedOverride | null {
    if (!tvdbIdOrKeys) {
      return null;
    }

    const candidateKeys = Array.isArray(tvdbIdOrKeys) ? tvdbIdOrKeys : [tvdbIdOrKeys];
    let show: RawShowOverride | undefined;
    for (const key of candidateKeys) {
      if (!key) continue;
      const found = this.shows.get(String(key).trim());
      if (found) {
        show = found;
        break;
      }
    }
    if (!show || !show.seasons) {
      return null;
    }

    const season = show.seasons[String(seasonNumber)] ?? show.seasons[seasonNumber];
    if (!season) {
      return null;
    }

    // 1. Check episode-specific override
    let epConfig: RawEpisodeOverride | undefined;
    if (season.episodes) {
      epConfig = season.episodes[String(episodeNumber)];

      // Check range keys (e.g. "1-12")
      if (!epConfig) {
        for (const [key, conf] of Object.entries(season.episodes)) {
          if (key.includes('-')) {
            const [startStr, endStr] = key.split('-').map((s) => s.trim());
            if (!startStr || !endStr) continue;
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (
              Number.isInteger(start) &&
              Number.isInteger(end) &&
              episodeNumber >= start &&
              episodeNumber <= end
            ) {
              epConfig = conf;
              break;
            }
          }
        }
      }
    }

    // 2. Resolve episode configuration
    if (epConfig) {
      if (epConfig.skip) {
        return { skip: true, skipAniList: true };
      }

      const skipAniList = Boolean(epConfig.skipAniList);
      const isExplicitNull = !skipAniList && epConfig.anilistId === null;

      const anilistId =
        !skipAniList && epConfig.anilistId !== undefined && epConfig.anilistId !== null
          ? parseInt(String(epConfig.anilistId), 10)
          : undefined;

      return {
        skip: false,
        skipAniList,
        isExplicitNull,
        anilistId: Number.isInteger(anilistId) ? anilistId : undefined,
        anilistEpisode: epConfig.anilistEpisode ?? (anilistId ? episodeNumber : undefined),
        isSpecial: epConfig.isSpecial ?? seasonNumber === 0,
      };
    }

    // 3. Fallback to season-level 1:1 defaults
    const hasSeasonAniList = season.anilistId !== undefined;

    if (hasSeasonAniList) {
      const skipAniList = season.anilistId === null;

      const anilistId =
        season.anilistId !== undefined && season.anilistId !== null
          ? parseInt(String(season.anilistId), 10)
          : undefined;

      const anilistOffset = season.anilistEpisodeOffset ?? 0;

      return {
        skip: false,
        skipAniList,
        isExplicitNull: season.anilistId === null,
        anilistId: Number.isInteger(anilistId) ? anilistId : undefined,
        anilistEpisode: anilistId ? episodeNumber + anilistOffset : undefined,
        isSpecial: seasonNumber === 0,
      };
    }

    return null;
  }
}
