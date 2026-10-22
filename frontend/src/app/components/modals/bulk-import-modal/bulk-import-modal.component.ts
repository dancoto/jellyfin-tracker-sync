import { Component, DestroyRef, HostListener, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { ApiService } from '../../../services/api.service';
import { CatalogSyncResult } from '../../../models/types';

@Component({
  selector: 'app-bulk-import-modal',
  templateUrl: './bulk-import-modal.component.html',
  styleUrl: './bulk-import-modal.component.css',
  imports: [MatButton, MatCheckbox, MatIcon, MatProgressSpinner],
})
export class BulkImportModalComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  isOpen = input<boolean>(false);
  close = output<void>();
  synced = output<void>();

  isLoading = signal(false);
  pruneDeleted = signal(true);
  summaryResult = signal<CatalogSyncResult | null>(null);
  errorMessage = signal<string | null>(null);

  @HostListener('window:keydown.escape')
  onEscape() {
    if (this.isOpen() && !this.isLoading()) {
      this.handleClose();
    }
  }

  handleSync() {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    this.summaryResult.set(null);

    this.api
      .syncLibrary({ pruneDeletedOverrides: this.pruneDeleted() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.summaryResult.set(res.summary);
          this.isLoading.set(false);
          this.synced.emit();
        },
        error: (err) => {
          this.errorMessage.set(err.message || 'Failed to sync library');
          this.isLoading.set(false);
        },
      });
  }

  handleClose() {
    this.summaryResult.set(null);
    this.errorMessage.set(null);
    this.close.emit();
  }
}
