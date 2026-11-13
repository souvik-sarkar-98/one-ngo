import { inject } from '@angular/core';
import { Router, type Routes } from '@angular/router';

export const BUILDER_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./catalogue.screen').then((m) => m.CatalogueScreen) },
  { path: 'roles', pathMatch: 'full', redirectTo: '/admin/roles' },
  {
    path: 'roles/:key',
    redirectTo: ({ params }) => inject(Router).createUrlTree(['/admin/roles', params['key']], { queryParams: { tab: 'permissions' } }),
  },
  { path: 'theme', loadComponent: () => import('../admin/theme/theme.screen').then((m) => m.ThemeScreen) },
  { path: 'layout', loadComponent: () => import('../admin/layout/layout.screen').then((m) => m.LayoutScreen) },
  { path: 'access', loadComponent: () => import('./access/access.screen').then((m) => m.AccessScreen) },
  { path: 'modules', loadComponent: () => import('./modules/modules.screen').then((m) => m.ModulesScreen) },
  { path: 'translations', loadComponent: () => import('./editors/translations/translations.screen').then((m) => m.TranslationsScreen) },
  { path: ':kind/:key', loadComponent: () => import('./editor-frame').then((m) => m.EditorFrame) },
];
