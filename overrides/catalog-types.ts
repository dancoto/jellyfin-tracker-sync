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

export type AnimeCatalog = Record<string, CatalogShow>;

export interface CatalogData {
  lastUpdated: string;
  shows: AnimeCatalog;
}

export interface CatalogSyncSummary {
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

export interface CatalogSyncOptions {
  libraryNames?: string[];
  customCatalogPath?: string;
  customOverridesPath?: string;
  pruneDeletedOverrides?: boolean;
}

export interface SeriesSyncOptions {
  customCatalogPath?: string;
  customOverridesPath?: string;
  pruneDeletedOverrides?: boolean;
  jellyfinSeriesId?: string;
  libraryName?: string;
}

export interface SeriesSyncSummary {
  tvdbId: string;
  title: string;
  show?: CatalogShow;
  deleted?: boolean;
  totalEpisodes: number;
  prunedOverridesCount: number;
}
