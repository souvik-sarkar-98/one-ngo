import { Directive, booleanAttribute, input } from '@angular/core';

/**
 * How a button reads. `secondary` (the default) is the outlined button, `primary` the one main action on a
 * screen, `danger` an outlined warning for something destructive, `destructive` the solid red confirm of a
 * destructive step, and `link` a button that reads as a text link.
 */
export type BtnVariant = '' | 'secondary' | 'primary' | 'danger' | 'destructive' | 'link';

/**
 * The one button of every OneNGO web app. Put it on a `<button>` or an `<a>`:
 *
 *     <button type="button" appBtn="primary" (click)="save()">Save</button>
 *     <button type="button" appBtn size="sm">Edit</button>
 *     <a appBtn="primary" routerLink="/start">Start</a>
 *
 * It only adds classes; the look is in the web kit's base.css (`.app-btn` and its variants), so the
 * same markup draws the same button in the member app, the operator console and the guide.
 */
@Directive({
  selector: 'button[appBtn], a[appBtn]',
  host: {
    class: 'app-btn',
    '[class.app-btn--primary]': "variant() === 'primary'",
    '[class.app-btn--danger]': "variant() === 'danger'",
    '[class.app-btn--destructive]': "variant() === 'destructive'",
    '[class.app-btn--link]': "variant() === 'link'",
    '[class.app-btn--sm]': "size() === 'sm'",
    '[class.app-btn--block]': 'block()',
  },
})
export class Btn {
  readonly variant = input<BtnVariant>('', { alias: 'appBtn' });
  readonly size = input<'md' | 'sm'>('md');
  /** Fill the width of the container. */
  readonly block = input(false, { transform: booleanAttribute });
}
