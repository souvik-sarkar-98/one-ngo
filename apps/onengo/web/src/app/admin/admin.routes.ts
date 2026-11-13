import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { mayOpen, type AdminAreaId } from '../core/admin/areas';
import { Session } from '../services/session';
import { provideFieldDates } from '../ui/date-adapter';

/** Each area needs its own permission; without it the person lands on Administration's home. */
const may =
  (area: AdminAreaId): CanActivateFn =>
  () =>
    mayOpen(area, inject(Session).me()?.capabilities) ? true : inject(Router).createUrlTree(['/admin']);

/** Every Administration screen; several, such as registrations and the audit log's filters, have date fields. */
const ADMIN_AREAS: Routes = [
  { path: '', loadComponent: () => import('./admin-home.screen').then((m) => m.AdminHomeScreen) },
  { path: 'people', canActivate: [may('people')], data: { variant: 'management' }, loadComponent: () => import('../people/people.screen').then((m) => m.PeopleScreen) },
  { path: 'roles', canActivate: [may('roles')], loadComponent: () => import('./roles/roles.screen').then((m) => m.RolesScreen) },
  { path: 'roles/:key', canActivate: [may('roles')], loadComponent: () => import('./roles/role.screen').then((m) => m.RoleScreen) },
  { path: 'connectors', canActivate: [may('connectors')], loadComponent: () => import('./connectors/connectors.screen').then((m) => m.ConnectorsScreen) },
  { path: 'connectors/:key', canActivate: [may('connectors')], loadComponent: () => import('./connectors/connector.screen').then((m) => m.ConnectorScreen) },
  { path: 'api-keys', canActivate: [may('apiKeys')], loadComponent: () => import('./api-keys/api-keys.screen').then((m) => m.ApiKeysScreen) },
  { path: 'jobs', canActivate: [may('jobs')], loadComponent: () => import('./jobs/jobs.screen').then((m) => m.JobsScreen) },
  { path: 'audit', canActivate: [may('audit')], loadComponent: () => import('./audit/audit.screen').then((m) => m.AuditScreen) },
  // Migration explains a refusal on its own screen rather than sending the person back to Administration.
  { path: 'migration', loadComponent: () => import('./migration/migrations.screen').then((m) => m.MigrationsScreen) },
  { path: 'migration/:id', redirectTo: 'migration/:id/files' },
  { path: 'migration/:id/:step', loadComponent: () => import('./migration/migration.screen').then((m) => m.MigrationScreen) },
  { path: 'settings', redirectTo: 'organisation/identity' },
  { path: 'theme', redirectTo: '/builder/theme' },
  { path: 'layout', redirectTo: '/builder/layout' },
  { path: 'organisation', redirectTo: 'organisation/identity', pathMatch: 'full' },
  { path: 'organisation/identity', canActivate: [may('identity')], loadComponent: () => import('./settings/identity.screen').then((m) => m.IdentityScreen) },
  { path: 'organisation/profile', canActivate: [may('profile')], loadComponent: () => import('./settings/profile.screen').then((m) => m.ProfileScreen) },
  { path: 'organisation/registrations', canActivate: [may('registrations')], loadComponent: () => import('./settings/registrations.screen').then((m) => m.RegistrationsScreen) },
  { path: 'organisation/settings', canActivate: [may('settings')], loadComponent: () => import('./settings/settings.screen').then((m) => m.SettingsScreen) },
  { path: 'organisation/policies', redirectTo: 'organisation/settings' },
  { path: 'organisation/usage', redirectTo: 'organisation/settings' },
];

/** Administration (`/admin/**`), loaded only when opened. */
export const ADMIN_ROUTES: Routes = [{ path: '', providers: [provideFieldDates()], children: ADMIN_AREAS }];
