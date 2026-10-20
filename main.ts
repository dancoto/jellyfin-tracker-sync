import { defaultAnimeResolver } from './anime';
import { getAniListUserToken } from './anilist/auth';
import { enqueueAniListScrobble } from './anilist/scrobbler';
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
import { sendNotification } from './ntfy';
import { getOrRefreshUserToken } from './simkl/auth';
import { enqueueScrobble } from './simkl/batcher';

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

  // 3. Handle PlaybackStart: immediately catch and alert on missing anime mappings
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
    // === ANIME PIPELINE ===
    if (event.itemType === 'Episode') {
      if (event.seasonNumber === undefined || event.episodeNumber === undefined) {
        logger.warn('Episode event is missing season or episode number.');
        return;
      }

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
    } else if (event.itemType === 'Movie') {
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
    }
  } else {
    // === NON-ANIME / STANDARD MEDIA PIPELINE ===
    if (simklToken) {
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
    }
  }
};

const enqueueStandardMovie = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  userToken: string,
  options?: { debounceMs?: number },
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

const enqueueStandardEpisode = async (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  userToken: string,
  episodeNumber: number,
  options?: { debounceMs?: number },
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

const checkIfAnimeFallback = (event: ReturnType<typeof normalizeJellyfinWebhook>): boolean => {
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

const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per series
export const notifiedAnimeCooldown = new Map<string, number>();

export const clearNotificationCooldowns = (): void => {
  notifiedAnimeCooldown.clear();
};

const handleMissingAnimeMapping = (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  tvdbId: string | undefined,
  seasonNumber: number,
  episodeNumber: number,
  hasAniList: boolean,
  resolved: ReturnType<typeof defaultAnimeResolver.resolveEpisode>,
): void => {
  if (hasAniList || resolved?.skipAniList) return;

  const seriesTitle = event.seriesName ?? event.name;
  let actionNotice = '';

  const tmdbId = event.seriesProviderIds?.tmdb ?? event.providerIds?.tmdb;
  const jfId = event.seriesId ?? event.itemId;
  const effectiveKey = tvdbId
    ? String(tvdbId).trim()
    : tmdbId
      ? `tmdb-${String(tmdbId).trim()}`
      : jfId
        ? `jf-${String(jfId).trim()}`
        : undefined;

  if (effectiveKey) {
    const overrideResult = defaultAnimeResolver.ensureShowInOverrides({
      tvdbId: effectiveKey,
      title: seriesTitle,
      tmdbId: event.seriesProviderIds?.tmdb ?? event.providerIds?.tmdb,
      seasonNumber,
      episodeNumber,
      episodeName: episodeNumber === event.episodeNumber ? event.name : `Episode ${episodeNumber}`,
      anilistId: resolved?.anilist?.mediaId ?? null,
      anilistEpisode: resolved?.anilist?.episodeNumber ?? null,
    });

    if (overrideResult.added) {
      actionNotice = `\nAdded to mapping-overrides.json (${overrideResult.reason.replace('_', ' ')})`;
      logger.info(
        `[Overrides] Added unmapped anime "${seriesTitle}" (${effectiveKey}) to mapping overrides file.`,
      );
    } else if (overrideResult.reason === 'already_exists') {
      actionNotice = '\nAlready in mapping-overrides.json';
    }
  } else {
    logger.warn(
      `[Overrides] Anime "${seriesTitle}" is missing TVDB and fallback IDs in Jellyfin. Cannot add to TVDB overrides.`,
    );
  }

  const cooldownKey = effectiveKey ?? seriesTitle;
  const lastNotified = notifiedAnimeCooldown.get(cooldownKey) ?? 0;
  const now = Date.now();

  if (now - lastNotified > NOTIFICATION_COOLDOWN_MS) {
    notifiedAnimeCooldown.set(cooldownKey, now);
    sendNotification({
      title: `Missing Anime Mapping: ${seriesTitle}`,
      message: `Show: ${seriesTitle}\nEpisode: S${seasonNumber}E${episodeNumber}\nTVDB: ${tvdbId ?? 'Not found in Jellyfin'}\nMissing: AniList${actionNotice}`,
      priority: 4,
    });
  }
};

const handleMissingAnimeMovieMapping = (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
  tvdbId: string | undefined,
  hasAniList: boolean,
  resolved: ReturnType<typeof defaultAnimeResolver.resolveMovie>,
): void => {
  if (hasAniList) return;

  let actionNotice = '';
  const tmdbId = event.providerIds?.tmdb;
  const jfId = event.itemId;
  const effectiveKey = tvdbId
    ? String(tvdbId).trim()
    : tmdbId
      ? `tmdb-${String(tmdbId).trim()}`
      : jfId
        ? `jf-${String(jfId).trim()}`
        : undefined;

  if (effectiveKey) {
    const overrideResult = defaultAnimeResolver.ensureShowInOverrides({
      tvdbId: effectiveKey,
      title: event.name,
      tmdbId: event.providerIds?.tmdb,
      seasonNumber: 0,
      episodeNumber: 1,
      episodeName: event.name,
      anilistId: resolved?.anilist?.mediaId ?? null,
      anilistEpisode: resolved?.anilist?.episodeNumber ?? null,
    });

    if (overrideResult.added) {
      actionNotice = `\nAdded to mapping-overrides.json (${overrideResult.reason.replace('_', ' ')})`;
      logger.info(
        `[Overrides] Added unmapped anime movie "${event.name}" (${effectiveKey}) to mapping overrides file.`,
      );
    } else if (overrideResult.reason === 'already_exists') {
      actionNotice = '\nAlready in mapping-overrides.json';
    }
  } else {
    logger.warn(
      `[Overrides] Anime movie "${event.name}" is missing TVDB and fallback IDs in Jellyfin. Cannot add to TVDB overrides.`,
    );
  }

  const cooldownKey = effectiveKey ?? event.name;
  const lastNotified = notifiedAnimeCooldown.get(cooldownKey) ?? 0;
  const now = Date.now();

  if (now - lastNotified > NOTIFICATION_COOLDOWN_MS) {
    notifiedAnimeCooldown.set(cooldownKey, now);
    sendNotification({
      title: `Missing Anime Movie Mapping: ${event.name}`,
      message: `Movie: ${event.name}\nTVDB: ${tvdbId ?? 'Not found in Jellyfin'}\nTMDB: ${event.providerIds?.tmdb ?? 'None'}\nMissing: AniList${actionNotice}`,
      priority: 4,
    });
  }
};

export const checkAnimeMissingMappings = (
  event: ReturnType<typeof normalizeJellyfinWebhook>,
): void => {
  if (event.itemType === 'Episode') {
    if (event.seasonNumber === undefined || event.episodeNumber === undefined) {
      logger.warn('Episode event is missing season or episode number.');
      return;
    }

    const seriesProviderIds = event.seriesProviderIds;
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
    }
  } else if (event.itemType === 'Movie') {
    const resolved = defaultAnimeResolver.resolveMovie({
      tmdbId: event.providerIds.tmdb,
      imdbId: event.providerIds.imdb,
      tvdbId: event.providerIds.tvdb,
      anilistId: event.providerIds.anilist,
    });

    const hasAniList = Boolean(resolved?.anilist?.mediaId);

    if (!hasAniList) {
      handleMissingAnimeMovieMapping(event, event.providerIds.tvdb, hasAniList, resolved);
    }
  }
};
