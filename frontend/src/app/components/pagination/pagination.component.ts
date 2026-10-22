import { Component, computed, input, model, output } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';

@Component({
  selector: 'app-pagination',
  imports: [MatButton, MatIconButton, MatIcon],
  templateUrl: './pagination.component.html',
  styleUrl: './pagination.component.css',
})
export class PaginationComponent {
  currentPage = model<number>(1);
  totalItems = input<number>(0);
  pageSize = model<number>(50);

  pageChange = output<number>();

  totalPages = computed(() => {
    if (this.pageSize() <= 0) return 1;
    return Math.max(1, Math.ceil(this.totalItems() / this.pageSize()));
  });

  startItem = computed(() => {
    if (this.totalItems() === 0) return 0;
    return (this.currentPage() - 1) * this.pageSize() + 1;
  });

  endItem = computed(() => {
    return Math.min(this.currentPage() * this.pageSize(), this.totalItems());
  });

  visiblePages = computed(() => {
    const pages: number[] = [];
    const total = this.totalPages();
    const current = this.currentPage();

    let start = Math.max(1, current - 2);
    let end = Math.min(total, current + 2);

    if (current <= 3) {
      end = Math.min(5, total);
    }
    if (current >= total - 2) {
      start = Math.max(1, total - 4);
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  });

  goToPage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
      this.pageChange.emit(page);
    }
  }

  handlePageSizeChange(e: Event) {
    const newSize = parseInt((e.target as HTMLSelectElement).value, 10);
    this.pageSize.set(newSize);
    this.currentPage.set(1);
    this.pageChange.emit(1);
  }
}
