import { Component, inject, input, OnInit } from '@angular/core';
import { MatCard, MatCardContent, MatCardHeader, MatCardSubtitle, MatCardTitle } from '@angular/material/card';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatTooltip } from '@angular/material/tooltip';
import { AuthStore } from '../../stores/auth.store';
import { AniListTokensStatus } from '../../models/types';
import { getAniListAuthUrl, getSimklAuthUrl } from '../../stores/auth.store.utils';

@Component({
  selector: 'app-auth-view',
  imports: [
    MatCard,
    MatCardHeader,
    MatCardTitle,
    MatCardSubtitle,
    MatCardContent,
    MatButton,
    MatIcon,
    MatFormField,
    MatLabel,
    MatInput,
    MatOption,
    MatSelect,
    MatProgressSpinner,
    MatTooltip,
  ],
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.css',
})
export class AuthComponent implements OnInit {
  store = inject(AuthStore);

  // Router component inputs via withComponentInputBinding()
  success = input<string>();
  service = input<string>();
  error = input<string>();

  ngOnInit() {
    this.store.loadUsers();
  }

  getSimklAuthUrl(username: string): string {
    return getSimklAuthUrl(username);
  }

  getAniListAuthUrl(username: string): string {
    return getAniListAuthUrl(username);
  }

  getAniListBadgeClass(anilist: AniListTokensStatus): string {
    if (!anilist.isValid) return 'badge-danger';
    if (anilist.expiresInDays !== undefined && anilist.expiresInDays <= 30) {
      return anilist.expiresInDays <= 0 ? 'badge-danger' : 'badge-warning';
    }
    return 'badge-anilist';
  }

  getAniListExpiryText(anilist: AniListTokensStatus): string {
    if (anilist.expiresInDays === undefined) return '';
    if (anilist.expiresInDays <= 0) return 'Expires today';
    return `Expires in ${anilist.expiresInDays}d${anilist.expiresInDays <= 30 ? ' (re-link soon)' : ''}`;
  }

  connectSimkl() {
    const user = this.store.targetUsername();
    if (!user) return;
    window.location.href = this.getSimklAuthUrl(user);
  }

  connectAniList() {
    const user = this.store.targetUsername();
    if (!user) return;
    window.location.href = this.getAniListAuthUrl(user);
  }

  onUserSelect(val: string) {
    this.store.setSelectedUser(val);
  }

  onCustomUserInput(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.store.setCustomUsername(val);
  }
}
