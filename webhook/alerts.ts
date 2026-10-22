import { defaultAnimeResolver } from '../anime';
import { type normalizeJellyfinWebhook } from '../jellyfin';
import { logger } from '../shared/logger';
import { sendNotification } from '../ntfy';

const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per series
export const notifiedAnimeCooldown = new Map<string, number>();

export const clearNotificationCooldowns = (): void => {
  notifiedAnimeCooldown.clear();
};

export const handleMissingAnimeMapping = (
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

export const handleMissingAnimeMovieMapping = (
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
