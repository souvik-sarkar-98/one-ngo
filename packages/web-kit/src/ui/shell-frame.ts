import { Component, input } from '@angular/core';

/**
 * The frame around every signed-in screen: a sticky bar on top, the destinations as a rail beside the
 * content (or as a bottom bar on a phone), and the content column. The apps fill the slots:
 *
 *     <app-shell-frame [bottom]="phone()">
 *       <app-bar shellBar ... />
 *       <app-nav shellRail position="rail" ... />
 *       <app-breadcrumb shellAbove ... />
 *       <router-outlet />
 *       <app-nav shellBottom position="bottom" ... />
 *     </app-shell-frame>
 */
@Component({
  selector: 'app-shell-frame',
  styleUrl: './shell-frame.css',
  template: `
    <div class="shell" [class.shell--bottom]="bottom()">
      <div class="shell__bar"><ng-content select="[shellBar]" /></div>
      <div class="shell__body">
        <div class="shell__rail"><ng-content select="[shellRail]" /></div>
        <div class="shell__main">
          <ng-content select="[shellAbove]" />
          <main class="shell__content page"><ng-content /></main>
        </div>
      </div>
      <div class="shell__bottom"><ng-content select="[shellBottom]" /></div>
      <ng-content select="[shellOverlay]" />
    </div>
  `,
})
export class ShellFrame {
  /** Phone layout: the destinations are a bottom bar and the rail is left out. */
  readonly bottom = input(false);
}
