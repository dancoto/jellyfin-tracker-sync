import { Component, computed, input, output, signal } from '@angular/core';
import { CatalogEpisode, CatalogShow, OfficialEpisodeInfo, RawEpisodeOverride, RawShowOverride } from '../../models/types';
import { EpisodeRowComponent } from '../episode-row/episode-row.component';
import {
  isEpisodeMissingAniList,
  isEpisodeOnDisk,
  isEpisodeOverridden,
  isEpisodeSkipped,
} from '../../stores/overrides.store.utils';

import { MatExpansionPanel, MatExpansionPanelContent, MatExpansionPanelHeader, MatExpansionPanelTitle } from '@angular/material/expansion';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

export interface EpisodeViewItem {
  epNum: string;
  episode: CatalogEpisode;
  exists: boolean;
  official: OfficialEpisodeInfo | null;
  override: RawEpisodeOverride | undefined;
}

export interface SeasonViewItem {
  seasonNum: string;
  label: string;
  episodes: EpisodeViewItem[];
  seasonMissing: number;
  seasonOverridden: number;
  seasonSkipped: number;
  isSeasonAllSkipped: boolean;
  anilistUrl?: string;
}

@Component({
  selector: 'app-series-card',
  imports: [
    EpisodeRowComponent,
    MatExpansionPanel,
    MatExpansionPanelContent,
    MatExpansionPanelHeader,
    MatExpansionPanelTitle,
    MatButton,
    MatIcon,
    MatTooltip,
    MatProgressSpinner,
  ],
  templateUrl: './series-card.component.html',
  styleUrl: './series-card.component.css',
})
export class SeriesCardComponent {
  tvdbId = input.required<string>();
  show = input.required<CatalogShow>();
  overrideShow = input<RawShowOverride | undefined>();
  officialShow = input<Record<string, Record<string, OfficialEpisodeInfo | null>> | undefined>();
  isModified = input<boolean>(false);
  isOpen = input<boolean>(false);
  isSyncing = input<boolean>(false);

  toggleOpen = output<void>();
  syncSeries = output<string>();
  saveSeries = output<string>();
  cancelSeries = output<string>();
  updateEpisode = output<{
    seasonNum: string;
    epNum: string;
    field: 'anilistId' | 'anilistEpisode';
    value: string;
  }>();
  useOfficialEpisode = output<{ seasonNum: string; epNum: string }>();
  toggleSkipEpisode = output<{ seasonNum: string; epNum: string }>();
  clearOverrideEpisode = output<{ seasonNum: string; epNum: string }>();
  applyBatchSeason = output<{ seasonNum: string; anilistId: number }>();
  applyOfficialSeason = output<{ seasonNum: string }>();
  skipUnmappedSeason = output<{ seasonNum: string }>();

  isTvdbNumeric = computed(() => {
    const id = this.tvdbId();
    return Boolean(id && /^\d+$/.test(id.trim()));
  });

  batchInputs = signal<Record<string, string>>({});

  onExpandedChange(expanded: boolean) {
    if (expanded !== this.isOpen()) {
      this.toggleOpen.emit();
    }
  }

  getOfficialEp(seasonNum: string, epNum: string): OfficialEpisodeInfo | null {
    return this.officialShow()?.[seasonNum]?.[epNum] ?? null;
  }

  getOverrideEp(seasonNum: string, epNum: string): RawEpisodeOverride | undefined {
    return this.overrideShow()?.seasons?.[seasonNum]?.episodes?.[epNum];
  }

  isEpSkipped(seasonNum: string, epNum: string): boolean {
    return isEpisodeSkipped(this.getOverrideEp(seasonNum, epNum));
  }

  isEpMissingAniList(seasonNum: string, epNum: string): boolean {
    return isEpisodeMissingAniList(
      this.getOverrideEp(seasonNum, epNum),
      this.getOfficialEp(seasonNum, epNum)
    );
  }

  isEpOverridden(seasonNum: string, epNum: string): boolean {
    return isEpisodeOverridden(
      this.getOverrideEp(seasonNum, epNum),
      this.getOfficialEp(seasonNum, epNum)
    );
  }

  isMovie = computed(() => {
    if (this.show().isMovie !== undefined) {
      return Boolean(this.show().isMovie);
    }
    const seasons = Object.keys(this.show().seasons || {});
    if (seasons.length === 1 && seasons[0] === '0') {
      const eps = Object.keys(this.show().seasons['0']?.episodes || {});
      if (eps.length === 1 && eps[0] === '1') {
        const epName = this.show().seasons['0']?.episodes['1']?.name;
        if (epName === 'Movie' || epName === this.show().title) {
          return true;
        }
      }
    }
    return false;
  });

  showStats = computed(() => {
    let missing = 0;
    let overridden = 0;
    let skipped = 0;
    let total = 0;

    const s = this.show();
    for (const [, season] of Object.entries(s.seasons || {})) {
      for (const [eKey, ep] of Object.entries(season.episodes || {})) {
        total++;
        if (this.isEpSkipped(String(season.seasonNumber), eKey)) {
          skipped++;
        } else if (this.isEpMissingAniList(String(season.seasonNumber), eKey)) {
          if (isEpisodeOnDisk(ep, s)) {
            missing++;
          }
        }
        if (this.isEpOverridden(String(season.seasonNumber), eKey)) {
          overridden++;
        }
      }
    }

    return { missing, overridden, skipped, total };
  });

  sortedSeasons = computed<SeasonViewItem[]>(() => {
    const s = this.show();
    return Object.entries(s.seasons || {})
      .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
      .map(([seasonNum, season]) => {
        const rawEpisodes = Object.entries(season.episodes || {}).sort(
          ([a], [b]) => parseInt(a, 10) - parseInt(b, 10),
        );

        let seasonMissing = 0;
        let seasonOverridden = 0;
        let seasonSkipped = 0;
        let primaryAnilistId: number | null = null;

        const episodes: EpisodeViewItem[] = rawEpisodes.map(([epNum, epObj]) => {
          const exists = isEpisodeOnDisk(epObj, s);
          const official = this.getOfficialEp(seasonNum, epNum);
          const override = this.getOverrideEp(seasonNum, epNum);

          if (isEpisodeSkipped(override)) {
            seasonSkipped++;
          } else if (isEpisodeMissingAniList(override, official)) {
            if (exists) {
              seasonMissing++;
            }
          }
          if (isEpisodeOverridden(override, official)) {
            seasonOverridden++;
          }

          if (primaryAnilistId === null) {
            if (override && typeof override.anilistId === 'number') {
              primaryAnilistId = override.anilistId;
            } else if (override?.anilistId !== null && official?.anilistId) {
              primaryAnilistId = official.anilistId;
            }
          }

          return {
            epNum,
            episode: epObj,
            exists,
            official,
            override,
          };
        });

        const isSeasonAllSkipped = seasonSkipped === episodes.length && episodes.length > 0;

        const seasonName = season.name?.trim();
        let label: string;
        if (seasonNum === '0') {
          label = 'Specials (Season 0)';
        } else if (seasonName && !/^season\s*\d+$/i.test(seasonName)) {
          label = seasonName.toLowerCase().startsWith(`season ${seasonNum}`.toLowerCase())
            ? seasonName
            : `Season ${seasonNum}: ${seasonName}`;
        } else {
          label = `Season ${seasonNum}`;
        }

        const anilistUrl = primaryAnilistId
          ? `https://anilist.co/anime/${primaryAnilistId}`
          : undefined;

        return {
          seasonNum,
          label,
          episodes,
          seasonMissing,
          seasonOverridden,
          seasonSkipped,
          isSeasonAllSkipped,
          anilistUrl,
        };
      });
  });

  updateBatchInput(seasonNum: string, event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.batchInputs.update(current => ({ ...current, [seasonNum]: value }));
  }

  handleApplyBatch(seasonNum: string) {
    const val = this.batchInputs()[seasonNum]?.trim();
    if (!val) return;
    const num = parseInt(val, 10);
    if (Number.isInteger(num)) {
      this.applyBatchSeason.emit({ seasonNum, anilistId: num });
      this.batchInputs.update(current => ({ ...current, [seasonNum]: '' }));
    }
  }

  handleCancel() {
    this.batchInputs.set({});
    this.cancelSeries.emit(this.tvdbId());
  }
}
