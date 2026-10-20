import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultAnimeResolver } from '../anime';
import {
  TvdbOverridesIndex,
  type RawEpisodeOverride,
  type RawSeasonOverride,
  type RawTvdbOverrides,
} from '../anime/tvdb-overrides';
import { isAnimeLibrary, isExcludedLibrary } from '../jellyfin/normalizer';
import { appConfig } from '../shared/config';
import { logger } from '../shared/logger';

export interface ImportSummary {
  librariesScanned: string[];
  totalSeriesScanned: number;
  totalEpisodesScanned: number;
  totalMoviesScanned: number;
  showsAdded: number;
  episodesAdded: number;
  preservedManualEpisodes: number;
  backupPath?: string;
}

export interface ImportOptions {
  libraryNames?: string[];
  customOverridesPath?: string;
}

interface JellyfinItem {
  Id: string;
  Name?: string;
  SeriesId?: string;
  SeriesName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ProviderIds?: Record<string, string>;
  LocationType?: string;
  Path?: string;
  Container?: string;
}

export const importJellyfinAnimeMappings = async (
  options?: ImportOptions,
): Promise<ImportSummary> => {
  const jellyfinConfig = appConfig.jellyfin;
  if (!jellyfinConfig?.url || !jellyfinConfig?.token) {
    throw new Error('Jellyfin is not configured in config.toml (missing url or token).');
  }

  const filePath = TvdbOverridesIndex.getFilePath(options?.customOverridesPath);
  let currentOverrides: RawTvdbOverrides = {};
  let backupPath: string | undefined;

  // 1. Read existing mapping-overrides.json if it exists
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      currentOverrides = JSON.parse(content) as RawTvdbOverrides;
    } catch (err) {
      logger.error(`[Importer] Failed reading existing overrides at ${filePath}:`, err);
      currentOverrides = {};
    }
  }

  const headers = {
    Authorization: `MediaBrowser Token="${jellyfinConfig.token}"`,
    Accept: 'application/json',
  };

  // 2. Fetch virtual folders and identify anime libraries
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

  const summary: ImportSummary = {
    librariesScanned: targetFolders.map((f) => f.Name),
    totalSeriesScanned: 0,
    totalEpisodesScanned: 0,
    totalMoviesScanned: 0,
    showsAdded: 0,
    episodesAdded: 0,
    preservedManualEpisodes: 0,
    backupPath,
  };

  // Ensure default anime resolver is initialized
  await defaultAnimeResolver.initialize();

  // 3. Process each anime library
  for (const folder of targetFolders) {
    logger.info(`[Importer] Scanning anime library "${folder.Name}"...`);

    // Fetch all series in this library
    const seriesUrl = new URL('/Items', jellyfinConfig.url);
    seriesUrl.searchParams.set('parentId', folder.ItemId);
    seriesUrl.searchParams.set('recursive', 'true');
    seriesUrl.searchParams.set('includeItemTypes', 'Series');
    seriesUrl.searchParams.set('fields', 'ProviderIds,Name');

    const seriesRes = await fetch(seriesUrl.toString(), { headers });
    let seriesList: JellyfinItem[] = [];
    if (seriesRes.ok) {
      const data = (await seriesRes.json()) as { Items?: JellyfinItem[] };
      seriesList = data.Items ?? [];
    }

    // Fetch all episodes in this library
    const episodesUrl = new URL('/Items', jellyfinConfig.url);
    episodesUrl.searchParams.set('parentId', folder.ItemId);
    episodesUrl.searchParams.set('recursive', 'true');
    episodesUrl.searchParams.set('includeItemTypes', 'Episode');
    episodesUrl.searchParams.set(
      'fields',
      'ProviderIds,Name,IndexNumber,ParentIndexNumber,SeriesName,SeriesId,LocationType,Path',
    );

    const episodesRes = await fetch(episodesUrl.toString(), { headers });
    let episodesList: JellyfinItem[] = [];
    if (episodesRes.ok) {
      const data = (await episodesRes.json()) as { Items?: JellyfinItem[] };
      episodesList = data.Items ?? [];
    }

    // Fetch all standalone movies in this library (e.g. Anime Movies folder)
    const moviesUrl = new URL('/Items', jellyfinConfig.url);
    moviesUrl.searchParams.set('parentId', folder.ItemId);
    moviesUrl.searchParams.set('recursive', 'true');
    moviesUrl.searchParams.set('includeItemTypes', 'Movie');
    moviesUrl.searchParams.set('fields', 'ProviderIds,Name');

    const moviesRes = await fetch(moviesUrl.toString(), { headers });
    let moviesList: JellyfinItem[] = [];
    if (moviesRes.ok) {
      const data = (await moviesRes.json()) as { Items?: JellyfinItem[] };
      moviesList = data.Items ?? [];
    }

    summary.totalSeriesScanned += seriesList.length;
    summary.totalEpisodesScanned += episodesList.length;
    summary.totalMoviesScanned += moviesList.length;

    // Group episodes by SeriesId
    const episodesBySeries = new Map<string, JellyfinItem[]>();
    for (const ep of episodesList) {
      const sId = ep.SeriesId || '';
      if (!episodesBySeries.has(sId)) {
        episodesBySeries.set(sId, []);
      }
      episodesBySeries.get(sId)!.push(ep);
    }

    // 4. Merge Series & Episodes into overrides
    for (const series of seriesList) {
      const eps = episodesBySeries.get(series.Id) ?? [];

      // Determine TVDB ID from series or episodes
      const sProv = series.ProviderIds ?? {};
      let tvdbId = sProv.Tvdb || sProv.tvdb;
      if (!tvdbId) {
        for (const ep of eps) {
          const epProv = ep.ProviderIds ?? {};
          if (epProv.Tvdb || epProv.tvdb) {
            tvdbId = epProv.Tvdb || epProv.tvdb;
            break;
          }
        }
      }

      const tmdbId = sProv.Tmdb || sProv.tmdb;
      const showKey = tvdbId
        ? String(tvdbId).trim()
        : tmdbId
          ? `tmdb-${String(tmdbId).trim()}`
          : `jf-${String(series.Id).trim()}`;

      let show = currentOverrides[showKey];
      if (!show) {
        show = {
          title: series.Name,
          tmdbId: sProv.Tmdb || sProv.tmdb,
          seasons: {},
        };
        currentOverrides[showKey] = show;
        summary.showsAdded++;
      } else {
        if (!show.title && series.Name) show.title = series.Name;
        if (!show.tmdbId && (sProv.Tmdb || sProv.tmdb)) {
          show.tmdbId = sProv.Tmdb || sProv.tmdb;
        }
        if (!show.seasons) show.seasons = {};
      }

      const seasons = show.seasons as Record<string, RawSeasonOverride>;

      for (const ep of eps) {
        const seasonNum = ep.ParentIndexNumber ?? 1;
        const epNum = ep.IndexNumber ?? 1;

        // Exclude specials (Season 0) that do not exist in Jellyfin (virtual / missing)
        const isVirtualSpecial =
          seasonNum === 0 && (ep.LocationType === 'Virtual' || (!ep.Path && !ep.Container));
        if (isVirtualSpecial) {
          continue;
        }

        const seasonKey = String(seasonNum);
        const epKey = String(epNum);

        let season = seasons[seasonKey];
        if (!season) {
          season = { episodes: {} };
          seasons[seasonKey] = season;
        }
        if (!season.episodes) {
          season.episodes = {};
        }

        const existingEp = season.episodes[epKey];
        if (existingEp) {
          // CRITICAL: PRESERVE EXISTING MANUAL OVERRIDE!
          summary.preservedManualEpisodes++;
          if (!existingEp.name && ep.Name) {
            existingEp.name = ep.Name;
          }
        } else {
          // New episode added to overrides index
          const newEp: RawEpisodeOverride = {
            name: ep.Name ?? `Episode ${epNum}`,
          };
          season.episodes[epKey] = newEp;
          summary.episodesAdded++;
        }
      }
    }

    // 5. Merge Movies into overrides (Season 0, Episode 1)
    for (const movie of moviesList) {
      const mProv = movie.ProviderIds ?? {};
      const tvdbId = mProv.Tvdb || mProv.tvdb;
      const tmdbId = mProv.Tmdb || mProv.tmdb;
      const showKey = tvdbId
        ? String(tvdbId).trim()
        : tmdbId
          ? `tmdb-${String(tmdbId).trim()}`
          : `jf-${String(movie.Id).trim()}`;

      let show = currentOverrides[showKey];
      if (!show) {
        show = {
          title: movie.Name,
          tmdbId: mProv.Tmdb || mProv.tmdb,
          seasons: {},
        };
        currentOverrides[showKey] = show;
        summary.showsAdded++;
      } else {
        if (!show.title && movie.Name) show.title = movie.Name;
        if (!show.tmdbId && (mProv.Tmdb || mProv.tmdb)) {
          show.tmdbId = mProv.Tmdb || mProv.tmdb;
        }
        if (!show.seasons) show.seasons = {};
      }

      const seasons = show.seasons as Record<string, RawSeasonOverride>;
      let season0 = seasons['0'];
      if (!season0) {
        season0 = { episodes: {} };
        seasons['0'] = season0;
      }
      if (!season0.episodes) {
        season0.episodes = {};
      }

      const existingEp = season0.episodes['1'];
      if (existingEp) {
        summary.preservedManualEpisodes++;
        if (!existingEp.name && movie.Name) {
          existingEp.name = movie.Name;
        }
      } else {
        season0.episodes['1'] = {
          name: movie.Name ?? 'Movie',
        };
        summary.episodesAdded++;
      }
    }
  }

  // 6. Back up existing file and save updated mapping-overrides.json
  if (existsSync(filePath)) {
    try {
      backupPath = filePath.replace(/\.json$/, `.backup.${Date.now()}.json`);
      copyFileSync(filePath, backupPath);
      summary.backupPath = backupPath;
      logger.info(`[Importer] Backed up existing overrides to ${backupPath}`);
    } catch (err) {
      logger.warn('[Importer] Failed creating backup of overrides file:', err);
    }
  }

  writeFileSync(filePath, JSON.stringify(currentOverrides, null, 2), 'utf-8');
  logger.info(
    `[Importer] Successfully saved merged overrides to ${filePath} (${summary.showsAdded} shows added, ${summary.episodesAdded} episodes added, ${summary.preservedManualEpisodes} manual mappings preserved)`,
  );

  // 7. Reload AnimeResolver indices with new overrides
  try {
    await defaultAnimeResolver.initialize();
    logger.info('[Importer] Reloaded AnimeResolver indices with updated mapping overrides.');
  } catch (err) {
    logger.error('[Importer] Failed reloading AnimeResolver after import:', err);
  }

  return summary;
};
