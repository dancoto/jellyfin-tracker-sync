import { Component, computed, input, output } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { OfficialEpisodeInfo, RawEpisodeOverride } from '../../models/types';
import {
  isEpisodeMissingAniList,
  isEpisodeOverridden,
  isEpisodeSkipped,
} from '../../stores/overrides.store.utils';

@Component({
  selector: 'tr[app-episode-row]',
  imports: [MatButton, MatTooltip],
  templateUrl: './episode-row.component.html',
  styleUrl: './episode-row.component.css',
  host: {
    '[class]': 'rowClass()',
  },
})
export class EpisodeRowComponent {
  tvdbId = input.required<string>();
  seasonNum = input.required<string>();
  epNum = input.required<string>();
  epName = input.required<string>();
  exists = input<boolean>(false);
  isMovie = input<boolean>(false);
  official = input<OfficialEpisodeInfo | null | undefined>();
  override = input<RawEpisodeOverride | undefined>();

  updateField = output<{ field: 'anilistId' | 'anilistEpisode'; value: string }>();
  useOfficial = output<void>();
  toggleSkip = output<void>();
  clearOverride = output<void>();

  isAniListSkipped = computed(() => isEpisodeSkipped(this.override()));
  isMissingAniList = computed(() =>
    isEpisodeMissingAniList(this.override(), this.official())
  );
  isOverridden = computed(() =>
    isEpisodeOverridden(this.override(), this.official())
  );

  rowClass = computed(() => {
    if (this.isAniListSkipped()) return 'skipped-anilist-row';
    if (this.isMissingAniList() && (this.isMovie() || this.exists())) return 'missing-anilist-row';
    if (this.isOverridden()) return 'overridden-row';
    return '';
  });

  statusPill = computed(() => {
    if (this.isAniListSkipped()) {
      return { text: '🌸 Skipped', class: 'skipped', title: 'AniList scrobbling skipped for this episode' };
    }
    const ovr = this.override();
    const off = this.official();
    if (ovr && typeof ovr.anilistId === 'number') {
      if (off && off.anilistId === ovr.anilistId && off.anilistEpisode === ovr.anilistEpisode) {
        return { text: '✓ Matches Official', class: 'match', title: 'Matches official AniList mapping' };
      }
      return { text: '⚡ Overridden', class: 'custom', title: 'Manual override set (differs from official)' };
    }
    if (ovr && ovr.anilistId === null) {
      return { text: '∅ Missing', class: 'missing', title: 'Explicitly unmapped' };
    }
    if (off) {
      return { text: '✓ Using Official', class: 'using-official', title: `Using official mapping (${off.anilistId})` };
    }
    return { text: '🌸 Missing', class: 'missing', title: 'No AniList mapping exists' };
  });

  idInputPlaceholder = computed(() => {
    if (this.isAniListSkipped()) return 'skipped';
    const ovr = this.override();
    if (ovr && ovr.anilistId === null) return 'null';
    const off = this.official();
    if (off) return String(off.anilistId);
    return 'null';
  });

  isIdNullVal = computed(() => {
    const ovr = this.override();
    return ovr?.anilistId === null || (!ovr?.anilistId && !this.official() && !this.isAniListSkipped());
  });

  anilistIdValue = computed(() => {
    const ovr = this.override();
    if (ovr && typeof ovr.anilistId === 'number') {
      return String(ovr.anilistId);
    }
    return '';
  });

  anilistEpisodeValue = computed(() => {
    const ovr = this.override();
    if (ovr?.anilistEpisode !== undefined && ovr?.anilistEpisode !== null) {
      return ovr.anilistEpisode;
    }
    const off = this.official();
    return off ? off.anilistEpisode : this.epNum();
  });

  onIdChange(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.updateField.emit({ field: 'anilistId', value: val });
  }

  onEpisodeChange(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.updateField.emit({ field: 'anilistEpisode', value: val });
  }
}
