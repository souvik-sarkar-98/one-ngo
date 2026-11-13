import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { App } from './app/app';
import { routes } from './app/routes';

bootstrapApplication(App, {
  providers: [provideZonelessChangeDetection(), provideRouter(routes, withComponentInputBinding())],
}).catch((error) => console.error(error));
