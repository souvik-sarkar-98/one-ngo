import type { Routes } from '@angular/router';
import { provideUpdates } from '../pwa/update-prompt';
import { ShellScreen } from './shell.screen';

/** The shell around `children`, with the service worker client its update prompt needs, loaded with the shell. */
export const shellRoutes = (children: Routes): Routes => [{ path: '', component: ShellScreen, providers: [provideUpdates()], children }];
