import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, of, pipe, switchMap, tap } from 'rxjs';
import { ApiService } from '../services/api.service';
import {
  CatalogShow,
  OfficialMappingsMap,
  OverridesSummary,
  RawTvdbOverrides,
} from '../models/types';
import {
  applyBatchSeasonOverride,
  applyEpisodeUpdate,
  applyOfficialEpisode,
  applyOfficialSeasonOverride,
  calculateFilterCounts,
  calculateStatsSummary,
  clearEpisodeOverride,
  filterAndSortShows,
  paginateShows,
  removeSeriesFromCatalog,
  resolveFilterSort,
  revertShowOverride,
  skipUnmappedSeasonOverride,
  toggleCardId,
  toggleSkipEpisodeOverride,
} from './overrides.store.utils';

export interface OverridesState {
  catalogData: Record<string, CatalogShow>;
  overridesData: RawTvdbOverrides;
  savedOverridesData: RawTvdbOverrides;
  officialData: OfficialMappingsMap;
  dirtyShows: string[];
  openCards: string[];
  syncingSeriesIds: string[];
  allExpanded: boolean;
  currentFilter: string;
  currentSort: string;
  searchQuery: string;
  currentPage: number;
  pageSize: number;
  includePrivate: boolean;
  isLoading: boolean;
  isSyncingLibrary: boolean;
  isRetiring: boolean;
  isSaving: boolean;
  isBulkImportOpen: boolean;
  isRetireOpen: boolean;
  toast: {
    visible: boolean;
    message: string;
    type: 'success' | 'error' | 'info';
  };
}

const initialOverridesState: OverridesState = {
  catalogData: {},
  overridesData: {},
  savedOverridesData: {},
  officialData: {},
  dirtyShows: [],
  openCards: [],
  syncingSeriesIds: [],
  allExpanded: false,
  currentFilter: 'all',
  currentSort: 'missing-desc',
  searchQuery: '',
  currentPage: 1,
  pageSize: 50,
  includePrivate: false,
  isLoading: true,
  isSyncingLibrary: false,
  isRetiring: false,
  isSaving: false,
  isBulkImportOpen: false,
  isRetireOpen: false,
  toast: {
    visible: false,
    message: '',
    type: 'success',
  },
};

export const OverridesStore = signalStore(
  { providedIn: 'root' },
  withState(initialOverridesState),
  withComputed((store) => {
    const dirtyShowsSet = computed(() => new Set(store.dirtyShows()));
    const openCardsSet = computed(() => new Set(store.openCards()));
    const syncingSeriesSet = computed(() => new Set(store.syncingSeriesIds()));

    const statsSummary = computed<OverridesSummary>(() =>
      calculateStatsSummary(
        store.catalogData(),
        store.overridesData(),
        store.officialData(),
        store.includePrivate()
      )
    );

    const filterCounts = computed(() =>
      calculateFilterCounts(
        store.catalogData(),
        store.savedOverridesData(),
        store.officialData(),
        store.includePrivate()
      )
    );

    const filteredShows = computed<[string, CatalogShow][]>(() =>
      filterAndSortShows(
        store.catalogData(),
        store.savedOverridesData(),
        store.officialData(),
        store.searchQuery(),
        store.currentFilter(),
        store.currentSort(),
        store.includePrivate()
      )
    );

    const paginatedShows = computed<[string, CatalogShow][]>(() =>
      paginateShows(filteredShows(), store.currentPage(), store.pageSize())
    );

    return {
      dirtyShowsSet,
      openCardsSet,
      syncingSeriesSet,
      statsSummary,
      filterCounts,
      filteredShows,
      paginatedShows,
    };
  }),
  withMethods((store, api = inject(ApiService)) => {
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    const showToast = (
      message: string,
      type: 'success' | 'error' | 'info' = 'success'
    ) => {
      if (toastTimer) clearTimeout(toastTimer);
      patchState(store, { toast: { visible: true, message, type } });
      toastTimer = setTimeout(() => {
        patchState(store, { toast: { ...store.toast(), visible: false } });
      }, 4000);
    };

    const markDirty = (tvdbId: string) => {
      if (!store.dirtyShows().includes(tvdbId)) {
        patchState(store, { dirtyShows: [...store.dirtyShows(), tvdbId] });
      }
    };

    const loadData = rxMethod<void>(
      pipe(
        tap(() => patchState(store, { isLoading: true })),
        switchMap(() =>
          api.getOverrides().pipe(
            tap((res) => {
              const overrides = res.overrides || {};
              patchState(store, {
                catalogData: res.catalog || {},
                overridesData: overrides,
                savedOverridesData: overrides,
                officialData: res.official || {},
                dirtyShows: [],
                isLoading: false,
              });
            }),
            catchError((err) => {
              showToast(
                'Failed to load overrides: ' + (err.message || String(err)),
                'error'
              );
              patchState(store, { isLoading: false });
              return of(null);
            })
          )
        )
      )
    );

    const saveShow = rxMethod<string>(
      pipe(
        switchMap((tvdbId) => {
          const show = store.overridesData()[tvdbId] || { title: '', seasons: {} };
          return api.saveShow(tvdbId, show).pipe(
            tap(() => {
              const updatedSaved = {
                ...store.savedOverridesData(),
                [tvdbId]: store.overridesData()[tvdbId],
              };
              patchState(store, {
                savedOverridesData: updatedSaved,
                dirtyShows: store.dirtyShows().filter((id) => id !== tvdbId),
              });
              const catShow = store.catalogData()[tvdbId];
              showToast(
                `Saved "${catShow?.title || show.title || tvdbId}"`,
                'success'
              );
            }),
            catchError((err) => {
              showToast(`Error saving show: ${err.message}`, 'error');
              return of(null);
            })
          );
        })
      )
    );

    const saveAllChanges = rxMethod<void>(
      pipe(
        tap(() => patchState(store, { isSaving: true })),
        switchMap(() =>
          api.saveOverrides(store.overridesData()).pipe(
            tap(() => {
              patchState(store, {
                savedOverridesData: store.overridesData(),
                dirtyShows: [],
                isSaving: false,
              });
              showToast('All mapping overrides saved successfully!', 'success');
            }),
            catchError((err) => {
              showToast(`Error saving overrides: ${err.message}`, 'error');
              patchState(store, { isSaving: false });
              return of(null);
            })
          )
        )
      )
    );

    const cancelShow = (tvdbId: string) => {
      const updatedOverrides = revertShowOverride(
        store.overridesData(),
        store.savedOverridesData(),
        tvdbId
      );
      patchState(store, {
        overridesData: updatedOverrides,
        dirtyShows: store.dirtyShows().filter((id) => id !== tvdbId),
      });
      const catShow = store.catalogData()[tvdbId];
      const savedShow = store.savedOverridesData()[tvdbId];
      showToast(
        `Cancelled changes for "${catShow?.title || savedShow?.title || tvdbId}"`,
        'info'
      );
    };

    const cancelAllChanges = () => {
      patchState(store, {
        overridesData: JSON.parse(JSON.stringify(store.savedOverridesData())),
        dirtyShows: [],
      });
      showToast('Cancelled all unsaved changes', 'info');
    };

    const syncSeries = rxMethod<string>(
      pipe(
        tap((tvdbId) => {
          patchState(store, {
            syncingSeriesIds: [...store.syncingSeriesIds(), tvdbId],
          });
        }),
        switchMap((tvdbId) =>
          api.syncSeries(tvdbId).pipe(
            tap((res) => {
              const s = (res as any).summary || res;
              if (s.deleted) {
                const { catalog, overrides, official } = removeSeriesFromCatalog(
                  store.catalogData(),
                  store.overridesData(),
                  store.officialData(),
                  tvdbId
                );

                const updatedSaved = { ...store.savedOverridesData() };
                delete updatedSaved[tvdbId];

                patchState(store, {
                  catalogData: catalog,
                  overridesData: overrides,
                  savedOverridesData: updatedSaved,
                  officialData: official,
                  dirtyShows: store.dirtyShows().filter((id) => id !== tvdbId),
                });
                showToast(
                  'Series no longer found in Jellyfin. Removed from catalog.',
                  'info'
                );
              } else if (s.show) {
                const cat = { ...store.catalogData(), [tvdbId]: s.show };
                const off = (res as any).official
                  ? { ...store.officialData(), [tvdbId]: (res as any).official }
                  : store.officialData();

                patchState(store, { catalogData: cat, officialData: off });
                let msg = `Synced "${s.title || tvdbId}" from Jellyfin! (${s.totalEpisodes} episodes)`;
                if (s.prunedOverridesCount > 0) {
                  msg += ` Cleaned up ${s.prunedOverridesCount} deleted override(s).`;
                  loadData();
                }
                showToast(msg, 'success');
              }
              patchState(store, {
                syncingSeriesIds: store.syncingSeriesIds().filter((id) => id !== tvdbId),
              });
            }),
            catchError((err) => {
              showToast(`Sync error: ${err.message}`, 'error');
              patchState(store, {
                syncingSeriesIds: store.syncingSeriesIds().filter((id) => id !== tvdbId),
              });
              return of(null);
            })
          )
        )
      )
    );

    const syncLibrary = rxMethod<void>(
      pipe(
        tap(() => patchState(store, { isSyncingLibrary: true })),
        switchMap(() =>
          api.syncLibrary().pipe(
            tap((res) => {
              const s = (res as any).summary || res;
              let msg = `Library synced! Found ${s.catalogShowsCount} shows and ${s.catalogEpisodesCount} episodes.`;
              if (s.prunedOverridesCount && s.prunedOverridesCount > 0) {
                msg += ` Cleaned up ${s.prunedOverridesCount} deleted override(s).`;
              }
              showToast(msg, 'success');
              patchState(store, { isSyncingLibrary: false });
              loadData();
            }),
            catchError((err) => {
              showToast(`Sync error: ${err.message}`, 'error');
              patchState(store, { isSyncingLibrary: false });
              return of(null);
            })
          )
        )
      )
    );

    const updateEpisode = (
      tvdbId: string,
      payload: {
        seasonNum: string;
        epNum: string;
        field: 'anilistId' | 'anilistEpisode';
        value: string;
      }
    ) => {
      const updatedOverrides = applyEpisodeUpdate(
        store.overridesData(),
        store.catalogData(),
        tvdbId,
        payload.seasonNum,
        payload.epNum,
        payload.field,
        payload.value
      );
      patchState(store, { overridesData: updatedOverrides });
      markDirty(tvdbId);
    };

    const useOfficialEpisode = (
      tvdbId: string,
      payload: { seasonNum: string; epNum: string }
    ) => {
      const { overrides, official } = applyOfficialEpisode(
        store.overridesData(),
        store.catalogData(),
        store.officialData(),
        tvdbId,
        payload.seasonNum,
        payload.epNum
      );
      if (!official) {
        showToast('No official mapping available for this episode', 'error');
        return;
      }
      patchState(store, { overridesData: overrides });
      markDirty(tvdbId);
      showToast(
        `Applied official AniList ${official.anilistId} (Ep ${official.anilistEpisode})`,
        'success'
      );
    };

    const toggleSkipEpisode = (
      tvdbId: string,
      payload: { seasonNum: string; epNum: string }
    ) => {
      const updatedOverrides = toggleSkipEpisodeOverride(
        store.overridesData(),
        store.catalogData(),
        tvdbId,
        payload.seasonNum,
        payload.epNum
      );
      patchState(store, { overridesData: updatedOverrides });
      markDirty(tvdbId);
    };

    const clearOverrideEpisode = (
      tvdbId: string,
      payload: { seasonNum: string; epNum: string }
    ) => {
      const updatedOverrides = clearEpisodeOverride(
        store.overridesData(),
        tvdbId,
        payload.seasonNum,
        payload.epNum
      );
      patchState(store, { overridesData: updatedOverrides });
      markDirty(tvdbId);
      showToast('Override cleared (reverted to official mapping)', 'success');
    };

    const applyBatchSeason = (
      tvdbId: string,
      payload: { seasonNum: string; anilistId: number }
    ) => {
      const updatedOverrides = applyBatchSeasonOverride(
        store.overridesData(),
        store.catalogData(),
        tvdbId,
        payload.seasonNum,
        payload.anilistId
      );
      patchState(store, { overridesData: updatedOverrides });
      markDirty(tvdbId);
      showToast(
        `Applied AniList ID ${payload.anilistId} to Season ${payload.seasonNum}`,
        'success'
      );
    };

    const applyOfficialSeason = (
      tvdbId: string,
      payload: { seasonNum: string }
    ) => {
      const { overrides, appliedCount } = applyOfficialSeasonOverride(
        store.overridesData(),
        store.catalogData(),
        store.officialData(),
        tvdbId,
        payload.seasonNum
      );
      if (appliedCount > 0) {
        patchState(store, { overridesData: overrides });
        markDirty(tvdbId);
        showToast(
          `Applied official AniList mappings to ${appliedCount} episode(s)`,
          'success'
        );
      } else {
        showToast('No official mappings available for this season', 'error');
      }
    };

    const skipUnmappedSeason = (
      tvdbId: string,
      payload: { seasonNum: string }
    ) => {
      const { overrides, changedCount } = skipUnmappedSeasonOverride(
        store.overridesData(),
        store.catalogData(),
        store.officialData(),
        tvdbId,
        payload.seasonNum
      );
      if (changedCount > 0) {
        patchState(store, { overridesData: overrides });
        markDirty(tvdbId);
        showToast(
          `Marked ${changedCount} unmapped episode(s) as skipped for AniList`,
          'success'
        );
      } else {
        showToast('No unmapped episodes to skip in this season', 'error');
      }
    };

    const toggleCard = (tvdbId: string) => {
      patchState(store, { openCards: toggleCardId(store.openCards(), tvdbId) });
    };

    const toggleAllCards = () => {
      const nextExpanded = !store.allExpanded();
      patchState(store, {
        allExpanded: nextExpanded,
        openCards: nextExpanded ? store.openCards() : [],
      });
    };

    const setFilter = (currentFilter: string) => {
      const sort = resolveFilterSort(currentFilter, store.currentSort());
      patchState(store, { currentFilter, currentSort: sort, currentPage: 1 });
    };

    return {
      loadData,
      saveShow,
      saveAllChanges,
      cancelShow,
      cancelAllChanges,
      syncSeries,
      syncLibrary,
      updateEpisode,
      useOfficialEpisode,
      toggleSkipEpisode,
      clearOverrideEpisode,
      applyBatchSeason,
      applyOfficialSeason,
      skipUnmappedSeason,
      toggleCard,
      toggleAllCards,
      setSearch: (searchQuery: string) =>
        patchState(store, { searchQuery, currentPage: 1 }),
      setFilter,
      setSort: (currentSort: string) =>
        patchState(store, { currentSort, currentPage: 1 }),
      setIncludePrivate: (includePrivate: boolean) =>
        patchState(store, { includePrivate, currentPage: 1 }),
      setPage: (currentPage: number) => patchState(store, { currentPage }),
      setPageSize: (pageSize: number) =>
        patchState(store, { pageSize, currentPage: 1 }),
      setBulkImportOpen: (isBulkImportOpen: boolean) =>
        patchState(store, { isBulkImportOpen }),
      setRetireOpen: (isRetireOpen: boolean) =>
        patchState(store, { isRetireOpen }),
      showToast,
    };
  })
);
