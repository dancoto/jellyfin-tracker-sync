import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./views/auth/auth.component').then((m) => m.AuthComponent),
    title: 'Authentication & Users - Jellyfin Tracker Sync',
  },
  {
    path: 'auth',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: 'overrides',
    loadComponent: () =>
      import('./views/overrides/overrides.component').then((m) => m.OverridesComponent),
    title: 'Mapping Overrides - Jellyfin Tracker Sync',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
