export type EpisodeKind = 'regular' | 'special' | 'other';

export interface AniBridgeRange {
  start: number;
  end: number | null;
}

export interface AniBridgeSpan {
  season: number;
  inEntry: AniBridgeRange;
  inSeason: AniBridgeRange;
  kind: EpisodeKind;
}

export interface AniBridgeEntry {
  animeId: string;
  seriesKey: string;
  spans: AniBridgeSpan[];
}

export interface AnimeSeasonSegment {
  animeId: string;
  firstEpisodeNumber: number;
  episodeCount: number;
  firstEpisodeInEntry: number;
  kind: EpisodeKind;
}

export interface AnimeEpisodeResult {
  episodeNumber: number;
  isSpecial: boolean;
  kind: EpisodeKind;
  source: 'overrides' | 'anibridge' | 'animelist';
  anilist?: {
    mediaId: number;
    episodeNumber: number;
  };
  isSkipped?: boolean;
  skipAniList?: boolean;
}

export interface AnimeMovieResult {
  episodeNumber: number;
  source: 'overrides' | 'anibridge' | 'animelist';
  anilist?: {
    mediaId: number;
    episodeNumber: number;
  };
  isSkipped?: boolean;
  skipAniList?: boolean;
}

export interface SeriesLookupQuery {
  tvdbId?: string;
  tmdbId?: string;
  anilistId?: string;
  jellyfinSeriesId?: string;
}

export interface MovieLookupQuery {
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  anilistId?: string;
  jellyfinSeriesId?: string;
}
