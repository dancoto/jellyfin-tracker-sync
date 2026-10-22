import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  CatalogSyncApiResponse,
  OverridesApiResponse,
  RawShowOverride,
  RawTvdbOverrides,
  RetireRedundantResult,
  SeriesSyncApiResponse,
  UsersApiResponse,
} from '../models/types';

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private http = inject(HttpClient);

  // Observable-based HTTP GET requests
  getOverrides(): Observable<OverridesApiResponse> {
    return this.http.get<OverridesApiResponse>('/api/overrides');
  }

  getUsers(): Observable<UsersApiResponse> {
    return this.http.get<UsersApiResponse>('/api/users');
  }

  // Observable-based HTTP POST requests
  refreshUserToken(username: string): Observable<{ status: string; username: string }> {
    return this.http.post<{ status: string; username: string }>('/api/users/refresh', { username });
  }

  saveOverrides(overrides: RawTvdbOverrides): Observable<{ status: string }> {
    return this.http.post<{ status: string }>('/api/overrides', { overrides });
  }

  saveShow(tvdbId: string, show: RawShowOverride): Observable<{ status: string }> {
    return this.http.post<{ status: string }>('/api/overrides', { tvdbId, show });
  }

  importMappings(options: {
    overwriteExistingManual?: boolean;
    includeNonAnime?: boolean;
  }): Observable<CatalogSyncApiResponse> {
    return this.http.post<CatalogSyncApiResponse>('/api/overrides/import', options);
  }

  retireRedundantOverrides(options?: { dryRun?: boolean }): Observable<RetireRedundantResult> {
    return this.http.post<RetireRedundantResult>('/api/overrides/retire-redundant', {
      dryRun: Boolean(options?.dryRun),
    });
  }

  syncLibrary(options?: { pruneDeletedOverrides?: boolean }): Observable<CatalogSyncApiResponse> {
    return this.http.post<CatalogSyncApiResponse>('/api/catalog/sync', options ?? {});
  }

  syncSeries(tvdbId: string): Observable<SeriesSyncApiResponse> {
    return this.http.post<SeriesSyncApiResponse>('/api/catalog/sync-series', { tvdbId });
  }
}
