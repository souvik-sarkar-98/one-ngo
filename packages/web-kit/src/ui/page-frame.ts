import { Component } from '@angular/core';

/** The one content column every signed-in screen is drawn in: full width up to `--content-max`, centred. */
@Component({
  selector: 'app-page-frame',
  template: `<ng-content />`,
  styles: `:host{display:block;width:100%;max-width:var(--content-max,1100px);min-width:0;margin-inline:auto;box-sizing:border-box}`,
})
export class PageFrame {}
