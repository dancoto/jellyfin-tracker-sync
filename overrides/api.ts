import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultAnimeResolver, type AnimeResolver } from '../anime';
import {
  TvdbOverridesIndex,
  type RawShowOverride,
  type RawTvdbOverrides,
} from '../anime/tvdb-overrides';
import {
  loadCatalog,
  pruneSparseOverrides,
  syncJellyfinCatalog,
  syncJellyfinSeries,
  type AnimeCatalog,
  type CatalogSyncOptions,
} from './catalog';
import { retireRedundantOverrides } from './retire';

export interface OfficialEpisodeInfo {
  anilistId: number;
  anilistEpisode: number;
}

export type OfficialMappingsMap = Record<
  string,
  Record<string, Record<string, OfficialEpisodeInfo | null>>
>;

export const handleGetOverrides = async (): Promise<Response> => {
  if (!defaultAnimeResolver.isInitialized()) {
    try {
      await defaultAnimeResolver.initialize();
    } catch (err) {
      console.warn('AnimeResolver: failed initializing in handleGetOverrides:', err);
    }
  }

  const filePath = TvdbOverridesIndex.getFilePath();
  let overrides: RawTvdbOverrides = {};

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      overrides = JSON.parse(content) as RawTvdbOverrides;
    } catch (err) {
      console.error(`Failed to read overrides from ${filePath}:`, err);
    }
  }

  // Load Jellyfin anime catalog
  const catalogData = loadCatalog();
  const catalogShows: AnimeCatalog = { ...catalogData.shows };

  // Ensure any shows present in overrides but missing from catalog are represented
  for (const [tvdbId, show] of Object.entries(overrides)) {
    if (!catalogShows[tvdbId]) {
      catalogShows[tvdbId] = {
        tvdbId,
        title: show.title || `Show ${tvdbId}`,
        tmdbId: show.tmdbId,
        seasons: {},
      };
      for (const [sKey, sea] of Object.entries(show.seasons || {})) {
        const sNum = parseInt(sKey, 10);
        catalogShows[tvdbId].seasons[sKey] = {
          seasonNumber: sNum,
          name: sea.name,
          episodes: {},
        };
        for (const [eKey, ep] of Object.entries(sea.episodes || {})) {
          catalogShows[tvdbId].seasons[sKey].episodes[eKey] = {
            episodeNumber: parseInt(eKey, 10),
            name: ep.name,
            exists: false,
          };
        }
      }
    }
  }

  // Pre-compute official AniList mappings for all episodes in the catalog
  const official: OfficialMappingsMap = {};
  for (const [tvdbId, show] of Object.entries(catalogShows)) {
    official[tvdbId] = {};
    for (const [seasonNumStr, season] of Object.entries(show.seasons || {})) {
      const seasonNum = parseInt(seasonNumStr, 10);
      official[tvdbId][seasonNumStr] = {};
      for (const [epNumStr] of Object.entries(season.episodes || {})) {
        const epNum = parseInt(epNumStr, 10);
        let resolved = defaultAnimeResolver.resolveOfficialEpisode(
          { tvdbId, tmdbId: show.tmdbId },
          seasonNum,
          epNum,
        );

        // Fallback: If Season 0 Episode 1 (standalone movie) is not a TV special, check official movie mapping
        if (!resolved?.anilist && seasonNum === 0 && epNum === 1) {
          const movieResolved = defaultAnimeResolver.resolveOfficialMovie({
            tvdbId,
            tmdbId: show.tmdbId,
          });
          if (movieResolved?.anilist) {
            resolved = {
              episodeNumber: movieResolved.episodeNumber,
              isSpecial: false,
              kind: 'regular',
              source: movieResolved.source,
              anilist: movieResolved.anilist,
            };
          }
        }

        if (resolved?.anilist) {
          official[tvdbId][seasonNumStr][epNumStr] = {
            anilistId: resolved.anilist.mediaId,
            anilistEpisode: resolved.anilist.episodeNumber,
          };
        } else {
          official[tvdbId][seasonNumStr][epNumStr] = null;
        }
      }
    }
  }

  return Response.json({
    filePath,
    catalog: catalogShows,
    overrides,
    official,
    lastUpdated: catalogData.lastUpdated,
  });
};

export const handleSaveOverrides = async (req: Request): Promise<Response> => {
  try {
    const body = (await req.json()) as {
      overrides?: RawTvdbOverrides;
      tvdbId?: string;
      show?: RawShowOverride;
    };

    const filePath = TvdbOverridesIndex.getFilePath();
    let currentOverrides: RawTvdbOverrides = {};

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        currentOverrides = JSON.parse(content) as RawTvdbOverrides;
      } catch {
        currentOverrides = {};
      }
    }

    if (body.overrides) {
      currentOverrides = pruneSparseOverrides(body.overrides);
    } else if (body.tvdbId && body.show) {
      const prunedSingle = pruneSparseOverrides({ [body.tvdbId]: body.show });
      const singleShow = prunedSingle[body.tvdbId];
      if (singleShow) {
        currentOverrides[body.tvdbId] = singleShow;
      } else {
        delete currentOverrides[body.tvdbId];
      }
    } else {
      return Response.json(
        { error: 'Missing overrides or tvdbId/show parameters' },
        { status: 400 },
      );
    }

    writeFileSync(filePath, JSON.stringify(currentOverrides, null, 2), 'utf-8');
    console.log(`Saved mapping overrides to ${filePath}`);

    // Re-initialize resolver so overrides take effect immediately in memory
    try {
      await defaultAnimeResolver.initialize();
      console.log('Reloaded AnimeResolver indices with new overrides');
    } catch (err) {
      console.error('Failed reloading AnimeResolver:', err);
    }

    return Response.json({ status: 'saved' });
  } catch (err) {
    console.error('Error saving overrides:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};

export const handleSyncCatalog = async (req: Request): Promise<Response> => {
  try {
    let options: CatalogSyncOptions | undefined;
    if (req.headers.get('content-type')?.includes('application/json')) {
      try {
        options = (await req.json()) as CatalogSyncOptions;
      } catch {
        options = undefined;
      }
    }

    const effectiveOptions: CatalogSyncOptions = {
      ...options,
      pruneDeletedOverrides: options?.pruneDeletedOverrides !== false,
    };

    const summary = await syncJellyfinCatalog(effectiveOptions);
    return Response.json({
      success: true,
      summary,
    });
  } catch (err) {
    console.error('Error during Jellyfin catalog sync:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};

/** Alias for backward compatibility */
export const handleImportOverrides = handleSyncCatalog;

export const handleRetireRedundantOverrides = async (
  req: Request,
  customResolver?: AnimeResolver,
): Promise<Response> => {
  try {
    let customOverridesPath: string | undefined;
    if (req.headers.get('content-type')?.includes('application/json')) {
      try {
        const body = (await req.json()) as { customOverridesPath?: string };
        customOverridesPath = body.customOverridesPath;
      } catch {
        customOverridesPath = undefined;
      }
    }

    const resolver = customResolver || defaultAnimeResolver;
    if (!resolver.isInitialized()) {
      await resolver.initialize();
    }

    const summary = retireRedundantOverrides({
      customOverridesPath,
      resolver,
    });

    return Response.json({
      success: true,
      summary,
    });
  } catch (err) {
    console.error('Error retiring redundant overrides:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};

export const handleSyncSeries = async (req: Request): Promise<Response> => {
  try {
    const body = (await req.json()) as {
      tvdbId?: string;
      customCatalogPath?: string;
      customOverridesPath?: string;
    };

    if (!body.tvdbId) {
      return Response.json({ error: 'Missing tvdbId parameter' }, { status: 400 });
    }

    const summary = await syncJellyfinSeries(body.tvdbId, {
      customCatalogPath: body.customCatalogPath,
      customOverridesPath: body.customOverridesPath,
      pruneDeletedOverrides: true,
    });

    const officialForShow: Record<
      string,
      Record<string, { anilistId: number; anilistEpisode: number } | null>
    > = {};

    if (summary.show) {
      for (const [seasonNumStr, season] of Object.entries(summary.show.seasons || {})) {
        const seasonNum = parseInt(seasonNumStr, 10);
        officialForShow[seasonNumStr] = {};
        for (const [epNumStr] of Object.entries(season.episodes || {})) {
          const epNum = parseInt(epNumStr, 10);
          let resolved = defaultAnimeResolver.resolveOfficialEpisode(
            { tvdbId: summary.tvdbId, tmdbId: summary.show.tmdbId },
            seasonNum,
            epNum,
          );

          if (!resolved?.anilist && seasonNum === 0 && epNum === 1) {
            const movieResolved = defaultAnimeResolver.resolveOfficialMovie({
              tvdbId: summary.tvdbId,
              tmdbId: summary.show.tmdbId,
            });
            if (movieResolved?.anilist) {
              resolved = {
                episodeNumber: movieResolved.episodeNumber,
                isSpecial: false,
                kind: 'regular',
                source: movieResolved.source,
                anilist: movieResolved.anilist,
              };
            }
          }

          if (resolved?.anilist) {
            officialForShow[seasonNumStr][epNumStr] = {
              anilistId: resolved.anilist.mediaId,
              anilistEpisode: resolved.anilist.episodeNumber,
            };
          } else {
            officialForShow[seasonNumStr][epNumStr] = null;
          }
        }
      }
    }

    return Response.json({
      success: true,
      summary,
      official: officialForShow,
    });
  } catch (err) {
    console.error('Error syncing series from Jellyfin:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
