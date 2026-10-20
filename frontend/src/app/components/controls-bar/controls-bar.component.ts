import { Component, input, output } from '@angular/core';
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
  search = input<string>('');
  filter = input<string>('all');
  sort = input<string>('missing-desc');
  allExpanded = input<boolean>(false);
  isSyncing = input<boolean>(false);
  isRetiring = input<boolean>(false);
  includePrivate = input<boolean>(false);
  filterCounts = input<{
    all: number;
    unmapped: number;
    overrides: number;
    skipped: number;
    complete: number;
  }>();

  searchChange = output<string>();
  filterChange = output<string>();
  sortChange = output<string>();
  includePrivateChange = output<boolean>();
  syncLibrary = output<void>();
  retireRedundant = output<void>();
  bulkImport = output<void>();
  toggleExpandAll = output<void>();

  onSearchInput(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.searchChange.emit(val);
  }
}
