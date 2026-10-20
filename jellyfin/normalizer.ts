import { appConfig } from '../shared/config';
import type { NormalizedPlaybackEvent, RawJellyfinPayload } from './models';

export const DEFAULT_EXCLUDED_LIBRARIES: string[] = [];
export const DEFAULT_ANIME_LIBRARIES = ['Anime', 'Anime Movies'];

export const isExcludedLibrary = (
  libraryName?: string | null,
  excludedList?: string[],
): boolean => {
  if (!libraryName) return false;
  const list =
    excludedList ?? appConfig?.jellyfin?.excluded_libraries ?? DEFAULT_EXCLUDED_LIBRARIES;
  const normalized = libraryName.toLowerCase().trim();
  return list.some((item) => normalized === item.toLowerCase().trim());
};

export const isPrivateAnimeLibrary = (
  libraryName?: string | null,
  privateList?: string[],
): boolean => {
  if (!libraryName) return false;
  const list =
    privateList ?? appConfig?.jellyfin?.private_anime_libraries ?? [];
  const normalized = libraryName.toLowerCase().trim();
  return list.some(
    (item) =>
      normalized === item.toLowerCase().trim() ||
      normalized.includes(item.toLowerCase().trim()),
  );
};

export const isAnimeLibrary = (
  libraryName?: string | null,
  options?: { animeLibraries?: string[]; privateAnimeLibraries?: string[]; excludedLibraries?: string[] },
): boolean => {
  if (!libraryName) return false;
  if (isExcludedLibrary(libraryName, options?.excludedLibraries)) return false;
  if (isPrivateAnimeLibrary(libraryName, options?.privateAnimeLibraries)) return true;

  const animeList = options?.animeLibraries ?? appConfig?.jellyfin?.anime_libraries;

  if (animeList && animeList.length > 0) {
    const normalized = libraryName.toLowerCase().trim();
    return animeList.some(
      (item) =>
        normalized === item.toLowerCase().trim() || normalized.includes(item.toLowerCase().trim()),
    );
  }

  return libraryName.toLowerCase().includes('anime');
};

export const normalizeJellyfinWebhook = (payload: RawJellyfinPayload): NormalizedPlaybackEvent => {
  const notificationType = payload.NotificationType ?? 'PlaybackStop';
  const username = payload.NotificationUsername ?? payload.Username ?? payload.User?.Name ?? '';

  let itemType: 'Episode' | 'Movie' | 'Series' | 'Season' | 'Other' = 'Other';
  const rawItemType = (payload.ItemType ?? '').toLowerCase();
  if (rawItemType === 'episode') {
    itemType = 'Episode';
  } else if (rawItemType === 'movie') {
    itemType = 'Movie';
  } else if (rawItemType === 'series') {
    itemType = 'Series';
  } else if (rawItemType === 'season') {
    itemType = 'Season';
  }

  const itemId = payload.ItemId;
  const name = payload.Name ?? '';
  const seriesName = payload.SeriesName;
  const seriesId = payload.SeriesId;

  const rawLibrary =
    payload.LibraryName ?? payload.Library ?? payload.CollectionName ?? payload.Series_LibraryName;
  const libraryName = rawLibrary && rawLibrary.toLowerCase() !== 'root' ? rawLibrary : undefined;

  const path = payload.Path ?? payload.ItemPath;

  const seasonNumber =
    payload.SeasonNumber !== undefined
      ? Number(payload.SeasonNumber)
      : payload.ParentIndexNumber !== undefined
        ? Number(payload.ParentIndexNumber)
        : undefined;

  const episodeNumber =
    payload.EpisodeNumber !== undefined
      ? Number(payload.EpisodeNumber)
      : payload.IndexNumber !== undefined
        ? Number(payload.IndexNumber)
        : undefined;

  const episodeNumberEnd =
    payload.EpisodeNumberEnd !== undefined
      ? Number(payload.EpisodeNumberEnd)
      : payload.IndexNumberEnd !== undefined
        ? Number(payload.IndexNumberEnd)
        : undefined;

  const year = payload.Year !== undefined ? Number(payload.Year) : undefined;

  const playbackPositionTicks = Number(payload.PlaybackPositionTicks ?? 0);
  const runTimeTicks = Number(payload.RunTimeTicks ?? 0);

  let progressPercentage = 0;
  if (runTimeTicks > 0) {
    progressPercentage = (playbackPositionTicks / runTimeTicks) * 100;
  } else if (payload.Played === true) {
    progressPercentage = 100;
  }

  const isCompleted =
    progressPercentage >= 80 ||
    payload.Played === true ||
    payload.SaveReason === 'PlaybackFinished';

  const providerIds: Record<string, string | undefined> = {};
  const seriesProviderIds: Record<string, string | undefined> = {};

  // 1. Check nested ProviderIds if provided
  const rawProviderIds = payload.ProviderIds ?? (payload.Item as any)?.ProviderIds;
  if (typeof rawProviderIds === 'object' && rawProviderIds !== null) {
    for (const [k, v] of Object.entries(rawProviderIds)) {
      if (v) providerIds[k.toLowerCase()] = String(v);
    }
  }

  // 2. Check nested SeriesProviderIds if provided
  const rawSeriesProviderIds =
    payload.SeriesProviderIds ??
    (payload.Series as any)?.ProviderIds ??
    (payload.Series as any)?.SeriesProviderIds ??
    (payload.Item as any)?.SeriesProviderIds;

  if (typeof rawSeriesProviderIds === 'object' && rawSeriesProviderIds !== null) {
    for (const [k, v] of Object.entries(rawSeriesProviderIds)) {
      if (v) seriesProviderIds[k.toLowerCase()] = String(v);
    }
  }

  // 3. Scan flat keys (e.g. Provider_tvdb, Series_Provider_tvdb, Series_tvdb)
  for (const [key, value] of Object.entries(payload)) {
    if (!value || typeof value === 'object') continue;
    const strVal = String(value);
    const lowerKey = key.toLowerCase();

    // Series-level IDs
    if (lowerKey.startsWith('series_provider_')) {
      const provider = lowerKey.slice('series_provider_'.length);
      seriesProviderIds[provider] = strVal;
    } else if (lowerKey.startsWith('series_') && lowerKey.includes('provider_')) {
      const provider = lowerKey.split('provider_')[1];
      if (provider) seriesProviderIds[provider] = strVal;
    } else if (
      lowerKey === 'series_tvdb' ||
      lowerKey === 'seriestvdb' ||
      lowerKey === 'seriestvdbid'
    ) {
      seriesProviderIds['tvdb'] = strVal;
    } else if (
      lowerKey === 'series_tmdb' ||
      lowerKey === 'seriestmdb' ||
      lowerKey === 'seriestmdbid'
    ) {
      seriesProviderIds['tmdb'] = strVal;
    } else if (
      lowerKey === 'series_imdb' ||
      lowerKey === 'seriesimdb' ||
      lowerKey === 'seriesimdbid'
    ) {
      seriesProviderIds['imdb'] = strVal;
    }

    // Episode/Movie-level IDs
    if (lowerKey.startsWith('provider_')) {
      const provider = lowerKey.slice('provider_'.length);
      providerIds[provider] = strVal;
    } else if (lowerKey === 'tvdb' || lowerKey === 'tvdbid') {
      providerIds['tvdb'] = strVal;
    } else if (lowerKey === 'tmdb' || lowerKey === 'tmdbid') {
      providerIds['tmdb'] = strVal;
    } else if (lowerKey === 'imdb' || lowerKey === 'imdbid') {
      providerIds['imdb'] = strVal;
    }
  }

  if (itemType === 'Series') {
    for (const [k, v] of Object.entries(providerIds)) {
      if (v && !seriesProviderIds[k]) {
        seriesProviderIds[k] = v;
      }
    }
  }

  return {
    notificationType,
    username,
    itemType,
    itemId,
    name,
    seriesName,
    seriesId,
    seasonNumber,
    episodeNumber,
    episodeNumberEnd,
    year,
    libraryName,
    path,
    playbackPositionTicks,
    runTimeTicks,
    progressPercentage,
    isCompleted,
    providerIds,
    seriesProviderIds,
  };
};
