import { defaultJellyfinClient, type normalizeJellyfinWebhook } from '../jellyfin';
import { logger } from '../shared/logger';
import { enqueueScrobble } from '../simkl/batcher';

export interface StandardScrobbleOptions {
  debounceMs?: number;
}

export const enqueueStandardMovie = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  userToken: string,
  options?: StandardScrobbleOptions,
): Promise<void> => {
  let providerIds = { ...event.providerIds };
  if (!providerIds.tmdb && !providerIds.imdb && !providerIds.tvdb && event.itemId) {
    logger.debug(`Querying movie provider IDs from Jellyfin API for ${event.itemId}...`);
    const fetched = await defaultJellyfinClient.getSeriesProviderIds(event.itemId);
    if (fetched) {
      providerIds = { ...providerIds, ...fetched };
      event.providerIds = providerIds;
    }
  }

  logger.info(`Scrobbling standard movie "${event.name}" to Simkl.`);
  logger.debug('Movie IDs:', event.providerIds);

  await enqueueScrobble(
    event.username,
    userToken,
    {
      kind: 'standard_movie',
      name: event.name,
      ids: {
        tmdb: event.providerIds.tmdb,
        imdb: event.providerIds.imdb,
        tvdb: event.providerIds.tvdb,
      },
    },
    options,
  );
};

export const enqueueStandardEpisode = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  userToken: string,
  episodeNumber: number,
  options?: StandardScrobbleOptions,
): Promise<void> => {
  let seriesProviderIds = { ...event.seriesProviderIds };
  if (
    !seriesProviderIds.tvdb &&
    !seriesProviderIds.tmdb &&
    !seriesProviderIds.imdb &&
    event.seriesId
  ) {
    logger.debug(
      `Querying standard series provider IDs from Jellyfin API for ${event.seriesId}...`,
    );
    const fetched = await defaultJellyfinClient.getSeriesProviderIds(event.seriesId);
    if (fetched) {
      seriesProviderIds = { ...seriesProviderIds, ...fetched };
    }
  }

  event.seriesProviderIds = seriesProviderIds;
  logger.info(
    `Scrobbling standard series "${event.seriesName ?? event.name}" (S${event.seasonNumber ?? 1}E${episodeNumber}) to Simkl.`,
  );
  logger.debug('Standard series IDs:', event.seriesProviderIds);

  await enqueueScrobble(
    event.username,
    userToken,
    {
      kind: 'standard_episode',
      seriesName: event.seriesName,
      seasonNumber: event.seasonNumber ?? 1,
      episodeNumber,
      ids: {
        tvdb: event.seriesProviderIds.tvdb,
        tmdb: event.seriesProviderIds.tmdb,
        imdb: event.seriesProviderIds.imdb,
      },
      episodeName: episodeNumber === event.episodeNumber ? event.name : `Episode ${episodeNumber}`,
    },
    options,
  );
};

export const processStandardScrobble = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  simklToken: string | null,
  options?: StandardScrobbleOptions,
): Promise<void> => {
  if (!simklToken) return;

  if (event.itemType === 'Episode') {
    const startEp = event.episodeNumber ?? 1;
    const endEp =
      event.episodeNumberEnd && event.episodeNumberEnd >= startEp
        ? event.episodeNumberEnd
        : startEp;

    for (let ep = startEp; ep <= endEp; ep++) {
      await enqueueStandardEpisode(event, simklToken, ep, options);
    }
  } else if (event.itemType === 'Movie') {
    await enqueueStandardMovie(event, simklToken, options);
  }
};
