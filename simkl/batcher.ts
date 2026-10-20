import { sendNotification } from '../ntfy';
import { appConfig } from '../shared/config';
import { logger } from '../shared/logger';
import type { SyncResponse } from './models';

export type ScrobbleQueueItem =
  | {
      kind: 'anime_episode';
      anilistId?: number;
      anilistEpisode?: number;
      episodeNumber: number;
      isSpecial: boolean;
      seriesName?: string;
      episodeName?: string;
      tvdbId?: string;
      tmdbId?: string;
      seasonNumber?: number;
    }
  | {
      kind: 'anime_movie';
      anilistId?: number;
      name: string;
      tmdbId?: string;
      tvdbId?: string;
    }
  | {
      kind: 'standard_episode';
      seriesName?: string;
      seasonNumber: number;
      episodeNumber: number;
      ids: {
        tvdb?: string;
        tmdb?: string;
        imdb?: string;
      };
      episodeName?: string;
      isSpecial?: boolean;
    }
  | {
      kind: 'standard_movie';
      name: string;
      ids: {
        tmdb?: string;
        imdb?: string;
        tvdb?: string;
      };
    };

export interface SyncPayload {
  movies?: Array<{
    title?: string;
    ids: Record<string, any>;
    status: 'completed';
  }>;
  shows?: Array<{
    title?: string;
    ids: Record<string, any>;
    seasons: Array<{
      number: number;
      episodes: Array<{ number: number }>;
    }>;
  }>;
  anime?: Array<{
    title?: string;
    ids: Record<string, any>;
    episodes: Array<{ number: number }>;
  }>;
}

export interface NotFoundMeta {
  id: string;
  title: string;
  link: string;
  mediaType: string;
  isAnime: boolean;
  isSpecial?: boolean;
}

/**
 * Consolidates queued items into an aggregated Simkl /sync/history payload,
 * grouping episodes by show and season.
 */
export const buildSyncPayload = (
  items: ScrobbleQueueItem[],
): { payload: SyncPayload; notFoundMap: Map<string, NotFoundMeta> } => {
  const notFoundMap = new Map<string, NotFoundMeta>();

  // Map of showKey -> { title?, ids, seasons: Map<seasonNumber, Set<episodeNumber>> }
  const showsMap = new Map<
    string,
    {
      title?: string;
      ids: Record<string, any>;
      seasons: Map<number, Set<number>>;
    }
  >();

  // Map of animeKey -> { title?, ids, episodes: Set<episodeNumber> }
  const animeMap = new Map<
    string,
    {
      title?: string;
      ids: Record<string, any>;
      episodes: Set<number>;
    }
  >();

  // Map of movieKey -> { title?: string, ids: Record<string, any> }
  const moviesMap = new Map<string, { title?: string; ids: Record<string, any> }>();

  for (const item of items) {
    if (item.kind === 'anime_episode') {
      if (item.isSpecial || item.seasonNumber === 0) {
        logger.debug(
          `[Simkl Batcher] Skipping anime special "${item.seriesName ?? item.episodeName}" (S0E${item.episodeNumber}) - anime specials excluded from Simkl.`,
        );
        continue;
      }
      if (item.anilistId) {
        const animeKey = `anilist:${item.anilistId}`;
        let animeEntry = animeMap.get(animeKey);
        if (!animeEntry) {
          const ids: Record<string, any> = { anilist: String(item.anilistId) };
          if (item.tvdbId) ids.tvdb = item.tvdbId;
          if (item.tmdbId) ids.tmdb = item.tmdbId;
          animeEntry = {
            title: item.seriesName,
            ids,
            episodes: new Set(),
          };
          animeMap.set(animeKey, animeEntry);
        }
        animeEntry.episodes.add(item.anilistEpisode ?? item.episodeNumber);

        const meta: NotFoundMeta = {
          id: String(item.anilistId),
          title: item.seriesName
            ? `${item.seriesName} - ${item.episodeName}`
            : (item.episodeName ?? 'Anime'),
          link: `https://anilist.co/anime/${item.anilistId}`,
          mediaType: 'anime series',
          isAnime: true,
          isSpecial: item.isSpecial,
        };
        notFoundMap.set(String(item.anilistId), meta);
        if (item.seriesName) notFoundMap.set(item.seriesName, meta);
        if (item.tvdbId) notFoundMap.set(item.tvdbId, meta);
      } else {
        const showKey = item.tvdbId
          ? `tvdb:${item.tvdbId}`
          : `title:${item.seriesName ?? 'unknown'}`;
        let showEntry = showsMap.get(showKey);
        if (!showEntry) {
          const ids: Record<string, any> = {};
          if (item.tvdbId) ids.tvdb = item.tvdbId;
          if (item.tmdbId) ids.tmdb = item.tmdbId;
          showEntry = {
            title: item.seriesName,
            ids,
            seasons: new Map(),
          };
          showsMap.set(showKey, showEntry);
        }

        const seasonNum = item.seasonNumber ?? (item.isSpecial ? 0 : 1);
        let episodesSet = showEntry.seasons.get(seasonNum);
        if (!episodesSet) {
          episodesSet = new Set();
          showEntry.seasons.set(seasonNum, episodesSet);
        }
        episodesSet.add(item.episodeNumber);

        const fallbackId = item.tvdbId ?? item.seriesName ?? 'unknown';
        const meta: NotFoundMeta = {
          id: fallbackId,
          title: item.seriesName
            ? `${item.seriesName} - ${item.episodeName}`
            : (item.episodeName ?? 'Anime'),
          link: item.tvdbId
            ? `https://thetvdb.com/dereferrer/series/${item.tvdbId}`
            : `https://simkl.com/search/?q=${encodeURIComponent(item.seriesName ?? item.episodeName ?? '')}`,
          mediaType: 'anime series',
          isAnime: true,
          isSpecial: item.isSpecial,
        };
        notFoundMap.set(fallbackId, meta);
        if (item.seriesName) notFoundMap.set(item.seriesName, meta);
        if (item.tvdbId) notFoundMap.set(item.tvdbId, meta);
      }
    } else if (item.kind === 'anime_movie') {
      const movieKey = item.anilistId
        ? `anilist:${item.anilistId}`
        : item.tmdbId
          ? `tmdb:${item.tmdbId}`
          : `title:${item.name}`;
      let movieEntry = moviesMap.get(movieKey);
      if (!movieEntry) {
        const ids: Record<string, any> = {};
        if (item.anilistId) ids.anilist = String(item.anilistId);
        if (item.tmdbId) ids.tmdb = item.tmdbId;
        if (item.tvdbId) ids.tvdb = item.tvdbId;
        moviesMap.set(movieKey, {
          title: item.name,
          ids,
        });
      }

      const id = item.anilistId ? String(item.anilistId) : (item.tmdbId ?? item.name);
      const meta: NotFoundMeta = {
        id,
        title: item.name,
        link: item.anilistId
          ? `https://anilist.co/anime/${item.anilistId}`
          : `https://simkl.com/search/?q=${encodeURIComponent(item.name)}`,
        mediaType: 'anime movie',
        isAnime: true,
        isSpecial: false,
      };
      notFoundMap.set(id, meta);
      if (item.name) notFoundMap.set(item.name, meta);
      if (item.tmdbId) notFoundMap.set(item.tmdbId, meta);
      if (item.tvdbId) notFoundMap.set(item.tvdbId, meta);
    } else if (item.kind === 'standard_episode') {
      const showKey =
        (item.ids.tvdb && `tvdb:${item.ids.tvdb}`) ||
        (item.ids.tmdb && `tmdb:${item.ids.tmdb}`) ||
        (item.ids.imdb && `imdb:${item.ids.imdb}`) ||
        `title:${item.seriesName ?? 'unknown'}`;

      let showEntry = showsMap.get(showKey);
      if (!showEntry) {
        const ids: Record<string, any> = {};
        if (item.ids.tvdb) ids.tvdb = item.ids.tvdb;
        if (item.ids.tmdb) ids.tmdb = item.ids.tmdb;
        if (item.ids.imdb) ids.imdb = item.ids.imdb;

        showEntry = {
          title: item.seriesName,
          ids,
          seasons: new Map(),
        };
        showsMap.set(showKey, showEntry);
      }

      let episodesSet = showEntry.seasons.get(item.seasonNumber);
      if (!episodesSet) {
        episodesSet = new Set();
        showEntry.seasons.set(item.seasonNumber, episodesSet);
      }
      episodesSet.add(item.episodeNumber);

      const fallbackId =
        item.ids.tvdb ?? item.ids.tmdb ?? item.ids.imdb ?? item.seriesName ?? 'unknown';
      const meta: NotFoundMeta = {
        id: fallbackId,
        title: item.seriesName
          ? `${item.seriesName} - ${item.episodeName}`
          : (item.episodeName ?? 'Series'),
        link: `https://simkl.com/search/?q=${encodeURIComponent(item.seriesName ?? item.episodeName ?? '')}`,
        mediaType: 'series',
        isAnime: false,
        isSpecial: item.isSpecial ?? item.seasonNumber === 0,
      };
      notFoundMap.set(fallbackId, meta);
      if (item.ids.tvdb) notFoundMap.set(item.ids.tvdb, meta);
      if (item.ids.tmdb) notFoundMap.set(item.ids.tmdb, meta);
      if (item.ids.imdb) notFoundMap.set(item.ids.imdb, meta);
      if (item.seriesName) notFoundMap.set(item.seriesName, meta);
    } else if (item.kind === 'standard_movie') {
      const movieKey =
        (item.ids.tmdb && `tmdb:${item.ids.tmdb}`) ||
        (item.ids.imdb && `imdb:${item.ids.imdb}`) ||
        (item.ids.tvdb && `tvdb:${item.ids.tvdb}`) ||
        `title:${item.name}`;

      if (!moviesMap.has(movieKey)) {
        const ids: Record<string, any> = {};
        if (item.ids.tmdb) ids.tmdb = item.ids.tmdb;
        if (item.ids.imdb) ids.imdb = item.ids.imdb;
        if (item.ids.tvdb) ids.tvdb = item.ids.tvdb;

        moviesMap.set(movieKey, {
          title: item.name,
          ids,
        });
      }

      const fallbackId = item.ids.tmdb ?? item.ids.imdb ?? item.ids.tvdb ?? item.name;
      const meta: NotFoundMeta = {
        id: fallbackId,
        title: item.name,
        link: `https://simkl.com/search/?q=${encodeURIComponent(item.name)}`,
        mediaType: 'movie',
        isAnime: false,
      };
      notFoundMap.set(fallbackId, meta);
      if (item.ids.tmdb) notFoundMap.set(item.ids.tmdb, meta);
      if (item.ids.imdb) notFoundMap.set(item.ids.imdb, meta);
      if (item.ids.tvdb) notFoundMap.set(item.ids.tvdb, meta);
      if (item.name) notFoundMap.set(item.name, meta);
    }
  }

  const payload: SyncPayload = {};

  if (moviesMap.size > 0) {
    payload.movies = Array.from(moviesMap.values()).map((m) => ({
      title: m.title,
      ids: m.ids,
      status: 'completed',
    }));
  }

  if (showsMap.size > 0) {
    payload.shows = Array.from(showsMap.values()).map((s) => {
      const seasons = Array.from(s.seasons.entries())
        .sort(([a], [b]) => a - b)
        .map(([seasonNum, eps]) => ({
          number: seasonNum,
          episodes: Array.from(eps)
            .sort((a, b) => a - b)
            .map((epNum) => ({ number: epNum })),
        }));

      return {
        title: s.title,
        ids: s.ids,
        seasons,
      };
    });
  }

  if (animeMap.size > 0) {
    payload.anime = Array.from(animeMap.values()).map((a) => ({
      title: a.title,
      ids: a.ids,
      episodes: Array.from(a.episodes)
        .sort((a, b) => a - b)
        .map((epNum) => ({ number: epNum })),
    }));
  }

  return { payload, notFoundMap };
};

export const sendSyncPayload = async (
  payload: SyncPayload,
  userToken: string,
  notFoundMap: Map<string, NotFoundMeta>,
  maxRetries: number = 3,
): Promise<{ success: boolean; addedCount: number }> => {
  const { client_id, app_name } = appConfig.simkl;
  const url = new URL('https://api.simkl.com/sync/history');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('app_name', app_name);
  url.searchParams.set('app_version', '2.0');

  const headers = new Headers();
  headers.append('Content-Type', 'application/json');
  headers.append('User-Agent', `${app_name}/2.0`);
  headers.append('Authorization', `Bearer ${userToken}`);

  const bodyStr = JSON.stringify(payload);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt === 0) {
        logger.debug(
          '[Batch Scrobble] Simkl history sync payload:',
          JSON.stringify(payload, null, 2),
        );
      } else {
        logger.info(`[Batch Scrobble] Retrying Simkl sync (attempt ${attempt}/${maxRetries})...`);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const isRateLimit = response.status === 400 && errorText.includes('RATE_LIMIT');
        const isRetryable = isRateLimit || response.status === 429 || response.status >= 500;

        if (isRetryable && attempt < maxRetries) {
          const delayMs =
            process.env.NODE_ENV === 'test'
              ? 0
              : isRateLimit
                ? (attempt + 1) * 7000
                : (attempt + 1) * 2000;
          logger.warn(
            `Simkl sync returned HTTP ${response.status} (${isRateLimit ? 'Per-user lock RATE_LIMIT' : 'Transient error'}). Retrying in ${delayMs}ms...`,
          );
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        logger.error(`Simkl sync failed with HTTP ${response.status}: ${errorText}`);
        return { success: false, addedCount: 0 };
      }

      const data = (await response.json()) as SyncResponse;
      logger.debug('[Batch Scrobble] Simkl sync response:', JSON.stringify(data, null, 2));

      // Check not_found items and trigger notifications
      const allNotFound = [
        ...(data.not_found?.movies || []),
        ...(data.not_found?.shows || []),
        ...(data.not_found?.episodes || []),
        ...((data.not_found as any)?.anime || []),
      ];

      const notifiedIds = new Set<string>();
      for (const nf of allNotFound) {
        let meta: NotFoundMeta | undefined;

        if (typeof nf === 'object' && nf) {
          const candidateKeys = [
            nf.ids?.anilist,
            nf.ids?.tvdb,
            nf.ids?.tmdb,
            nf.ids?.imdb,
            nf.title,
          ]
            .filter(Boolean)
            .map(String);

          for (const k of candidateKeys) {
            if (notFoundMap.has(k)) {
              meta = notFoundMap.get(k);
              break;
            }
          }
        } else if (nf) {
          meta = notFoundMap.get(String(nf));
        }

        if (meta && !notifiedIds.has(meta.id)) {
          notifiedIds.add(meta.id);
          if (meta.isSpecial) {
            logger.debug(
              `[Batch Scrobble] Suppressing Simkl failure notification for special: ${meta.title} (${meta.id})`,
            );
          } else {
            sendNotification({
              title: `Failed to update Simkl for ${meta.mediaType}`,
              message: `Item: ${meta.title}\nID: ${meta.id}\nLink: ${meta.link}`,
              priority: 4,
            });
          }
        }
      }

      const addedCount =
        (data.added?.movies || 0) +
        (data.added?.episodes || 0) +
        (data.added?.shows || 0) +
        ((data.added as any)?.anime || 0);
      return { success: true, addedCount };
    } catch (error) {
      if (attempt < maxRetries) {
        const delayMs = process.env.NODE_ENV === 'test' ? 0 : (attempt + 1) * 2000;
        logger.warn(`Network error during Simkl sync: ${error}. Retrying in ${delayMs}ms...`);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      console.error('Error sending batch sync payload to Simkl after retries:', error);
      return { success: false, addedCount: 0 };
    }
  }

  return { success: false, addedCount: 0 };
};

interface UserQueueState {
  items: ScrobbleQueueItem[];
  userToken: string;
  timer?: ReturnType<typeof setTimeout>;
  isFlushing?: boolean;
}

const userQueues = new Map<string, UserQueueState>();

/**
 * Enqueues a scrobble item for debouncing and batch submission to Simkl.
 */
export const enqueueScrobble = async (
  username: string,
  userToken: string,
  item: ScrobbleQueueItem,
  options?: { debounceMs?: number },
): Promise<void> => {
  const defaultDebounce = process.env.NODE_ENV === 'test' ? 0 : 2500;
  const debounceMs = options?.debounceMs ?? defaultDebounce;

  let queue = userQueues.get(username);
  if (!queue) {
    queue = { items: [], userToken };
    userQueues.set(username, queue);
  } else {
    queue.userToken = userToken;
  }

  queue.items.push(item);

  if (debounceMs <= 0) {
    await flushUserQueue(username);
    return;
  }

  if (queue.isFlushing) {
    // Current flush will trigger next flush on completion if items remain
    return;
  }

  if (queue.timer) {
    clearTimeout(queue.timer);
  }

  queue.timer = setTimeout(() => {
    flushUserQueue(username).catch((err) => {
      console.error(`Error during debounced queue flush for "${username}":`, err);
    });
  }, debounceMs);
};

/**
 * Flushes all pending queued items for a specific user and posts to Simkl.
 */
export const flushUserQueue = async (username: string): Promise<void> => {
  const queue = userQueues.get(username);
  if (!queue || queue.items.length === 0) {
    return;
  }

  if (queue.isFlushing) {
    return;
  }

  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
  }

  queue.isFlushing = true;
  const itemsToFlush = queue.items.splice(0, queue.items.length);
  const userToken = queue.userToken;

  const { payload, notFoundMap } = buildSyncPayload(itemsToFlush);
  const totalItems = itemsToFlush.length;

  logger.info(
    `[Batch Scrobble] Flushing ${totalItems} item(s) for user "${username}" in 1 request to Simkl...`,
  );

  try {
    const result = await sendSyncPayload(payload, userToken, notFoundMap);
    if (result.success) {
      logger.info(
        `[Batch Scrobble] Successfully synced batch of ${totalItems} item(s) for user "${username}".`,
      );
    } else {
      logger.warn(
        `[Batch Scrobble] Batch sync for user "${username}" completed with errors or failures.`,
      );
    }
  } finally {
    queue.isFlushing = false;
    if (queue.items.length > 0) {
      const defaultDebounce = process.env.NODE_ENV === 'test' ? 0 : 2500;
      if (defaultDebounce <= 0) {
        await flushUserQueue(username);
      } else {
        queue.timer = setTimeout(() => {
          flushUserQueue(username).catch((err) => {
            console.error(`Error during subsequent queue flush for "${username}":`, err);
          });
        }, defaultDebounce);
      }
    } else {
      userQueues.delete(username);
    }
  }
};

/**
 * Flushes all pending queues across all users (e.g. on shutdown).
 */
export const flushAllQueues = async (): Promise<void> => {
  const usernames = Array.from(userQueues.keys());
  for (const username of usernames) {
    await flushUserQueue(username);
  }
};
