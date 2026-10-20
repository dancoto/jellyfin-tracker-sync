export interface UserTokensStatus {
  isConfigured: boolean;
  isValid: boolean;
  simklUsername?: string;
  expiresInDays?: number;
  hasRefreshToken?: boolean;
  error?: string;
}

export interface AniListTokensStatus {
  isConfigured: boolean;
  isValid: boolean;
  anilistUsername?: string;
  anilistUserId?: number;
  expiresInDays?: number;
  error?: string;
}

export interface UserStatus {
  username: string;
  isConfigured: boolean;
  simkl: UserTokensStatus;
  anilist: AniListTokensStatus;
}

export interface ServiceAuthConfig {
  configured: boolean;
  clientId?: string;
  hasClientSecret?: boolean;
  redirectUri?: string;
}

export interface UsersApiResponse {
  simkl: ServiceAuthConfig;
  anilist: ServiceAuthConfig;
  jellyfinUsers?: { id?: string; name: string }[];
  users: UserStatus[];
}

export interface CatalogEpisode {
  episodeNumber: number;
  name?: string;
  jellyfinEpisodeId?: string;
  tvdbEpisodeId?: string;
  locationType?: string;
  path?: string;
  exists?: boolean;
}

export interface CatalogSeason {
  seasonNumber: number;
  name?: string;
  episodes: Record<string, CatalogEpisode>;
}

export interface CatalogShow {
  tvdbId: string;
  title: string;
  tmdbId?: string;
  jellyfinSeriesId?: string;
  isMovie?: boolean;
  isPrivate?: boolean;
  libraryName?: string;
  seasons: Record<string, CatalogSeason>;
}

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

export interface EffectiveEpisodeMapping {
  episodeNumber: number;
  name: string;
  jellyfinEpisodeId?: string;
  tvdbEpisodeId?: string;
  anilistId?: number | null;
  anilistEpisode?: number | null;
  skipAniList?: boolean;
  source: 'official' | 'manual' | 'unmapped';
  hasDivergence?: boolean;
  officialAnilistId?: number;
  officialAnilistEpisode?: number;
  officialSkipAniList?: boolean;
}

export interface EffectiveShowMapping {
  tvdbId: string;
  title: string;
  tmdbId?: string;
  jellyfinSeriesId?: string;
  hasCustomOverride: boolean;
  hasUnmapped: boolean;
  hasSkipped: boolean;
  totalEpisodes: number;
  mappedCount: number;
  seasons: Record<
    string,
    {
      seasonNumber: number;
      episodes: Record<string, EffectiveEpisodeMapping>;
    }
  >;
}

export interface OverridesSummary {
  totalShows: number;
  totalEpisodes: number;
  mappedEpisodes: number;
  showsWithOverrides: number;
  unmappedEpisodes: number;
  skippedEpisodes: number;
}

export interface OfficialEpisodeInfo {
  anilistId: number;
  anilistEpisode: number;
}

export type OfficialMappingsMap = Record<
  string,
  Record<string, Record<string, OfficialEpisodeInfo | null>>
>;

export interface OverridesApiResponse {
  filePath?: string;
  catalog: Record<string, CatalogShow>;
  overrides: RawTvdbOverrides;
  official?: OfficialMappingsMap;
  lastUpdated?: string;
  summary?: OverridesSummary;
}

export interface SeriesSyncResult {
  tvdbId: string;
  title: string;
  show?: CatalogShow;
  deleted?: boolean;
  totalEpisodes: number;
  prunedOverridesCount: number;
}

export interface CatalogSyncResult {
  librariesScanned: string[];
  totalSeriesScanned: number;
  totalEpisodesScanned: number;
  totalMoviesScanned: number;
  catalogShowsCount: number;
  catalogEpisodesCount: number;
  lastUpdated: string;
  prunedOverridesCount?: number;
  prunedShowsCount?: number;
}

export interface RetiredEpisodeItem {
  tvdbId: string;
  title: string;
  season: number;
  episode: number;
  anilistId: number;
  anilistEpisode: number;
}

export interface RetireDetail {
  tvdbId: string;
  title: string;
  season: number;
  episode: number;
  anilistId: number;
  anilistEpisode: number;
  source: string;
}

export interface RetireSummary {
  retiredCount: number;
  affectedShowsCount: number;
  affectedShowTitles: string[];
  backupPath?: string;
  details: RetireDetail[];
}

export interface RetireRedundantResult {
  dryRun?: boolean;
  success?: boolean;
  summary?: RetireSummary;
  retiredEpisodesCount?: number;
  retiredShowsCount?: number;
  remainingOverridesCount?: number;
  retiredList?: RetiredEpisodeItem[];
}
