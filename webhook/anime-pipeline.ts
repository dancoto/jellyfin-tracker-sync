import { defaultAnimeResolver } from '../anime';
import { enqueueAniListScrobble } from '../anilist/scrobbler';
import { type normalizeJellyfinWebhook } from '../jellyfin';
import { logger } from '../shared/logger';
import { enqueueScrobble } from '../simkl/batcher';
import { handleMissingAnimeMapping, handleMissingAnimeMovieMapping } from './alerts';
import { enqueueStandardEpisode, enqueueStandardMovie } from './standard-pipeline';

export interface AnimePipelineOptions {
  debounceMs?: number;
  customCatalogPath?: string;
  customOverridesPath?: string;
}

export interface AnimePipelineContext {
  isPrivate: boolean;
  libraryName?: string;
}

export interface ScrobbleTokens {
  simklToken: string | null;
  anilistToken: string | null;
}

export const checkIfAnimeFallback = (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
): boolean => {
  // Check if provider IDs or series match AniBridge
  if (event.itemType === 'Episode') {
    const match = defaultAnimeResolver.resolveEpisode(
      {
        tvdbId: event.seriesProviderIds.tvdb,
        tmdbId: event.seriesProviderIds.tmdb,
        anilistId: event.seriesProviderIds.anilist ?? event.providerIds.anilist,
        jellyfinSeriesId: event.seriesId ?? event.itemId,
      },
      event.seasonNumber ?? 1,
      event.episodeNumber ?? 1,
    );
    return match !== null;
  }
  if (event.itemType === 'Movie') {
    const match = defaultAnimeResolver.resolveMovie({
      tmdbId: event.providerIds.tmdb,
      imdbId: event.providerIds.imdb,
      tvdbId: event.providerIds.tvdb,
      anilistId: event.providerIds.anilist,
      jellyfinSeriesId: event.itemId,
    });
    return match !== null;
  }
  return false;
};

export const processAnimeEpisodeScrobble = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  tokens: ScrobbleTokens,
  context: AnimePipelineContext,
  options?: AnimePipelineOptions,
): Promise<void> => {
  if (event.seasonNumber === undefined || event.episodeNumber === undefined) {
    logger.warn('Episode event is missing season or episode number.');
    return;
  }

  const { simklToken, anilistToken } = tokens;
  const { isPrivate, libraryName } = context;
  const seriesProviderIds = event.seriesProviderIds;
  logger.debug(
    `Series Provider IDs for "${event.seriesName ?? event.name}":`,
    seriesProviderIds,
  );

  const startEp = event.episodeNumber;
  const endEp =
    event.episodeNumberEnd && event.episodeNumberEnd >= startEp
      ? event.episodeNumberEnd
      : startEp;

  for (let ep = startEp; ep <= endEp; ep++) {
    const resolved = defaultAnimeResolver.resolveEpisode(
      {
        tvdbId: seriesProviderIds.tvdb,
        tmdbId: seriesProviderIds.tmdb,
        anilistId: seriesProviderIds.anilist ?? event.providerIds.anilist,
        jellyfinSeriesId: event.seriesId ?? event.itemId,
      },
      event.seasonNumber,
      ep,
    );

    const hasAniList = Boolean(resolved?.anilist?.mediaId);

    if (!hasAniList && !resolved?.skipAniList) {
      handleMissingAnimeMapping(
        event,
        seriesProviderIds.tvdb,
        event.seasonNumber,
        ep,
        hasAniList,
        resolved,
      );
    }

    // 1. Simkl scrobbling
    if (simklToken) {
      if (isPrivate) {
        logger.info(
          `[Simkl] Skipping anime episode "${event.seriesName ?? event.name}" (S${event.seasonNumber}E${ep}) - Item belongs to private anime library "${libraryName}".`,
        );
      } else {
        const isSpecial = event.seasonNumber === 0 || resolved?.isSpecial;
        if (isSpecial) {
          logger.info(
            `[Simkl] Skipping anime special "${event.seriesName ?? event.name}" (S0E${ep}) - Anime specials are excluded from Simkl to prevent mis-scrobbles.`,
          );
        } else if (hasAniList && !resolved?.skipAniList) {
          console.log(
            `Mapped anime "${event.seriesName ?? event.name}" S${event.seasonNumber}E${ep} -> AniList ${resolved!.anilist!.mediaId} Ep ${resolved!.anilist!.episodeNumber} (${resolved!.source})`,
          );

          try {
            await enqueueScrobble(
              event.username,
              simklToken,
              {
                kind: 'anime_episode',
                anilistId: resolved!.anilist!.mediaId,
                anilistEpisode: resolved!.anilist!.episodeNumber,
                episodeNumber: ep,
                isSpecial: false,
                seriesName: event.seriesName,
                episodeName: ep === startEp ? event.name : `Episode ${ep}`,
                tvdbId: seriesProviderIds.tvdb,
                tmdbId: seriesProviderIds.tmdb,
                seasonNumber: event.seasonNumber,
              },
              options,
            );
          } catch (err) {
            logger.error(
              `[Simkl] Failed to enqueue scrobble for anime episode "${event.name}":`,
              err,
            );
          }
        } else if (!resolved?.isSkipped) {
          // Fallback for Simkl: No AniList ID, try TVDB/TMDB (only for regular seasons)
          console.log(
            `No AniList mapping found for anime "${event.seriesName ?? event.name}" (S${event.seasonNumber}E${ep}). Falling back to standard non-anime pipeline for Simkl.`,
          );
          await enqueueStandardEpisode(event, simklToken, ep, options);
        }
      }
    }

    // 2. AniList scrobbling
    if (anilistToken && !resolved?.skipAniList && !resolved?.isSkipped) {
      try {
        if (resolved?.anilist) {
          await enqueueAniListScrobble(
            event.username,
            anilistToken,
            {
              mediaId: resolved.anilist.mediaId,
              episodeNumber: resolved.anilist.episodeNumber,
              isMovie: false,
              title: event.seriesName ?? event.name,
              isPrivate,
            },
            options,
          );
        } else {
          logger.info(
            `[AniList] No matching AniList mapping found for anime "${event.seriesName ?? event.name}". Skipping AniList scrobble.`,
          );
        }
      } catch (err) {
        logger.error(
          `[AniList] Failed to enqueue scrobble for anime episode "${event.name}":`,
          err,
        );
      }
    }
  }
};

export const processAnimeMovieScrobble = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  tokens: ScrobbleTokens,
  context: AnimePipelineContext,
  options?: AnimePipelineOptions,
): Promise<void> => {
  const { simklToken, anilistToken } = tokens;
  const { isPrivate, libraryName } = context;

  const resolved = defaultAnimeResolver.resolveMovie({
    tmdbId: event.providerIds.tmdb,
    imdbId: event.providerIds.imdb,
    tvdbId: event.providerIds.tvdb,
    anilistId: event.providerIds.anilist,
    jellyfinSeriesId: event.itemId,
  });

  const hasAniList = Boolean(resolved?.anilist?.mediaId);

  if (!hasAniList) {
    handleMissingAnimeMovieMapping(event, event.providerIds.tvdb, hasAniList, resolved);
  }

  // 1. Simkl scrobbling
  if (simklToken) {
    if (isPrivate) {
      logger.info(
        `[Simkl] Skipping anime movie "${event.name}" - Item belongs to private anime library "${libraryName}".`,
      );
    } else if (resolved?.anilist?.mediaId) {
      logger.info(
        `Mapped anime movie "${event.name}" -> AniList ${resolved.anilist.mediaId} (${resolved.source})`,
      );
      try {
        await enqueueScrobble(
          event.username,
          simklToken,
          {
            kind: 'anime_movie',
            anilistId: resolved.anilist.mediaId,
            name: event.name,
            tmdbId: event.providerIds.tmdb,
            tvdbId: event.providerIds.tvdb,
          },
          options,
        );
      } catch (err) {
        logger.error(
          `[Simkl] Failed to enqueue scrobble for anime movie "${event.name}":`,
          err,
        );
      }
    } else {
      logger.info(
        `No AniList mapping found for anime movie "${event.name}". Falling back to standard movie pipeline with TMDB/IMDb/TVDB IDs for Simkl.`,
      );
      try {
        await enqueueStandardMovie(event, simklToken, options);
      } catch (err) {
        logger.error(`[Simkl] Failed to enqueue movie "${event.name}":`, err);
      }
    }
  }

  // 2. AniList scrobbling
  if (anilistToken) {
    if (resolved?.anilist) {
      try {
        await enqueueAniListScrobble(
          event.username,
          anilistToken,
          {
            mediaId: resolved.anilist.mediaId,
            episodeNumber: 1,
            isMovie: true,
            title: event.name,
            isPrivate,
          },
          options,
        );
      } catch (err) {
        logger.error(
          `[AniList] Failed to enqueue scrobble for anime movie "${event.name}":`,
          err,
        );
      }
    } else {
      logger.info(
        `[AniList] No matching AniList mapping found for anime movie "${event.name}". Skipping AniList scrobble.`,
      );
    }
  }
};

export const processAnimeScrobble = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  tokens: ScrobbleTokens,
  context: AnimePipelineContext,
  options?: AnimePipelineOptions,
): Promise<void> => {
  if (event.itemType === 'Episode') {
    await processAnimeEpisodeScrobble(event, tokens, context, options);
  } else if (event.itemType === 'Movie') {
    await processAnimeMovieScrobble(event, tokens, context, options);
  }
};
