import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, mergeMap, of, pipe, switchMap, tap } from 'rxjs';
import { ApiService } from '../services/api.service';
import { UsersApiResponse } from '../models/types';
import { isCustomUser, resolveDefaultUser, resolveTargetUsername } from './auth.store.utils';

export interface AuthState {
  data: UsersApiResponse | null;
  isLoading: boolean;
  error: string | null;
  selectedUser: string;
  customUsername: string;
  refreshingUsers: string[];
  actionNotification: { message: string; type: 'success' | 'error' } | null;
  copiedService: string | null;
}

const initialAuthState: AuthState = {
  data: null,
  isLoading: true,
  error: null,
  selectedUser: '',
  customUsername: '',
  refreshingUsers: [],
  actionNotification: null,
  copiedService: null,
};

export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState(initialAuthState),
  withComputed((store) => {
    const isCustom = computed(() => isCustomUser(store.selectedUser()));
    const targetUsername = computed(() =>
      resolveTargetUsername(store.selectedUser(), store.customUsername())
    );
    const users = computed(() => store.data()?.users ?? []);
    const jellyfinUsers = computed(() => store.data()?.jellyfinUsers ?? []);
    const simklConfig = computed(() => store.data()?.simkl);
    const anilistConfig = computed(() => store.data()?.anilist);

    const refreshingUsersSet = computed(() => new Set(store.refreshingUsers()));

    return {
      isCustomUser: isCustom,
      targetUsername,
      users,
      jellyfinUsers,
      simklConfig,
      anilistConfig,
      refreshingUsersSet,
    };
  }),
  withMethods((store, api = inject(ApiService)) => {
    let notificationTimer: ReturnType<typeof setTimeout> | null = null;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;

    const showNotification = (message: string, type: 'success' | 'error') => {
      if (notificationTimer) clearTimeout(notificationTimer);
      patchState(store, { actionNotification: { message, type } });
      notificationTimer = setTimeout(() => {
        patchState(store, { actionNotification: null });
      }, 4000);
    };

    const copyText = async (text: string, service: string) => {
      try {
        await navigator.clipboard.writeText(text);
        if (copyTimer) clearTimeout(copyTimer);
        patchState(store, { copiedService: service });
        copyTimer = setTimeout(() => {
          if (store.copiedService() === service) {
            patchState(store, { copiedService: null });
          }
        }, 2000);
      } catch (err) {
        console.error('Failed to copy to clipboard', err);
      }
    };

    const loadUsers = rxMethod<void>(
      pipe(
        tap(() => patchState(store, { isLoading: true, error: null })),
        switchMap(() =>
          api.getUsers().pipe(
            tap((data) => {
              const defaultUser = resolveDefaultUser(
                store.selectedUser(),
                data.jellyfinUsers
              );

              patchState(store, {
                data,
                isLoading: false,
                selectedUser: defaultUser,
              });
            }),
            catchError((err) => {
              patchState(store, {
                isLoading: false,
                error: err?.message || 'Failed to load user token statuses',
              });
              return of(null);
            })
          )
        )
      )
    );

    const refreshUser = rxMethod<string>(
      pipe(
        tap((username) => {
          patchState(store, {
            refreshingUsers: [...store.refreshingUsers(), username],
          });
        }),
        mergeMap((username) =>
          api.refreshUserToken(username).pipe(
            tap(() => {
              showNotification(`Token refreshed successfully for "${username}"`, 'success');
              patchState(store, {
                refreshingUsers: store.refreshingUsers().filter((u) => u !== username),
              });
              loadUsers();
            }),
            catchError((err) => {
              showNotification(`Refresh failed: ${err.message || String(err)}`, 'error');
              patchState(store, {
                refreshingUsers: store.refreshingUsers().filter((u) => u !== username),
              });
              return of(null);
            })
          )
        )
      )
    );

    return {
      loadUsers,
      refreshUser,
      showNotification,
      copyText,
      setSelectedUser: (selectedUser: string) => patchState(store, { selectedUser }),
      setCustomUsername: (customUsername: string) => patchState(store, { customUsername }),
    };
  })
);
