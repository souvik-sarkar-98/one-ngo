import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding, type Routes } from '@angular/router';
import { App } from './app/app';
import { watchInstall } from './app/pwa/install';

watchInstall();

/** Keep authentication, i18n and shell policy out of the bootstrap download. */
const routes: Routes = [{ path: '', loadChildren: () => import('./app/routes').then((module) => module.routes) }];

bootstrapApplication(App, {
  providers: [provideZonelessChangeDetection(), provideRouter(routes, withComponentInputBinding())],
})
  .then(async (app) => (await import('./app/pwa/register-worker')).registerWorker(app))
  .catch((err) => console.error(err));
