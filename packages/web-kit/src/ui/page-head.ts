import { Component, input } from '@angular/core';

/**
 * The title of a screen. A back control goes in the `pageHeadBack` slot, a badge right after the title
 * in the default slot, and the screen's actions in `pageHeadActions` at the far end.
 *
 *     <app-page-head title="Operators"><button pageHeadActions appBtn>Add</button></app-page-head>
 */
@Component({
  selector: 'app-page-head',
  template: `
    <header class="page-head">
      <ng-content select="[pageHeadBack]" />
      @if (title()) { <h1>{{ title() }}</h1> }
      <ng-content />
      <span class="page-head__actions"><ng-content select="[pageHeadActions]" /></span>
    </header>
  `,
  styles: `
    :host { display: block; }
    .page-head { display: flex; flex-flow: row var(--page-head-wrap, wrap); align-items: center; gap: var(--page-head-gap, 8px); margin: 0 0 var(--page-head-margin, .75rem); }
    h1 { margin: 0; min-width: 0; line-height: 1.25; }
    .page-head__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-inline-start: auto; }
    .page-head__actions:empty { display: none; }
  `,
})
export class PageHead {
  readonly title = input('');
}
