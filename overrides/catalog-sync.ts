import {
  isAnimeLibrary,
  isExcludedLibrary,
  isPrivateAnimeLibrary,
} from '../jellyfin/normalizer';
import { appConfig } from '../shared/config';
import { logger } from '../shared/logger';
import { loadCatalog, saveCatalog } from './catalog-store';
import type {
  AnimeCatalog,
  CatalogData,
  CatalogShow,
  CatalogSyncOptions,
  CatalogSyncSummary,
  SeriesSyncOptions,
  SeriesSyncSummary,
} from './catalog-types';
import { pruneOrphanedOverrides } from './prune';

/**
 * Scans Jellyfin anime libraries and updates the anime catalog cache.
 * Does NOT touch or overwrite mapping-overrides.json.
 */
export const syncJellyfinCatalog = async (
  options?: CatalogSyncOptions,
): Promise<CatalogSyncSummary> => {
  const jellyfinConfig = appConfig.jellyfin;
  if (!jellyfinConfig?.url || !jellyfinConfig?.token) {
    throw new Error('Jellyfin is not configured in config.toml (missing url or token).');
  }

  const headers = {
    Authorization: `MediaBrowser Token="${jellyfinConfig.token}"`,
    Accept: 'application/json',
  };

  // 1. Fetch virtual folders and identify anime libraries
  const vFoldersRes = await fetch(`${jellyfinConfig.url}/Library/VirtualFolders`, { headers });
  if (!vFoldersRes.ok) {
    throw new Error(`Failed to fetch Jellyfin virtual folders: HTTP ${vFoldersRes.status}`);
  }
  const vFolders = (await vFoldersRes.json()) as Array<{ Name: string; ItemId: string }>;

  let targetFolders = vFolders.filter((f) => isAnimeLibrary(f.Name));
  if (options?.libraryNames && options.libraryNames.length > 0) {
    const selected = options.libraryNames.map((n) => n.toLowerCase());
    targetFolders = vFolders.filter(
      (f) => selected.includes(f.Name.toLowerCase()) && !isExcludedLibrary(f.Name),
    );
  }

  if (targetFolders.length === 0) {
    throw new Error('No anime libraries found matching criteria in Jellyfin.');
  }

  const shows: AnimeCatalog = {};
  let totalSeriesScanned = 0;
  let totalEpisodesScanned = 0;
  let totalMoviesScanned = 0;

  for (const folder of targetFolders) {
    logger.info(`[Catalog] Scanning anime library "${folder.Name}"...`);

    // 2. Scan Series
    const seriesUrl = new URL(`${jellyfinConfig.url}/Items`);
    seriesUrl.searchParams.set('parentId', folder.ItemId);
    seriesUrl.searchParams.set('includeItemTypes', 'Series');
    seriesUrl.searchParams.set('recursive', 'true');
    seriesUrl.searchParams.set('fields', 'ProviderIds,Name');

    const seriesRes = await fetch(seriesUrl.toString(), { headers });
    const seriesData = seriesRes.ok
      ? ((await seriesRes.json()) as { Items?: any[] })
      : { Items: [] };
    const seriesItems = seriesData.Items || [];
    totalSeriesScanned += seriesItems.length;

    const isPrivate = isPrivateAnimeLibrary(folder.Name);
    const seriesMap = new Map<string, { name: string; tvdbId?: string; tmdbId?: string }>();
    for (const s of seriesItems) {
      const p = s.ProviderIds || {};
      const tvdb = p.Tvdb || p.TVDB;
      const tmdb = p.Tmdb || p.TMDB;
      const effectiveKey = tvdb
        ? String(tvdb).trim()
        : tmdb
          ? `tmdb-${String(tmdb).trim()}`
          : `jf-${String(s.Id).trim()}`;

      seriesMap.set(s.Id, { name: s.Name, tvdbId: effectiveKey, tmdbId: tmdb });

      if (!shows[effectiveKey]) {
        shows[effectiveKey] = {
          tvdbId: effectiveKey,
          title: s.Name,
          tmdbId: tmdb,
          jellyfinSeriesId: s.Id,
          isPrivate,
          libraryName: folder.Name,
          seasons: {},
        };
      } else {
        if (isPrivate) shows[effectiveKey].isPrivate = true;
        if (!shows[effectiveKey].libraryName) shows[effectiveKey].libraryName = folder.Name;
      }
    }

    // 3. Scan Episodes in batches
    let epIndex = 0;
    const epLimit = 500;
    while (true) {
      const epUrl = new URL(`${jellyfinConfig.url}/Items`);
      epUrl.searchParams.set('parentId', folder.ItemId);
      epUrl.searchParams.set('includeItemTypes', 'Episode');
      epUrl.searchParams.set('recursive', 'true');
      epUrl.searchParams.set('startIndex', String(epIndex));
      epUrl.searchParams.set('limit', String(epLimit));
      epUrl.searchParams.set(
        'fields',
        'ProviderIds,SeriesId,SeriesName,IndexNumber,ParentIndexNumber,Name,LocationType,Path,SeasonName',
      );

      const epRes = await fetch(epUrl.toString(), { headers });
      if (!epRes.ok) break;
      const epData = (await epRes.json()) as { Items?: any[] };
      const episodes = epData.Items || [];
      if (episodes.length === 0) break;

      totalEpisodesScanned += episodes.length;

      for (const ep of episodes) {
        const seasonNum = ep.ParentIndexNumber ?? 0;
        const episodeNum = ep.IndexNumber ?? 1;

        // Exclude specials (Season 0) that do not exist in Jellyfin (virtual / missing)
        const isVirtual = ep.LocationType === 'Virtual' || (!ep.Path && !ep.Container);
        if (seasonNum === 0 && isVirtual) {
          continue;
        }

        const sInfo = seriesMap.get(ep.SeriesId);
        const epP = ep.ProviderIds || {};
        const tvdbId =
          sInfo?.tvdbId ||
          (epP.Tvdb || epP.TVDB
            ? String(epP.Tvdb || epP.TVDB).trim()
            : ep.SeriesId
              ? `jf-${String(ep.SeriesId).trim()}`
              : undefined);
        if (!tvdbId) continue;

        let show = shows[tvdbId];
        if (!show) {
          show = {
            tvdbId,
            title: sInfo?.name ?? ep.SeriesName ?? 'Unknown Series',
            tmdbId: sInfo?.tmdbId,
            jellyfinSeriesId: ep.SeriesId,
            isPrivate,
            libraryName: folder.Name,
            seasons: {},
          };
          shows[tvdbId] = show;
        } else {
          if (isPrivate) show.isPrivate = true;
          if (!show.libraryName) show.libraryName = folder.Name;
        }

        const sKey = String(seasonNum);
        const eKey = String(episodeNum);

        let season = show.seasons[sKey];
        if (!season) {
          season = {
            seasonNumber: seasonNum,
            name: ep.SeasonName || undefined,
            episodes: {},
          };
          show.seasons[sKey] = season;
        } else if (!season.name && ep.SeasonName) {
          season.name = ep.SeasonName;
        }

        if (!season.episodes[eKey]) {
          const isVirtual = ep.LocationType === 'Virtual' || (!ep.Path && !ep.Container);

          season.episodes[eKey] = {
            episodeNumber: episodeNum,
            name: ep.Name,
            jellyfinEpisodeId: ep.Id,
            tvdbEpisodeId: epP.Tvdb || epP.TVDB,
            locationType: ep.LocationType,
            path: ep.Path,
            exists: !isVirtual,
          };
        }
      }

      epIndex += episodes.length;
      if (episodes.length < epLimit) break;
    }

    // 4. Scan Movies
    const movieUrl = new URL(`${jellyfinConfig.url}/Items`);
    movieUrl.searchParams.set('parentId', folder.ItemId);
    movieUrl.searchParams.set('includeItemTypes', 'Movie');
    movieUrl.searchParams.set('recursive', 'true');
    movieUrl.searchParams.set('fields', 'ProviderIds,Name');

    const movieRes = await fetch(movieUrl.toString(), { headers });
    if (movieRes.ok) {
      const movieData = (await movieRes.json()) as { Items?: any[] };
      const movies = movieData.Items || [];
      totalMoviesScanned += movies.length;

      for (const movie of movies) {
        const p = movie.ProviderIds || {};
        const tvdbId = p.Tvdb || p.TVDB;
        const tmdbId = p.Tmdb || p.TMDB;
        const effectiveKey = tvdbId
          ? String(tvdbId).trim()
          : tmdbId
            ? `tmdb-${String(tmdbId).trim()}`
            : `jf-${String(movie.Id).trim()}`;

        let show = shows[effectiveKey];
        if (!show) {
          show = {
            tvdbId: effectiveKey,
            title: movie.Name,
            tmdbId: tmdbId,
            jellyfinSeriesId: movie.Id,
            isMovie: true,
            isPrivate,
            libraryName: folder.Name,
            seasons: {},
          };
          shows[effectiveKey] = show;
        } else {
          show.isMovie = true;
          if (isPrivate) show.isPrivate = true;
          if (!show.libraryName) show.libraryName = folder.Name;
        }

        let season0 = show.seasons['0'];
        if (!season0) {
          season0 = {
            seasonNumber: 0,
            episodes: {},
          };
          show.seasons['0'] = season0;
        }

        if (!season0.episodes['1']) {
          season0.episodes['1'] = {
            episodeNumber: 1,
            name: movie.Name ?? 'Movie',
            jellyfinEpisodeId: movie.Id,
          };
        }
      }
    }
  }

  // Prune any shows that ended up with 0 episodes
  for (const [tvdbId, show] of Object.entries(shows)) {
    if (Object.keys(show.seasons).length === 0) {
      delete shows[tvdbId];
    }
  }

  // Count catalog episodes
  let catalogEpisodesCount = 0;
  for (const show of Object.values(shows)) {
    for (const season of Object.values(show.seasons)) {
      catalogEpisodesCount += Object.keys(season.episodes).length;
    }
  }

  const lastUpdated = new Date().toISOString();
  const catalogData: CatalogData = {
    lastUpdated,
    shows,
  };

  saveCatalog(catalogData, options?.customCatalogPath);

  let prunedOverridesCount = 0;
  let prunedShowsCount = 0;

  if (options?.pruneDeletedOverrides) {
    const pruneRes = pruneOrphanedOverrides({
      catalog: catalogData,
      customCatalogPath: options?.customCatalogPath,
      customOverridesPath: options?.customOverridesPath,
    });
    prunedOverridesCount = pruneRes.prunedEpisodesCount;
    prunedShowsCount = pruneRes.prunedShowsCount;
  }

  const summary: CatalogSyncSummary = {
    librariesScanned: targetFolders.map((f) => f.Name),
    totalSeriesScanned,
    totalEpisodesScanned,
    totalMoviesScanned,
    catalogShowsCount: Object.keys(shows).length,
    catalogEpisodesCount,
    lastUpdated,
    prunedOverridesCount,
    prunedShowsCount,
  };

  logger.info(
    `[Catalog] Successfully synced Jellyfin catalog: ${summary.catalogShowsCount} shows, ${summary.catalogEpisodesCount} episodes` +
      (prunedOverridesCount > 0 ? ` (pruned ${prunedOverridesCount} deleted overrides)` : ''),
  );

  return summary;
};

let catalogSyncMutex: Promise<any> = Promise.resolve();

/**
 * Scans a single anime series or movie from Jellyfin and updates it in the catalog.
 * Optionally prunes any orphaned overrides for deleted episodes.
 * Serialized via catalogSyncMutex to prevent concurrent file overwrite race conditions.
 */
export const syncJellyfinSeries = (
  tvdbId: string,
  options?: SeriesSyncOptions,
): Promise<SeriesSyncSummary> => {
  const execute = async (): Promise<SeriesSyncSummary> => {
    const jellyfinConfig = appConfig.jellyfin;
    if (!jellyfinConfig?.url || !jellyfinConfig?.token) {
      throw new Error('Jellyfin configuration (url, token) is required for syncing series.');
    }

    const headers = {
      Authorization: `MediaBrowser Token="${jellyfinConfig.token}"`,
      Accept: 'application/json',
    };

    const catalogData = loadCatalog(options?.customCatalogPath);
    const existingShow = tvdbId ? catalogData.shows[tvdbId] : undefined;

    let item: any = null;

    // 1. If we have jellyfinSeriesId (from options or catalog or jf- key), fetch directly by ID
    const targetSeriesId =
      options?.jellyfinSeriesId ||
      existingShow?.jellyfinSeriesId ||
      (tvdbId?.startsWith('jf-') ? tvdbId.replace('jf-', '') : undefined);
    if (targetSeriesId) {
      try {
        const itemUrl = new URL(`${jellyfinConfig.url}/Items`);
        itemUrl.searchParams.set('ids', targetSeriesId);
        itemUrl.searchParams.set('fields', 'ProviderIds,Name,Path,LocationType,Type');
        const itemRes = await fetch(itemUrl.toString(), { headers });
        if (itemRes.ok) {
          const itemData = (await itemRes.json()) as { Items?: any[] };
          item = itemData.Items?.[0] || null;
        }
      } catch (err) {
        logger.warn(
          `[Catalog] Failed fetching item directly by ID ${targetSeriesId}:`,
          err,
        );
      }
    }

    // 2. If not found by ID, locate item by TVDB ID in target anime libraries
    if (!item && tvdbId) {
      const vFoldersRes = await fetch(`${jellyfinConfig.url}/Library/VirtualFolders`, { headers });
      if (!vFoldersRes.ok) {
        throw new Error(`Failed to fetch Jellyfin virtual folders: HTTP ${vFoldersRes.status}`);
      }
      const vFolders = (await vFoldersRes.json()) as Array<{ Name: string; ItemId: string }>;
      const targetFolders = vFolders.filter((f) => isAnimeLibrary(f.Name));

      for (const folder of targetFolders) {
        for (const itemType of ['Series', 'Movie']) {
          const searchUrl = new URL(`${jellyfinConfig.url}/Items`);
          searchUrl.searchParams.set('parentId', folder.ItemId);
          searchUrl.searchParams.set('includeItemTypes', itemType);
          searchUrl.searchParams.set('recursive', 'true');
          searchUrl.searchParams.set('fields', 'ProviderIds,Name,Path,LocationType,Type');

          const sRes = await fetch(searchUrl.toString(), { headers });
          if (sRes.ok) {
            const sData = (await sRes.json()) as { Items?: any[] };
            const found = (sData.Items || []).find((it) => {
              const p = it.ProviderIds || {};
              const t = p.Tvdb || p.TVDB;
              return String(t) === String(tvdbId);
            });
            if (found) {
              if (!found.Type) found.Type = itemType;
              item = found;
              break;
            }
          }
        }
        if (item) break;
      }
    }

    // 3. If item is not found in Jellyfin at all
    if (!item) {
      logger.info(
        `[Catalog] Series TVDB ${tvdbId || targetSeriesId} was not found in Jellyfin.`,
      );

      if (tvdbId && catalogData.shows[tvdbId]) {
        delete catalogData.shows[tvdbId];
        catalogData.lastUpdated = new Date().toISOString();
        saveCatalog(catalogData, options?.customCatalogPath);
      }

      let prunedOverridesCount = 0;
      if (options?.pruneDeletedOverrides !== false) {
        const pruneRes = pruneOrphanedOverrides({
          catalog: catalogData,
          customCatalogPath: options?.customCatalogPath,
          customOverridesPath: options?.customOverridesPath,
        });
        prunedOverridesCount = pruneRes.prunedEpisodesCount;
      }

      return {
        tvdbId: tvdbId || '',
        title: existingShow?.title || `Show ${tvdbId || targetSeriesId || ''}`,
        deleted: true,
        totalEpisodes: 0,
        prunedOverridesCount,
      };
    }

    // 4. Construct updated CatalogShow based on item type
    const p = item.ProviderIds || {};
    const rawTvdb = p.Tvdb || p.TVDB;
    const rawTmdb = p.Tmdb || p.TMDB;
    const effectiveTvdbId = String(
      tvdbId ||
        rawTvdb ||
        (rawTmdb ? `tmdb-${rawTmdb}` : (item.Id ? `jf-${item.Id}` : ''))
    );
    if (!effectiveTvdbId) {
      logger.warn(
        `[Catalog] Item "${item.Name}" (ID: ${item.Id}) has no TVDB or fallback ID in Jellyfin. Skipping catalog sync.`,
      );
      return {
        tvdbId: '',
        title: item.Name,
        deleted: false,
        totalEpisodes: 0,
        prunedOverridesCount: 0,
      };
    }

    const libraryName = options?.libraryName ?? existingShow?.libraryName;
    const isPrivate = existingShow?.isPrivate ?? (libraryName ? isPrivateAnimeLibrary(libraryName) : false);

    const isMovie = item.Type?.toLowerCase() === 'movie';
    const show: CatalogShow = {
      tvdbId: effectiveTvdbId,
      title: item.Name,
      tmdbId: p.Tmdb || p.TMDB,
      jellyfinSeriesId: item.Id,
      isMovie,
      isPrivate,
      libraryName,
      seasons: {},
    };

    if (isMovie) {
      show.seasons['0'] = {
        seasonNumber: 0,
        episodes: {
          '1': {
            episodeNumber: 1,
            name: item.Name ?? 'Movie',
            jellyfinEpisodeId: item.Id,
          },
        },
      };
    } else {
      // Scan episodes for series
      const epUrl = new URL(`${jellyfinConfig.url}/Items`);
      epUrl.searchParams.set('parentId', item.Id);
      epUrl.searchParams.set('includeItemTypes', 'Episode');
      epUrl.searchParams.set('recursive', 'true');
      epUrl.searchParams.set(
        'fields',
        'ProviderIds,SeriesId,SeriesName,IndexNumber,ParentIndexNumber,Name,LocationType,Path,SeasonName',
      );

      const epRes = await fetch(epUrl.toString(), { headers });
      const epData = epRes.ok ? ((await epRes.json()) as { Items?: any[] }) : { Items: [] };
      const episodes = epData.Items || [];

      for (const ep of episodes) {
        if (ep.SeriesId && item.Id && ep.SeriesId !== item.Id) {
          continue;
        }

        const seasonNum = ep.ParentIndexNumber ?? 0;
        const episodeNum = ep.IndexNumber ?? 1;

        // Exclude specials (Season 0) that do not exist in Jellyfin (virtual / missing)
        const isVirtual = ep.LocationType === 'Virtual' || (!ep.Path && !ep.Container);
        if (seasonNum === 0 && isVirtual) {
          continue;
        }

        const sKey = String(seasonNum);
        const eKey = String(episodeNum);

        if (!show.seasons[sKey]) {
          show.seasons[sKey] = {
            seasonNumber: seasonNum,
            name: ep.SeasonName || undefined,
            episodes: {},
          };
        } else if (!show.seasons[sKey].name && ep.SeasonName) {
          show.seasons[sKey].name = ep.SeasonName;
        }

        const epP = ep.ProviderIds || {};

        show.seasons[sKey].episodes[eKey] = {
          episodeNumber: episodeNum,
          name: ep.Name,
          jellyfinEpisodeId: ep.Id,
          tvdbEpisodeId: epP.Tvdb || epP.TVDB,
          locationType: ep.LocationType,
          path: ep.Path,
          exists: !isVirtual,
        };
      }
    }

    // Count total episodes
    let totalEpisodes = 0;
    for (const s of Object.values(show.seasons)) {
      totalEpisodes += Object.keys(s.episodes).length;
    }

    if (totalEpisodes === 0) {
      delete catalogData.shows[effectiveTvdbId];
    } else {
      catalogData.shows[effectiveTvdbId] = show;
    }

    catalogData.lastUpdated = new Date().toISOString();
    saveCatalog(catalogData, options?.customCatalogPath);

    // 5. Prune overrides if files were removed/renumbered
    let prunedOverridesCount = 0;
    if (options?.pruneDeletedOverrides !== false) {
      const pruneRes = pruneOrphanedOverrides({
        catalog: catalogData,
        customCatalogPath: options?.customCatalogPath,
        customOverridesPath: options?.customOverridesPath,
      });
      prunedOverridesCount = pruneRes.prunedEpisodesCount;
    }

    logger.info(
      `[Catalog] Successfully synced series "${show.title}" (TVDB ${effectiveTvdbId}) from Jellyfin: ${totalEpisodes} episodes` +
        (prunedOverridesCount > 0 ? ` (pruned ${prunedOverridesCount} deleted overrides)` : ''),
    );

    return {
      tvdbId: effectiveTvdbId,
      title: show.title,
      show,
      deleted: false,
      totalEpisodes,
      prunedOverridesCount,
    };
  };

  const next = catalogSyncMutex.then(execute, execute);
  catalogSyncMutex = next;
  return next;
};
