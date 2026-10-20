import { defaultJellyfinClient } from '../jellyfin';
import { appConfig } from '../shared/config';
import { logger } from '../shared/logger';
import { syncJellyfinSeries, type SeriesSyncSummary } from './catalog';

export interface SeriesSyncQueueItem {
  tvdbId?: string;
  jellyfinSeriesId?: string;
  seriesName?: string;
  itemType?: 'Episode' | 'Movie' | 'Series' | 'Other';
  libraryName?: string;
  debounceMs?: number;
  customCatalogPath?: string;
  customOverridesPath?: string;
}

export interface PendingSeriesSync {
  key: string;
  tvdbId?: string;
  jellyfinSeriesId?: string;
  seriesName?: string;
  itemType?: 'Episode' | 'Movie' | 'Series' | 'Other';
  libraryName?: string;
  eventCount: number;
  timer?: ReturnType<typeof setTimeout>;
  customCatalogPath?: string;
  customOverridesPath?: string;
}

const pendingQueue = new Map<string, PendingSeriesSync>();
export const DEFAULT_DEBOUNCE_MS = 20000; // 20 seconds default debounce for batch season/episode drops

let activeSyncSeries = syncJellyfinSeries;

export const setSeriesSyncRunner = (runner: typeof syncJellyfinSeries): void => {
  activeSyncSeries = runner;
};

export const resetSeriesSyncRunner = (): void => {
  activeSyncSeries = syncJellyfinSeries;
};

/**
 * Returns the effective key for debouncing a series sync.
 * Favors TVDB ID (`tvdb:<id>`), falling back to Jellyfin ID (`jf:<id>`).
 */
export const getSeriesSyncKey = (tvdbId?: string, jellyfinSeriesId?: string): string | null => {
  if (tvdbId) return `tvdb:${tvdbId}`;
  if (jellyfinSeriesId) return `jf:${jellyfinSeriesId}`;
  return null;
};

/**
 * Enqueues a series or movie to be synced after a trailing debounce window.
 * Repeated calls for the same series (e.g. 12-episode batch) reset the timer,
 * ensuring only one library scan occurs once all files are indexed.
 */
export const enqueueSeriesSync = (item: SeriesSyncQueueItem): void => {
  if (appConfig?.jellyfin?.continuous_sync?.enabled === false) {
    logger.debug('[ContinuousSync] Continuous sync is disabled in config. Ignoring item.');
    return;
  }

  const key = getSeriesSyncKey(item.tvdbId, item.jellyfinSeriesId);
  if (!key) {
    logger.warn(
      `[ContinuousSync] Cannot enqueue series sync for "${item.seriesName ?? 'unknown'}": missing both TVDB ID and Jellyfin Series ID.`,
    );
    return;
  }

  // Check if there was an earlier entry keyed by Jellyfin ID that now has a resolved TVDB ID
  if (item.tvdbId && item.jellyfinSeriesId) {
    const jfKey = `jf:${item.jellyfinSeriesId}`;
    const existingJf = pendingQueue.get(jfKey);
    if (existingJf && jfKey !== key) {
      if (existingJf.timer) {
        clearTimeout(existingJf.timer);
        existingJf.timer = undefined;
      }
      pendingQueue.delete(jfKey);
      const existingTvdb = pendingQueue.get(key);
      if (existingTvdb) {
        existingTvdb.eventCount += existingJf.eventCount;
      } else {
        pendingQueue.set(key, {
          ...existingJf,
          key,
          tvdbId: item.tvdbId,
        });
      }
    }
  }

  const existing = pendingQueue.get(key);
  if (existing) {
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
    }
    existing.eventCount += 1;
    if (item.seriesName) existing.seriesName = item.seriesName;
    if (item.tvdbId) existing.tvdbId = item.tvdbId;
    if (item.jellyfinSeriesId) existing.jellyfinSeriesId = item.jellyfinSeriesId;
    if (item.libraryName) existing.libraryName = item.libraryName;
    if (item.itemType) existing.itemType = item.itemType;
    if (item.customCatalogPath) existing.customCatalogPath = item.customCatalogPath;
    if (item.customOverridesPath) existing.customOverridesPath = item.customOverridesPath;
  } else {
    pendingQueue.set(key, {
      key,
      tvdbId: item.tvdbId,
      jellyfinSeriesId: item.jellyfinSeriesId,
      seriesName: item.seriesName,
      itemType: item.itemType,
      libraryName: item.libraryName,
      eventCount: 1,
      customCatalogPath: item.customCatalogPath,
      customOverridesPath: item.customOverridesPath,
    });
  }

  const entry = pendingQueue.get(key)!;
  const configuredDebounce =
    item.debounceMs ??
    appConfig?.jellyfin?.continuous_sync?.debounce_ms ??
    (process.env.NODE_ENV === 'test' ? 0 : DEFAULT_DEBOUNCE_MS);

  if (configuredDebounce <= 0) {
    flushSeriesSync(key).catch((err) => {
      logger.error(`[ContinuousSync] Error executing immediate flush for "${key}":`, err);
    });
  } else {
    entry.timer = setTimeout(() => {
      flushSeriesSync(key).catch((err) => {
        logger.error(`[ContinuousSync] Error executing debounced flush for "${key}":`, err);
      });
    }, configuredDebounce);
  }
};

/**
 * Immediately flushes a specific pending series sync by key.
 */
export const flushSeriesSync = async (key: string): Promise<SeriesSyncSummary | null> => {
  const pending = pendingQueue.get(key);
  if (!pending) return null;

  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  pendingQueue.delete(key);

  let tvdbId = pending.tvdbId;
  const jellyfinSeriesId = pending.jellyfinSeriesId;

  // If tvdbId was not available in webhook payload, attempt fetching from Jellyfin API
  if (!tvdbId && jellyfinSeriesId) {
    try {
      const fetched = await defaultJellyfinClient.getSeriesProviderIds(jellyfinSeriesId, {
        forceRefresh: true,
      });
      if (fetched?.tvdb) {
        tvdbId = fetched.tvdb;
      }
    } catch (err) {
      logger.warn(
        `[ContinuousSync] Failed resolving provider IDs for Jellyfin item ${jellyfinSeriesId}:`,
        err,
      );
    }
  }

  const seriesTitle = pending.seriesName ?? tvdbId ?? jellyfinSeriesId ?? 'Unknown Show';
  logger.info(
    `[ContinuousSync] Debounce expired for "${seriesTitle}" (${pending.eventCount} event(s)). Syncing series from Jellyfin...`,
  );

  try {
    const summary = await activeSyncSeries(tvdbId || '', {
      jellyfinSeriesId,
      libraryName: pending.libraryName,
      customCatalogPath: pending.customCatalogPath,
      customOverridesPath: pending.customOverridesPath,
    });

    if (summary.deleted) {
      logger.info(
        `[ContinuousSync] Series "${summary.title}" was marked as deleted or no longer found in Jellyfin.` +
          (summary.prunedOverridesCount > 0
            ? ` Pruned ${summary.prunedOverridesCount} orphaned overrides.`
            : ''),
      );
    } else {
      logger.info(
        `[ContinuousSync] Successfully synced "${summary.title}" (TVDB: ${summary.tvdbId}, ${summary.totalEpisodes} episode(s)) to catalog.` +
          (summary.prunedOverridesCount > 0
            ? ` Pruned ${summary.prunedOverridesCount} orphaned overrides.`
            : ''),
      );
    }

    return summary;
  } catch (err) {
    logger.error(`[ContinuousSync] Error syncing series "${seriesTitle}":`, err);
    return null;
  }
};

/**
 * Flushes all pending series syncs (useful during app shutdown or tests).
 */
export const flushAllPendingSeriesSync = async (): Promise<void> => {
  const keys = Array.from(pendingQueue.keys());
  for (const key of keys) {
    await flushSeriesSync(key);
  }
};

/**
 * Clears all pending timers and queue items without executing them.
 */
export const clearSeriesSyncQueue = (): void => {
  for (const pending of pendingQueue.values()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }
  pendingQueue.clear();
};

/**
 * Returns the count of currently pending debounced series syncs.
 */
export const getPendingSeriesSyncCount = (): number => {
  return pendingQueue.size;
};

/**
 * Returns the keys of currently pending debounced series syncs.
 */
export const getPendingSeriesSyncKeys = (): string[] => {
  return Array.from(pendingQueue.keys());
};
