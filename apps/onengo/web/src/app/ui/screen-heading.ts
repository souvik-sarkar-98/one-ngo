import { Component, inject, input } from '@angular/core';
import { PageHead } from '@onengo/web-kit';
import { ShellStore } from '../shell/shell-store';
import { PageBack } from './page-back';

/** The page title, with Back on the left away from the four top-level screens. The heading itself is the web kit's, shared with the operator console. */
@Component({
  selector: 'app-screen-heading',
  imports: [PageBack, PageHead],
  styles: `
    :host {
      display: block;
      --page-head-gap: 2px;
      --page-head-wrap: nowrap;
      --page-head-margin: var(--screen-heading-gap, 0.75rem);
    }
  `,
  template: `
    @if (showBack() || text()) {
      <app-page-head [title]="text()">
        @if (showBack()) {
          <app-page-back pageHeadBack />
        }
      </app-page-head>
    }
  `,
})
export class ScreenHeading {
  readonly text = input.required<string>();
  private readonly shell = inject(ShellStore);
  readonly showBack = this.shell.showBack;
}
