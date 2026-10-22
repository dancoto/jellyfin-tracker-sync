import { getAniListUserToken } from './anilist/auth';
import {
  defaultJellyfinClient,
  isAnimeLibrary,
  isExcludedLibrary,
  isPrivateAnimeLibrary,
  normalizeJellyfinWebhook,
  type RawJellyfinPayload,
} from './jellyfin';
import { enqueueSeriesSync } from './overrides/series-debouncer';
import { logger } from './shared/logger';
import { getOrRefreshUserToken } from './simkl/auth';
import { checkAnimeMissingMappings } from './webhook/alerts';
import { checkIfAnimeFallback, processAnimeScrobble } from './webhook/anime-pipeline';
import { processStandardScrobble } from './webhook/standard-pipeline';

export { checkAnimeMissingMappings, clearNotificationCooldowns, notifiedAnimeCooldown } from './webhook/alerts';

export const handleWebhook = async (
  rawPayload: RawJellyfinPayload,
  options?: { debounceMs?: number; customCatalogPath?: string; customOverridesPath?: string },
) => {
  const event = normalizeJellyfinWebhook(rawPayload);

  logger.info(
    `[Webhook] Received "${event.notificationType}" for user "${event.username || 'unknown'}": ${event.seriesName ? `${event.seriesName} - ` : ''}${event.name} (Progress: ${Math.round(event.progressPercentage)}%)`,
  );
  logger.debug('[Webhook] Raw payload keys:', Object.keys(rawPayload));
  logger.debug('[Webhook] Full payload:', JSON.stringify(rawPayload, null, 2));
  logger.debug('[Webhook] Normalized event:', {
    notificationType: event.notificationType,
    username: event.username,
    itemType: event.itemType,
    seriesName: event.seriesName,
    seasonNumber: event.seasonNumber,
    episodeNumber: event.episodeNumber,
    libraryName: event.libraryName,
    isCompleted: event.isCompleted,
    providerIds: event.providerIds,
    seriesProviderIds: event.seriesProviderIds,
  });

  // 1. Determine library name and ensure provider IDs are loaded before anime fallback check
  let libraryName = event.libraryName;
  if (!libraryName || libraryName.toLowerCase() === 'root') {
    libraryName =
      (await defaultJellyfinClient.getLibraryName(event.seriesId ?? event.itemId)) ?? undefined;
  }

  // 1b. Explicitly exclude libraries configured/defaulted to be excluded from sync
  if (libraryName && isExcludedLibrary(libraryName)) {
    logger.info(
      `[Webhook] Library "${libraryName}" is explicitly excluded from sync. Skipping event for "${event.name}".`,
    );
    return;
  }

  // Pre-fetch provider IDs from Jellyfin API if missing from webhook body
  if (
    (event.itemType === 'Episode' || event.itemType === 'Series') &&
    (event.seriesId || event.itemId)
  ) {
    const targetId = event.itemType === 'Episode' ? event.seriesId! : event.itemId!;
    if (!event.seriesProviderIds.tvdb && !event.seriesProviderIds.tmdb) {
      logger.debug(`Querying series provider IDs from Jellyfin API for ${targetId}...`);
      const fetched = await defaultJellyfinClient.getSeriesProviderIds(targetId);
      if (fetched) {
        event.seriesProviderIds = { ...event.seriesProviderIds, ...fetched };
      }
    }
  } else if (event.itemType === 'Movie' && event.itemId) {
    if (!event.providerIds.tmdb && !event.providerIds.imdb && !event.providerIds.tvdb) {
      logger.debug(`Querying movie provider IDs from Jellyfin API for ${event.itemId}...`);
      const fetched = await defaultJellyfinClient.getSeriesProviderIds(event.itemId);
      if (fetched) {
        event.providerIds = { ...event.providerIds, ...fetched };
      }
    }
  }

  const isPrivate = (libraryName && isPrivateAnimeLibrary(libraryName)) || false;
  const isAnime = (libraryName && isAnimeLibrary(libraryName)) || checkIfAnimeFallback(event);

  // 2. Handle ItemAdded: Continuous Sync (Server-level event, no user scrobbler token required)
  const isItemAdded = (event.notificationType ?? '').toLowerCase() === 'itemadded';
  if (isItemAdded) {
    // Only Episodes, Series, and Movies can be synced into the catalog.
    // Explicitly ignore Seasons, Folders, Collections, etc.
    if (event.itemType !== 'Episode' && event.itemType !== 'Series' && event.itemType !== 'Movie') {
      logger.debug(
        `[Webhook] ItemAdded received for non-catalogable itemType "${event.itemType}" ("${event.name}"). Skipping continuous sync.`,
      );
      return;
    }

    if (isAnime) {
      const tvdbId =
        event.itemType === 'Movie'
          ? event.providerIds.tvdb
          : (event.seriesProviderIds.tvdb ?? (event.itemType === 'Series' ? event.providerIds.tvdb : undefined));
      const jellyfinSeriesId =
        event.itemType === 'Episode' ? event.seriesId : event.itemId;
      const seriesTitle = event.seriesName ?? event.name;

      logger.info(
        `[Webhook] ItemAdded received for anime ${event.itemType} "${seriesTitle}" (TVDB: ${tvdbId ?? 'unknown'}, JF ID: ${jellyfinSeriesId ?? 'unknown'}). Queuing series sync...`,
      );

      enqueueSeriesSync({
        tvdbId,
        jellyfinSeriesId,
        seriesName: seriesTitle,
        itemType: event.itemType,
        libraryName,
        debounceMs: options?.debounceMs,
        customCatalogPath: options?.customCatalogPath,
        customOverridesPath: options?.customOverridesPath,
      });
    } else {
      logger.debug(
        `[Webhook] ItemAdded received for non-anime item "${event.seriesName ?? event.name}" in library "${libraryName}". Skipping continuous sync.`,
      );
    }
    return;
  }

  // 3. Ensure user has valid token (Simkl and/or AniList) for playback scrobbling
  let simklToken: string | null = null;
  try {
    simklToken = await getOrRefreshUserToken(event.username);
  } catch (err) {
    logger.warn(`Failed to retrieve Simkl token for "${event.username}":`, err);
  }

  let anilistToken: string | null = null;
  try {
    anilistToken = getAniListUserToken(event.username);
  } catch (err) {
    logger.warn(`Failed to retrieve AniList token for "${event.username}":`, err);
  }

  if (!simklToken && !anilistToken) {
    logger.warn(
      `User "${event.username}" has no configured Simkl or AniList token. Nothing will be synced.`,
    );
    return;
  }

  // 3b. Handle PlaybackStart: immediately catch and alert on missing anime mappings
  const isPlaybackStart = (event.notificationType ?? '').toLowerCase() === 'playbackstart';
  if (isPlaybackStart) {
    if (isAnime) {
      logger.info(
        `[Webhook] PlaybackStart received for anime "${event.seriesName ?? event.name}". Checking for missing mappings...`,
      );
      checkAnimeMissingMappings(event);
    }
    logger.debug(`[Webhook] PlaybackStart event processed. No scrobble queued.`);
    return;
  }

  // 4. Only scrobble on completion (>= 80% progress or marked played)
  if (!event.isCompleted) {
    logger.debug(
      `[Webhook] Event "${event.notificationType}" does not meet completion threshold (progress: ${Math.round(event.progressPercentage)}% < 80%, played: ${Boolean(event.isCompleted)}). No scrobble queued.`,
    );
    return;
  }

  logger.info(`Processing playback completion for user "${event.username}": ${event.name}`);

  const routeLabel = isAnime ? 'Anime' : 'Standard/Non-Anime';
  logger.info(`Library: "${libraryName ?? 'Unknown'}" -> Routing to ${routeLabel} pipeline.`);

  if (isAnime) {
    await processAnimeScrobble(
      event,
      { simklToken, anilistToken },
      { isPrivate, libraryName },
      options,
    );
  } else {
    await processStandardScrobble(event, simklToken, options);
  }
};
