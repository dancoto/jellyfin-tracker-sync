import { sendNotification } from '../ntfy';
import { logger } from '../shared/logger';

export interface AniListScrobbleItem {
  mediaId: number;
  episodeNumber: number;
  isMovie?: boolean;
  title?: string;
  isPrivate?: boolean;
}

export interface AniListMediaDetails {
  id: number;
  episodes?: number | null;
  title?: {
    romaji?: string;
    english?: string;
  };
  mediaListEntry?: {
    id?: number;
    status?: string;
    progress?: number;
  } | null;
}

export interface AniListMutationResult {
  id: number;
  mediaId: number;
  status: string;
  progress: number;
  private?: boolean;
}

const calculateRetryDelay = (response: Response, attempt: number): number => {
  if (process.env.NODE_ENV === 'test') return 0;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (!isNaN(sec) && sec > 0) {
      return sec * 1000;
    }
  }
  // Exponential backoff: 3s, 6s, 12s
  return Math.min(30000, (attempt + 1) * 3000);
};

const checkRateLimitHeader = (response: Response): void => {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining !== null && parseInt(remaining, 10) <= 2) {
    logger.warn(`[AniList] Rate limit quota almost exhausted: ${remaining} requests remaining.`);
  }
};

/**
 * Queries media information and user's list entry from AniList.
 */
export const fetchAniListMediaEntry = async (
  mediaId: number,
  userToken: string,
  maxRetries = 3,
): Promise<AniListMediaDetails | null> => {
  const bodyStr = JSON.stringify({
    query: `query ($mediaId: Int) {
      Media(id: $mediaId) {
        id
        episodes
        title {
          romaji
          english
        }
        mediaListEntry {
          id
          status
          progress
        }
      }
    }`,
    variables: { mediaId },
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: bodyStr,
      });

      checkRateLimitHeader(response);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const isRateLimit = response.status === 429;
        const isRetryable = isRateLimit || response.status >= 500;

        if (isRetryable && attempt < maxRetries) {
          const delayMs = calculateRetryDelay(response, attempt);
          logger.warn(
            `[AniList] Query Media(${mediaId}) returned HTTP ${response.status} (Rate limited / transient). Retrying in ${delayMs}ms...`,
          );
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        logger.warn(
          `[AniList] Query Media(${mediaId}) failed (HTTP ${response.status}): ${errorText}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        data?: {
          Media?: AniListMediaDetails;
        };
        errors?: Array<{ message?: string }>;
      };

      if (data.errors && data.errors.length > 0) {
        logger.warn(
          `[AniList] GraphQL error querying Media(${mediaId}): ${data.errors[0]?.message}`,
        );
        return null;
      }

      return data.data?.Media ?? null;
    } catch (error) {
      if (attempt < maxRetries) {
        const delayMs = process.env.NODE_ENV === 'test' ? 0 : (attempt + 1) * 2000;
        logger.warn(
          `[AniList] Network error querying Media(${mediaId}). Retrying in ${delayMs}ms...`,
        );
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      logger.error(`[AniList] Network error querying Media(${mediaId}):`, error);
      return null;
    }
  }

  return null;
};

/**
 * Executes the SaveMediaListEntry mutation to update watching progress on AniList.
 */
export const mutateAniListMediaEntry = async (
  mediaId: number,
  progress: number,
  status: string | undefined,
  userToken: string,
  isPrivate?: boolean,
  maxRetries = 3,
): Promise<AniListMutationResult | null> => {
  const variables: Record<string, any> = { mediaId, progress };
  if (status) {
    variables.status = status;
  }
  if (isPrivate !== undefined) {
    variables.private = isPrivate;
  }

  const hasPrivate = isPrivate !== undefined;
  const bodyStr = JSON.stringify({
    query: `mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus${hasPrivate ? ', $private: Boolean' : ''}) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status${hasPrivate ? ', private: $private' : ''}) {
        id
        mediaId
        status
        progress
      }
    }`,
    variables,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: bodyStr,
      });

      checkRateLimitHeader(response);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const isRateLimit = response.status === 429;
        const isRetryable = isRateLimit || response.status >= 500;

        if (isRetryable && attempt < maxRetries) {
          const delayMs = calculateRetryDelay(response, attempt);
          logger.warn(
            `[AniList] Mutation returned HTTP ${response.status}. Retrying in ${delayMs}ms...`,
          );
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        logger.error(
          `[AniList] Mutation failed for Media(${mediaId}) (HTTP ${response.status}): ${errorText}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        data?: {
          SaveMediaListEntry?: AniListMutationResult;
        };
        errors?: Array<{ message?: string }>;
      };

      if (data.errors && data.errors.length > 0) {
        logger.error(
          `[AniList] GraphQL mutation error for Media(${mediaId}): ${data.errors[0]?.message}`,
        );
        return null;
      }

      return data.data?.SaveMediaListEntry ?? null;
    } catch (error) {
      if (attempt < maxRetries) {
        const delayMs = process.env.NODE_ENV === 'test' ? 0 : (attempt + 1) * 2000;
        logger.warn(
          `[AniList] Network error during mutation: ${error}. Retrying in ${delayMs}ms...`,
        );
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      logger.error(
        `[AniList] Failed executing mutation for Media(${mediaId}) after retries:`,
        error,
      );
      return null;
    }
  }

  return null;
};

/**
 * Scrobbles an episode or movie to AniList, avoiding regression if user is already past the episode.
 */
export const scrobbleToAniList = async (
  userToken: string,
  username: string,
  item: AniListScrobbleItem,
): Promise<{ success: boolean; progress?: number; status?: string }> => {
  const media = await fetchAniListMediaEntry(item.mediaId, userToken);
  const displayTitle =
    item.title || media?.title?.english || media?.title?.romaji || `Media ${item.mediaId}`;

  const currentProgress = media?.mediaListEntry?.progress ?? 0;
  const currentStatus = media?.mediaListEntry?.status;

  // Prevent accidental regression for non-movies unless the entry is in REPEATING state
  if (!item.isMovie && currentStatus !== 'REPEATING' && currentProgress >= item.episodeNumber) {
    logger.info(
      `[AniList] User "${username}" progress for "${displayTitle}" is already ${currentProgress} >= ${item.episodeNumber}. No update needed.`,
    );
    return { success: true, progress: currentProgress, status: currentStatus };
  }

  const isCompleted =
    item.isMovie || (Boolean(media?.episodes) && item.episodeNumber >= (media?.episodes ?? 0));
  const targetStatus = isCompleted ? 'COMPLETED' : 'CURRENT';
  const targetProgress = item.isMovie ? 1 : item.episodeNumber;

  logger.info(
    `[AniList] Updating "${displayTitle}" for user "${username}" -> Progress: ${targetProgress}, Status: ${targetStatus}`,
  );

  const result = await mutateAniListMediaEntry(
    item.mediaId,
    targetProgress,
    targetStatus,
    userToken,
    item.isPrivate,
  );

  if (!result) {
    sendNotification({
      title: 'Failed to update AniList',
      message: `Failed scrobbling "${displayTitle}" (Media ID: ${item.mediaId}) for user "${username}".`,
      priority: 4,
    });
    return { success: false };
  }

  logger.info(
    `[AniList] Successfully scrobbled "${displayTitle}" for user "${username}": Progress ${result.progress}${media?.episodes ? `/${media.episodes}` : ''} (${result.status})`,
  );

  return { success: true, progress: result.progress, status: result.status };
};

interface AniListUserQueue {
  items: AniListScrobbleItem[];
  userToken: string;
  timer?: ReturnType<typeof setTimeout>;
  isFlushing?: boolean;
}

const aniListQueues = new Map<string, AniListUserQueue>();

/**
 * Enqueues a scrobble for debouncing. Deduplicates rapid completions of the same anime.
 */
export const enqueueAniListScrobble = async (
  username: string,
  userToken: string,
  item: AniListScrobbleItem,
  options?: { debounceMs?: number },
): Promise<void> => {
  const debounceMs = options?.debounceMs ?? 100;
  let queue = aniListQueues.get(username);
  if (!queue) {
    queue = { items: [], userToken };
    aniListQueues.set(username, queue);
  } else {
    queue.userToken = userToken;
  }

  queue.items.push(item);

  if (debounceMs <= 0) {
    await flushAniListUserQueue(username);
    return;
  }

  if (queue.isFlushing) {
    return;
  }

  if (queue.timer) {
    clearTimeout(queue.timer);
  }

  queue.timer = setTimeout(() => {
    flushAniListUserQueue(username).catch((err) => {
      console.error(`Error during AniList queue flush for "${username}":`, err);
    });
  }, debounceMs);
};

/**
 * Flushes all pending queued AniList scrobbles for a user.
 */
export const flushAniListUserQueue = async (username: string): Promise<void> => {
  const queue = aniListQueues.get(username);
  if (!queue || queue.items.length === 0) return;
  if (queue.isFlushing) return;

  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
  }

  queue.isFlushing = true;
  const itemsToFlush = queue.items.splice(0, queue.items.length);
  const userToken = queue.userToken;

  // Deduplicate by mediaId: keep highest episodeNumber and preserve isPrivate flag
  const byMediaId = new Map<number, AniListScrobbleItem>();
  for (const item of itemsToFlush) {
    const existing = byMediaId.get(item.mediaId);
    if (!existing) {
      byMediaId.set(item.mediaId, { ...item });
    } else {
      const highestEp = Math.max(existing.episodeNumber, item.episodeNumber);
      const isPrivate = Boolean(existing.isPrivate || item.isPrivate);
      byMediaId.set(item.mediaId, {
        ...existing,
        ...item,
        episodeNumber: highestEp,
        isPrivate,
      });
    }
  }

  try {
    let isFirst = true;
    for (const item of byMediaId.values()) {
      if (!isFirst && process.env.NODE_ENV !== 'test') {
        // AniList degraded rate limit is 30 req/min (1 req every 2s). Pause 2000ms between distinct shows.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      isFirst = false;
      await scrobbleToAniList(userToken, username, item);
    }
  } finally {
    queue.isFlushing = false;
    if (queue.items.length > 0) {
      await flushAniListUserQueue(username);
    }
  }
};

/**
 * Flushes all queues across all users (used during graceful shutdown).
 */
export const flushAllAniListQueues = async (): Promise<void> => {
  const users = Array.from(aniListQueues.keys());
  for (const user of users) {
    await flushAniListUserQueue(user);
  }
};
