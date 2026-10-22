import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultAnimeResolver } from '../anime';
import { isExcludedLibrary } from '../jellyfin/normalizer';
import { syncJellyfinCatalog } from '../overrides/catalog';
import { importJellyfinAnimeMappings } from '../overrides/importer';
import { appConfig } from '../shared/config';

interface EpisodeItem {
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

interface SeriesItem {
  Id: string;
  Name?: string;
  ProviderIds?: Record<string, string>;
}

interface MissingEpisodeEntry {
  seriesName: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeName: string;
  seriesTvdbId?: string;
  seriesTmdbId?: string;
  episodeTvdbId?: string;
  episodeTmdbId?: string;
  status: 'missing_anilist' | 'missing_tvdb';
  resolvedAniListId?: number;
  resolvedAniListEpisode?: number;
}

interface SeriesSummary {
  seriesName: string;
  seriesTvdbId?: string;
  seriesTmdbId?: string;
  missingCount: number;
  missingAniListCount: number;
  episodes: MissingEpisodeEntry[];
}

interface AuditReport {
  generatedAt: string;
  libraryName: string;
  summary: {
    totalEpisodesAudited: number;
    totalFullyMatched: number;
    totalSkipped: number;
    totalUnresolved: number;
    missingAniListCount: number;
    missingTvdbCount: number;
    affectedSeriesCount: number;
  };
  unresolvedBySeries: SeriesSummary[];
  allUnresolvedEpisodes: MissingEpisodeEntry[];
}

const parseArgs = () => {
  const args = process.argv.slice(2);
  let explicitLibrary: string | undefined = undefined;
  let outputPath = 'data/missing-anime.json';
  let generateTemplate = false;
  let importAll = false;
  let syncCatalog = false;

  for (const arg of args) {
    if (arg.startsWith('--library=')) {
      explicitLibrary = arg.split('=')[1] || undefined;
    } else if (arg.startsWith('--output=')) {
      outputPath = arg.split('=')[1] || outputPath;
    } else if (arg === '--template' || arg === '--generate-template') {
      generateTemplate = true;
    } else if (arg === '--import' || arg === '--import-all' || arg === '--all') {
      importAll = true;
    } else if (arg === '--sync-catalog' || arg === '--catalog') {
      syncCatalog = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: bun scripts/find-missing-anime.ts [options]

Options:
  --library=<name>   Jellyfin library name to scan (default: "Anime" for audit, all anime libraries for catalog sync)
  --output=<file>    Destination JSON file path (default: "data/missing-anime.json")
  --sync-catalog     Sync Jellyfin anime library into data/anime-catalog.db without modifying overrides
  --template         Merge unresolved anime into mapping-overrides.json
  --import-all       Bulk import ALL anime from Jellyfin into mapping-overrides.json
  --help, -h         Show this help message
      `);
      process.exit(0);
    }
  }

  const libraryName = explicitLibrary || 'Anime';
  return { libraryName, explicitLibrary, outputPath, generateTemplate, importAll, syncCatalog };
};

export const runAudit = async () => {
  const { libraryName, explicitLibrary, outputPath, generateTemplate, importAll, syncCatalog } =
    parseArgs();

  const jellyfinConfig = appConfig.jellyfin;
  if (!jellyfinConfig?.url || !jellyfinConfig?.token) {
    console.error('Error: Jellyfin is not configured in config.toml (missing url or token).');
    process.exit(1);
  }

  if (syncCatalog) {
    console.log('Syncing Jellyfin anime catalog...');
    const summary = await syncJellyfinCatalog({
      libraryNames: explicitLibrary ? [explicitLibrary] : undefined,
    });
    console.log('\n================ CATALOG SYNC SUMMARY ================');
    console.log(`Libraries scanned:            ${summary.librariesScanned.join(', ')}`);
    console.log(`Series scanned:               ${summary.totalSeriesScanned}`);
    console.log(`Episodes scanned:             ${summary.totalEpisodesScanned}`);
    console.log(`Catalog shows count:          ${summary.catalogShowsCount}`);
    console.log(`Catalog episodes count:       ${summary.catalogEpisodesCount}`);
    console.log(`Catalog saved at:             data/anime-catalog.db`);
    console.log('======================================================\n');
    return;
  }

  if (importAll) {
    console.log('Running bulk import of all anime from Jellyfin...');
    const summary = await importJellyfinAnimeMappings({
      libraryNames: explicitLibrary ? [explicitLibrary] : undefined,
    });
    console.log('\n================ BULK IMPORT SUMMARY ================');
    console.log(`Libraries scanned:            ${summary.librariesScanned.join(', ')}`);
    console.log(`Series scanned:               ${summary.totalSeriesScanned}`);
    console.log(`Episodes scanned:             ${summary.totalEpisodesScanned}`);
    console.log(`New shows added:              ${summary.showsAdded}`);
    console.log(`New episodes added:           ${summary.episodesAdded}`);
    console.log(`Manual mappings preserved:    ${summary.preservedManualEpisodes}`);
    if (summary.backupPath) {
      console.log(`Backup created at:            ${summary.backupPath}`);
    }
    console.log('=====================================================\n');
    return;
  }

  console.log('1. Initializing Anime Resolver (AniBridge + Anime-Lists)...');
  await defaultAnimeResolver.initialize();

  const headers = {
    Authorization: `MediaBrowser Token="${jellyfinConfig.token}"`,
    Accept: 'application/json',
  };

  console.log(`2. Finding Jellyfin library "${libraryName}"...`);
  const vFoldersRes = await fetch(`${jellyfinConfig.url}/Library/VirtualFolders`, { headers });
  if (!vFoldersRes.ok) {
    throw new Error(
      `Failed to fetch Jellyfin virtual folders: HTTP ${vFoldersRes.status} ${vFoldersRes.statusText}`,
    );
  }
  const vFolders = (await vFoldersRes.json()) as Array<{ Name: string; ItemId: string }>;
  const targetFolder = vFolders.find(
    (f) =>
      !isExcludedLibrary(f.Name) &&
      (f.Name.toLowerCase() === libraryName.toLowerCase() ||
        f.Name.toLowerCase().includes(libraryName.toLowerCase())),
  );

  if (!targetFolder) {
    console.error(`Error: Library "${libraryName}" not found on Jellyfin.`);
    console.log('Available libraries:', vFolders.map((f) => f.Name).join(', '));
    process.exit(1);
  }

  console.log(`   Found library "${targetFolder.Name}" (ID: ${targetFolder.ItemId})`);

  console.log('3. Loading all series metadata from library...');
  const seriesUrl = new URL('/Items', jellyfinConfig.url);
  seriesUrl.searchParams.set('parentId', targetFolder.ItemId);
  seriesUrl.searchParams.set('recursive', 'true');
  seriesUrl.searchParams.set('includeItemTypes', 'Series');
  seriesUrl.searchParams.set('fields', 'ProviderIds,Name');

  const seriesRes = await fetch(seriesUrl.toString(), { headers });
  if (!seriesRes.ok) {
    throw new Error(`Failed to fetch series: HTTP ${seriesRes.status}`);
  }
  const seriesData = (await seriesRes.json()) as { Items?: SeriesItem[] };
  const seriesItems = seriesData.Items || [];

  const seriesMap = new Map<
    string,
    { name: string; providerIds: Record<string, string | undefined> }
  >();
  for (const item of seriesItems) {
    const normProv: Record<string, string | undefined> = {};
    if (item.ProviderIds) {
      for (const [k, v] of Object.entries(item.ProviderIds)) {
        if (v) normProv[k.toLowerCase()] = String(v);
      }
    }
    seriesMap.set(item.Id, {
      name: item.Name || 'Unknown Series',
      providerIds: normProv,
    });
  }
  console.log(`   Loaded ${seriesMap.size} series.`);

  console.log('4. Fetching episodes and auditing mappings...');
  const pageSize = 1000;
  let startIndex = 0;
  let totalEpisodes = 0;
  let fullyMatchedCount = 0;
  let skippedCount = 0;
  const unresolvedEpisodes: MissingEpisodeEntry[] = [];

  while (true) {
    const epUrl = new URL('/Items', jellyfinConfig.url);
    epUrl.searchParams.set('parentId', targetFolder.ItemId);
    epUrl.searchParams.set('recursive', 'true');
    epUrl.searchParams.set('includeItemTypes', 'Episode');
    epUrl.searchParams.set('startIndex', String(startIndex));
    epUrl.searchParams.set('limit', String(pageSize));
    epUrl.searchParams.set(
      'fields',
      'ProviderIds,SeriesId,SeriesName,IndexNumber,ParentIndexNumber,Name,LocationType,Path',
    );

    const epRes = await fetch(epUrl.toString(), { headers });
    if (!epRes.ok) {
      throw new Error(`Failed to fetch episodes at index ${startIndex}: HTTP ${epRes.status}`);
    }

    const epData = (await epRes.json()) as {
      TotalRecordCount?: number;
      Items?: EpisodeItem[];
    };
    const items = epData.Items || [];
    if (totalEpisodes === 0 && epData.TotalRecordCount !== undefined) {
      totalEpisodes = epData.TotalRecordCount;
      console.log(`   Total episodes on server: ${totalEpisodes}`);
    }

    if (items.length === 0) {
      break;
    }

    for (const ep of items) {
      const seasonNumber = ep.ParentIndexNumber ?? 0;
      const episodeNumber = ep.IndexNumber ?? 1;

      // Exclude specials (Season 0) that do not exist in Jellyfin (virtual / missing)
      const isVirtualSpecial =
        seasonNumber === 0 && (ep.LocationType === 'Virtual' || (!ep.Path && !ep.Container));
      if (isVirtualSpecial) {
        continue;
      }

      const sId = ep.SeriesId || '';
      const sInfo = seriesMap.get(sId);
      const seriesName = sInfo?.name ?? ep.SeriesName ?? 'Unknown Series';
      const episodeName = ep.Name ?? `Episode ${episodeNumber}`;

      const sProv = sInfo?.providerIds ?? {};
      const epProv: Record<string, string | undefined> = {};
      if (ep.ProviderIds) {
        for (const [k, v] of Object.entries(ep.ProviderIds)) {
          if (v) epProv[k.toLowerCase()] = String(v);
        }
      }

      const tvdbId = sProv.tvdb ?? epProv.tvdb;
      const tmdbId = sProv.tmdb ?? epProv.tmdb;
      const anilistId = sProv.anilist ?? epProv.anilist;

      if (!tvdbId) {
        unresolvedEpisodes.push({
          seriesName,
          seasonNumber,
          episodeNumber,
          episodeName,
          seriesTvdbId: sProv.tvdb,
          seriesTmdbId: sProv.tmdb,
          episodeTvdbId: epProv.tvdb,
          episodeTmdbId: epProv.tmdb,
          status: 'missing_tvdb',
        });
        continue;
      }

      const resolved = defaultAnimeResolver.resolveEpisode(
        {
          tvdbId,
          tmdbId,
          anilistId,
        },
        seasonNumber,
        episodeNumber,
      );

      if (resolved?.isSkipped) {
        skippedCount++;
        continue;
      }

      const hasAniList = Boolean(resolved?.anilist?.mediaId) || Boolean(resolved?.skipAniList);

      if (hasAniList) {
        // Matched or intentionally skipped! Exclude from output as requested.
        if (resolved?.skipAniList) {
          skippedCount++;
        } else {
          fullyMatchedCount++;
        }
      } else {
        unresolvedEpisodes.push({
          seriesName,
          seasonNumber,
          episodeNumber,
          episodeName,
          seriesTvdbId: sProv.tvdb,
          seriesTmdbId: sProv.tmdb,
          episodeTvdbId: epProv.tvdb,
          episodeTmdbId: epProv.tmdb,
          status: !sProv.tvdb ? 'missing_tvdb' : 'missing_anilist',
          resolvedAniListId: resolved?.anilist?.mediaId,
          resolvedAniListEpisode: resolved?.anilist?.episodeNumber,
        });
      }
    }

    startIndex += items.length;
    process.stdout.write(
      `   Audited ${startIndex} / ${totalEpisodes || startIndex} episodes (${fullyMatchedCount} matched, ${unresolvedEpisodes.length} unresolved)...\r`,
    );

    if (items.length < pageSize) {
      break;
    }
  }

  process.stdout.write('\n');

  // Group by series
  const seriesGroups = new Map<string, SeriesSummary>();
  let missingAniListCount = 0;
  let missingTvdbCount = 0;

  for (const ep of unresolvedEpisodes) {
    const hasAniList = Boolean(ep.resolvedAniListId);
    if (!hasAniList) missingAniListCount++;
    if (ep.status === 'missing_tvdb') missingTvdbCount++;

    let group = seriesGroups.get(ep.seriesName);
    if (!group) {
      group = {
        seriesName: ep.seriesName,
        seriesTvdbId: ep.seriesTvdbId,
        seriesTmdbId: ep.seriesTmdbId,
        missingCount: 0,
        missingAniListCount: 0,
        episodes: [],
      };
      seriesGroups.set(ep.seriesName, group);
    }

    group.missingCount++;
    if (ep.status === 'missing_anilist') group.missingAniListCount++;
    group.episodes.push(ep);
  }

  const unresolvedBySeries = Array.from(seriesGroups.values()).sort(
    (a, b) => b.missingCount - a.missingCount || a.seriesName.localeCompare(b.seriesName),
  );

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    libraryName: targetFolder.Name,
    summary: {
      totalEpisodesAudited: startIndex,
      totalFullyMatched: fullyMatchedCount,
      totalSkipped: skippedCount,
      totalUnresolved: unresolvedEpisodes.length,
      missingAniListCount,
      missingTvdbCount,
      affectedSeriesCount: unresolvedBySeries.length,
    },
    unresolvedBySeries,
    allUnresolvedEpisodes: unresolvedEpisodes,
  };

  const resolvedOutputPath = resolve(outputPath);
  const outDir = dirname(resolvedOutputPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  writeFileSync(resolvedOutputPath, JSON.stringify(report, null, 2), 'utf-8');

  if (generateTemplate) {
    const templatePath = resolve('mapping-overrides.json');
    let overrides: Record<string, any> = {};
    if (existsSync(templatePath)) {
      try {
        overrides = JSON.parse(readFileSync(templatePath, 'utf-8'));
      } catch {
        overrides = {};
      }
    }

    for (const s of unresolvedBySeries) {
      if (!s.seriesTvdbId) continue;

      let show = overrides[s.seriesTvdbId];
      if (!show) {
        show = {
          title: s.seriesName,
          tmdbId: s.seriesTmdbId,
          seasons: {},
        };
        overrides[s.seriesTvdbId] = show;
      }
      if (!show.seasons) show.seasons = {};

      const bySeason = new Map<number, MissingEpisodeEntry[]>();
      for (const ep of s.episodes) {
        let list = bySeason.get(ep.seasonNumber);
        if (!list) {
          list = [];
          bySeason.set(ep.seasonNumber, list);
        }
        list.push(ep);
      }

      const sortedSeasons = Array.from(bySeason.keys()).sort((a, b) => a - b);
      for (const seasonNum of sortedSeasons) {
        const seasonKey = String(seasonNum);
        let season = show.seasons[seasonKey];
        if (!season) {
          season = { episodes: {} };
          show.seasons[seasonKey] = season;
        }
        if (!season.episodes) season.episodes = {};

        const eps = bySeason.get(seasonNum) || [];
        eps.sort((a, b) => a.episodeNumber - b.episodeNumber);

        for (const ep of eps) {
          const epKey = String(ep.episodeNumber);
          if (!season.episodes[epKey]) {
            season.episodes[epKey] = {
              name: ep.episodeName,
              anilistId: ep.resolvedAniListId ?? null,
              anilistEpisode:
                ep.resolvedAniListEpisode ?? (ep.resolvedAniListId ? ep.episodeNumber : null),
            };
          }
        }
      }
    }

    writeFileSync(templatePath, JSON.stringify(overrides, null, 2), 'utf-8');
    console.log(`Merged unresolved overrides into: ${templatePath}`);
  }

  console.log('\n================ AUDIT SUMMARY ================');
  console.log(`Total episodes scanned:       ${startIndex}`);
  console.log(`Fully matched (excluded):     ${fullyMatchedCount}`);
  console.log(`Total unresolved saved:       ${unresolvedEpisodes.length}`);
  console.log(`  - Missing AniList:          ${missingAniListCount}`);
  console.log(`  - Missing TVDB in Jellyfin: ${missingTvdbCount}`);
  console.log(`Affected series:              ${unresolvedBySeries.length}`);
  console.log(`Report written to:            ${resolvedOutputPath}`);
  if (generateTemplate) {
    console.log(`Overrides template:           ${resolve('mapping-overrides.json')}`);
  }
  console.log('================================================\n');
};

runAudit().catch((error) => {
  console.error('Audit failed with error:', error);
  process.exit(1);
});
