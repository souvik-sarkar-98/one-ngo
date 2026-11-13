import { Directive, ElementRef, afterNextRender, inject, output, type OnDestroy } from '@angular/core';
import { t } from '../core/i18n/i18n';

const FIELD = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])';
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/**
 * What the button that closes a dialog reads. A workflow step or action carries its own
 * label on the confirm button, so a step called Cancel would put Cancel on both buttons;
 * the close button then reads Back instead.
 */
export function dialogCloseLabel(confirmLabel: string, closeLabel: string): string {
  const same = confirmLabel.trim().toLocaleLowerCase() === closeLabel.trim().toLocaleLowerCase();
  return same ? t('ui.common.back') : closeLabel;
}

/** Where Tab moves. `null` means the key stays where it is. An index below zero means focus was outside the dialog. */
export function nextTab(index: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

/** Elements that can take Tab inside a dialog, skipping `tabindex="-1"`. */
export function tabbables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.tabIndex >= 0);
}

/** The first field, or the heading, or the first button. */
export function initialFocus(dialog: HTMLElement): HTMLElement | null {
  const field = dialog.querySelector<HTMLElement>(FIELD);
  if (field) return field;
  const heading = dialog.querySelector<HTMLElement>('h1, h2, h3');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    return heading;
  }
  return dialog.querySelector<HTMLElement>('button:not([disabled])');
}

/** Click details a backdrop listener needs. */
export interface BackdropClick {
  readonly target: EventTarget | null;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

/**
 * A click on the backdrop itself does not close the dialog. A click on a
 * control inside it, such as the close button, is left to that control.
 * Returns true when the click was swallowed.
 */
export function swallowBackdropClick(shade: EventTarget, event: BackdropClick): boolean {
  if (event.target !== shade) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

/** The shade behind `dialog`: its parent, or the sibling just before it. */
export function dialogShade(dialog: HTMLElement): HTMLElement | null {
  const parent = dialog.parentElement;
  if (parent?.hasAttribute('data-dialog-shade')) return parent;
  const previous = dialog.previousElementSibling;
  if (previous instanceof HTMLElement && previous.hasAttribute('data-dialog-shade')) return previous;
  return null;
}

/**
 * A sibling that must stay active: the shade, an open dialog (or the element
 * that contains one), or the overlay container. The shade stays active so a
 * click lands there and does not reach the page. A backdrop click does not
 * dismiss. A date picker lives in the overlay container. A confirmation is
 * mounted after the first dialog has already opened, so the set of open
 * dialogs decides which hosts stay active.
 */
function staysActive(el: Element, open: ReadonlySet<HTMLElement>, ours: ReadonlySet<Element>): boolean {
  if (el.hasAttribute('data-dialog-shade') || el.classList.contains('cdk-overlay-container')) return true;
  // Inert we did not apply belongs to something else; leave it out of our set
  // so closing the dialog does not clear it.
  if (el.hasAttribute('inert') && !ours.has(el)) return true;
  if (open.has(el as HTMLElement)) return true;
  for (const dialog of open) if (el.contains(dialog)) return true;
  return false;
}

/**
 * Page elements that should be inert while these dialogs are open. The shade
 * behind a dialog stays active so a click lands there and is swallowed.
 * Ancestors of an open dialog stay active so a confirmation or calendar inside
 * them can be used.
 */
export function inertTargets(dialogs: readonly HTMLElement[], already: ReadonlySet<Element> = new Set()): Element[] {
  const open = new Set(dialogs);
  const hidden: Element[] = [];
  const boundary = typeof document === 'undefined' ? null : document.body;
  for (const dialog of dialogs) {
    let node: HTMLElement | null = dialog;
    while (node && node !== boundary && node.parentElement) {
      for (const child of Array.from(node.parentElement.children)) {
        if (child !== node && !staysActive(child, open, already)) hidden.push(child);
      }
      node = node.parentElement;
    }
  }
  return hidden;
}

/** Inert attributes this module applied. Closing one dialog must not clear another. */
const applied = new Set<Element>();

/** Mark everything behind the open dialogs inert, and lift it from hosts that now contain one. */
export function syncDialogInert(except?: HTMLElement): void {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[appDialog]')).filter((dialog) => dialog !== except);
  const next = new Set(inertTargets(dialogs, applied));
  for (const el of applied) {
    if (!next.has(el)) el.removeAttribute('inert');
  }
  for (const el of next) el.setAttribute('inert', '');
  applied.clear();
  for (const el of next) applied.add(el);
}

/** Keeps Tab inside the dialog. */
export function trapTab(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const items = tabbables(dialog);
  const index = items.findIndex((el) => el === document.activeElement);
  const next = nextTab(index, items.length, event.shiftKey);
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

/** A dialog: focus moves inside, Tab stays there, the page behind is inert, and Escape asks to close. A backdrop click does not. */
@Directive({
  selector: '[appDialog]',
  host: {
    'aria-modal': 'true',
    '(keydown)': 'onKey($event)',
  },
})
export class DialogFocus implements OnDestroy {
  readonly escape = output<void>();
  private readonly host = inject(ElementRef<HTMLElement>);
  private previous: HTMLElement | null = null;
  private release = (): void => undefined;
  private releaseShade = (): void => undefined;

  constructor() {
    const active = document.activeElement;
    this.previous = active instanceof HTMLElement ? active : null;
    afterNextRender(() => {
      const dialog = this.host.nativeElement;
      syncDialogInert();
      this.release = () => syncDialogInert(dialog);
      const shade = dialogShade(dialog);
      if (shade) {
        const swallow = (event: Event) => {
          swallowBackdropClick(shade, event);
        };
        shade.addEventListener('click', swallow, true);
        this.releaseShade = () => shade.removeEventListener('click', swallow, true);
      }
      initialFocus(dialog)?.focus();
    });
  }

  onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.escape.emit();
      return;
    }
    trapTab(this.host.nativeElement, event);
  }

  ngOnDestroy(): void {
    this.release();
    this.releaseShade();
    const back = this.previous;
    if (back && document.contains(back)) back.focus();
  }
}
