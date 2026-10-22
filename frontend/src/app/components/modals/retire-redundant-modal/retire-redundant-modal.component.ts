import { Component, DestroyRef, HostListener, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { ApiService } from '../../../services/api.service';
import { RetireSummary } from '../../../models/types';

@Component({
  selector: 'app-retire-redundant-modal',
  templateUrl: './retire-redundant-modal.component.html',
  styleUrl: './retire-redundant-modal.component.css',
  imports: [MatButton, MatIcon, MatProgressSpinner],
})
export class RetireRedundantModalComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  isOpen = input<boolean>(false);
  close = output<void>();
  retired = output<void>();

  isLoading = signal(false);
  summaryResult = signal<RetireSummary | null>(null);
  errorMessage = signal<string | null>(null);

  @HostListener('window:keydown.escape')
  onEscape() {
    if (this.isOpen() && !this.isLoading()) {
      this.handleClose();
    }
  }

  handleConfirm() {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    this.summaryResult.set(null);

    this.api
      .retireRedundantOverrides()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: res => {
          this.summaryResult.set(res.summary || null);
          this.isLoading.set(false);
          this.retired.emit();
        },
        error: err => {
          this.errorMessage.set(err.message || 'Failed to retire redundant overrides');
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
