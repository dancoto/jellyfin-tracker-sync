import { Component, DestroyRef, inject, input, model, output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatPrefix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-controls-bar',
  imports: [
    MatButton,
    MatFormField,
    MatLabel,
    MatPrefix,
    MatIcon,
    MatInput,
    MatOption,
    MatSelect,
    MatTooltip,
    MatProgressSpinner,
  ],
  templateUrl: './controls-bar.component.html',
  styleUrl: './controls-bar.component.css',
})
export class ControlsBarComponent {
  private destroyRef = inject(DestroyRef);
  private searchSubject = new Subject<string>();

  search = input<string>('');
  filter = model<string>('all');
  sort = model<string>('missing-desc');
  allExpanded = input<boolean>(false);
  isSyncing = input<boolean>(false);
  isRetiring = input<boolean>(false);
  includePrivate = model<boolean>(false);
  filterCounts = input<{
    all: number;
    unmapped: number;
    overrides: number;
    skipped: number;
    complete: number;
  }>();

  searchChange = output<string>();
  syncLibrary = output<void>();
  retireRedundant = output<void>();
  bulkImport = output<void>();
  toggleExpandAll = output<void>();

  constructor() {
    this.searchSubject
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((val) => this.searchChange.emit(val));
  }

  onSearchInput(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.searchSubject.next(val);
  }

  setFilter(f: string) {
    this.filter.set(f);
  }

  setSort(s: string) {
    this.sort.set(s);
  }

  togglePrivate() {
    this.includePrivate.update((prev) => !prev);
  }
}
