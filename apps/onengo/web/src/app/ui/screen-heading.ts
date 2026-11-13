import { Component, inject, input } from '@angular/core';
import { ShellStore } from '../shell/shell-store';
import { PageBack } from './page-back';

/** The page title, with Back on the left away from the four top-level screens. */
@Component({
  selector: 'app-screen-heading',
  imports: [PageBack],
  styles: `
    :host {
      display: block;
    }
    .screen-heading {
      display: flex;
      flex-flow: row nowrap;
      align-items: center;
      justify-content: flex-start;
      gap: 2px;
      margin: 0 0 var(--screen-heading-gap, 0.75rem);
    }
    h1 {
      margin: 0;
      min-width: 0;
      line-height: 1.25;
    }
  `,
  template: `
    @if (showBack() || text()) {
      <header class="screen-heading">
        @if (showBack()) {
          <app-page-back />
        }
        @if (text()) {
          <h1>{{ text() }}</h1>
        }
      </header>
    }
  `,
})
export class ScreenHeading {
  readonly text = input.required<string>();
  private readonly shell = inject(ShellStore);
  readonly showBack = this.shell.showBack;
}
