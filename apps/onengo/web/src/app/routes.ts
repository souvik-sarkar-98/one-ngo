import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { mayOpenBuilder } from './core/admin/areas';
import { LOCALES } from './core/i18n/i18n';
import { rememberedRedirect } from './core/organisation/sign-in';
import { hasAdministration } from './core/shell/shell';
import { I18n, withText } from './services/i18n';
import { Session } from './services/session';

const signedIn: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  return (await session.ensure()) ? true : router.createUrlTree(['/sign-in'], { queryParams: { next: state.url } });
};

/** Home, with a notice that this address is not available to the signed-in person. */
const refused = () => inject(Router).createUrlTree(['/'], { queryParams: { denied: '1' } });

/** The Builder needs `config:read`; its Theme and Layout screens also open with `admin:settings`. */
const canConfigure: CanActivateFn = (_route, state) => {
  const session = inject(Session);
  return mayOpenBuilder(state.url, session.me()?.capabilities) ? true : refused();
};

/** The generic sign-in opens the last organisation's own page, unless the person chose another organisation. */
const remembered: CanActivateFn = (route) => {
  const to = rememberedRedirect(inject(Session).lastOrganisation, { ...route.queryParams });
  return to ? inject(Router).createUrlTree([to.path], { queryParams: to.next ? { next: to.next } : {} }) : true;
};

const administers: CanActivateFn = () => (hasAdministration(inject(Session).me()?.capabilities) ? true : refused());

/**
 * An emailed link carries the language it was written in, so the page it opens
 * is in that language before the person has a session. Only the shipped text is
 * available here; the organisation's own wording arrives with the first session.
 */
const linkLanguage: CanActivateFn = async (route) => {
  const locale = route.queryParamMap.get('lang') ?? '';
  if ((LOCALES as readonly string[]).includes(locale)) await inject(I18n).use(locale, {});
  return true;
};

const loadStyle = (href: string) =>
  new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLLinkElement>(`link[href="${href}"]`);
    if (existing?.sheet) return resolve();
    const link = existing ?? Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => reject(new Error(`Could not load ${href}.`)), { once: true });
    if (!existing) document.head.append(link);
  });

const appStyles: CanActivateFn = async () => {
  await loadStyle('app-styles.css');
  return true;
};

/** Material is used only inside the signed-in shell, so its CSS is not part of the sign-in download. */
const shellStyles: CanActivateFn = async () => {
  await Promise.all([loadStyle('app-styles.css'), loadStyle('material-icons.css'), loadStyle('material-theme.css')]);
  return true;
};

/**
 * Screens drawn without the shell: no app bar, navigation or breadcrumb.
 * They still use the shared classes in app-styles (tabs, full-width actions, text links).
 * A refresh would otherwise keep only the small first stylesheet, and those rules would be gone.
 */
const bare: Routes = [
  { path: 'sign-in', canActivate: [appStyles, withText('core'), remembered], loadComponent: () => import('./pages/sign-in.page').then((m) => m.SignInPage) },
  { path: 'o/:code/sign-in', canActivate: [appStyles, withText('core')], loadComponent: () => import('./pages/sign-in.page').then((m) => m.SignInPage) },
  { path: 'reset-password', canActivate: [appStyles, linkLanguage, withText('core')], loadComponent: () => import('./pages/reset-password.page').then((m) => m.ResetPasswordPage) },
  { path: 'print/receipt/:id', canActivate: [signedIn, appStyles, withText('core')], loadComponent: () => import('./print/receipt.screen').then((m) => m.ReceiptPrintScreen) },
  { path: 'print/report/:key', canActivate: [signedIn, appStyles, withText('core')], loadComponent: () => import('./print/report.screen').then((m) => m.ReportPrintScreen) },
  { path: 'r/:token', canActivate: [appStyles, withText('core')], loadComponent: () => import('./print/public-receipt.screen').then((m) => m.PublicReceiptScreen) },
  { path: 'o/:code/c/:type', canActivate: [appStyles, withText('core')], loadComponent: () => import('./public/public-catalogue.screen').then((m) => m.PublicCatalogueScreen) },
  { path: 'o/:code/f/:type', canActivate: [appStyles, withText('core')], loadComponent: () => import('./public/public-form.screen').then((m) => m.PublicFormScreen) },
  { path: 'f/:token', canActivate: [appStyles, withText('core')], loadComponent: () => import('./public/public-record.screen').then((m) => m.PublicRecordScreen) },
];

/** The destinations and everything reached from them, inside the shell. */
const inShell: Routes = [
  { path: '', loadComponent: () => import('./home/home.screen').then((m) => m.HomeScreen) },
  { path: 'records', loadComponent: () => import('./records/records.screen').then((m) => m.RecordsScreen) },
  { path: 'records/:type', canActivate: [withText('import')], loadChildren: () => import('./records/records.routes').then((m) => m.RECORD_ROUTES) },
  { path: 'records/:type/new', redirectTo: ({ params }) => inject(Router).createUrlTree(['/records', params['type']], { queryParams: { create: 'new' } }) },
  { path: 'records/:type/:id', redirectTo: ({ params }) => inject(Router).createUrlTree(['/records', params['type']], { queryParams: { id: params['id'] } }) },
  { path: 'inbox', loadComponent: () => import('./inbox/inbox.screen').then((m) => m.InboxScreen) },
  { path: 'reports', loadComponent: () => import('./reports/reports.screen').then((m) => m.ReportsScreen) },
  { path: 'reports/:key', loadComponent: () => import('./reports/report.screen').then((m) => m.ReportScreen) },
  { path: 'more', redirectTo: '/' },
  { path: 'people', redirectTo: '/' },
  { path: 'settings', loadChildren: () => import('./more/more.routes').then((m) => m.SETTINGS_ROUTES) },
  { path: 'pages/:key', loadComponent: () => import('./home/home.screen').then((m) => m.HomeScreen) },
  // The child guard runs on every move between Builder screens, so a settings-only person who opens Theme cannot reach the rest.
  { path: 'builder', canActivate: [canConfigure, withText('builder')], canActivateChild: [canConfigure], loadChildren: () => import('./builder/builder.routes').then((m) => m.BUILDER_ROUTES) },
  { path: 'admin', canActivate: [administers, withText('admin')], loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
  { path: 'guide', loadComponent: () => import('./guide-frame').then((m) => m.GuideFrame) },
];

/** Screen text loads with the screens that show it: core with the shell and the bare screens, each area with its routes. */
export const routes: Routes = [
  ...bare,
  {
    path: '',
    canActivate: [signedIn, shellStyles, withText('core')],
    loadChildren: () => import('./shell/shell.routes').then((m) => m.shellRoutes(inShell)),
  },
  { path: '**', redirectTo: '' },
];
