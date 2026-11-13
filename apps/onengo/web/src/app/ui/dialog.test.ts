import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { t } from '../core/i18n/i18n';
import { dialogCloseLabel, inertTargets, nextTab, swallowBackdropClick, type BackdropClick } from './dialog';

const sheets = ['form-panel.ts', 'panel.ts', 'filter-panel.ts'];

/** A click, and whether the backdrop listener stopped it. */
function gesture(target: object): BackdropClick & { stopped: boolean } {
  return {
    target: target as EventTarget,
    stopped: false,
    preventDefault() {},
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
}

describe('dialog dismiss', () => {
  it('does not dismiss when the backdrop is clicked, and does when the close button is', () => {
    const shade = {};
    const close = {};
    let dismissed = false;
    const dismiss = (): void => {
      dismissed = true;
    };

    const backdrop = gesture(shade);
    if (!swallowBackdropClick(shade as EventTarget, backdrop)) dismiss();
    expect(dismissed).toBe(false);
    expect(backdrop.stopped).toBe(true);

    dismissed = false;
    const button = gesture(close);
    if (!swallowBackdropClick(shade as EventTarget, button)) dismiss();
    expect(dismissed).toBe(true);
    expect(button.stopped).toBe(false);
  });

  it('leaves the backdrop without a click binding, and keeps the close button', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of sheets) {
      const src = readFileSync(join(here, file), 'utf8');
      const shades = src.match(/<div[^>]*data-dialog-shade[^>]*>/g) ?? [];
      expect(shades, file).not.toEqual([]);
      for (const tag of shades) expect(tag, file).not.toContain('(click)');
      expect(src, file).toMatch(/__close"[\s\S]*?\(click\)="/);
    }
  });
});

/** Enough of an element for the inert walk. Vitest has no document here. */
class El {
  parentElement: El | null = null;
  children: El[] = [];
  className = '';
  private readonly attrs = new Set<string>();

  constructor(kind: 'dialog' | 'overlay' | 'plain' = 'plain') {
    if (kind === 'dialog') this.attrs.add('appDialog');
    if (kind === 'overlay') this.className = 'cdk-overlay-container';
  }

  get classList(): { contains: (name: string) => boolean } {
    return { contains: (name) => this.className.split(/\s+/).includes(name) };
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string): void {
    this.attrs.add(name);
  }

  append(child: El): void {
    child.parentElement = this;
    this.children.push(child);
  }

  contains(other: El): boolean {
    return this.children.some((child) => child === other || child.contains(other));
  }
}

describe('dialog tab cycle', () => {
  it('wraps from the last control to the first and back', () => {
    expect(nextTab(2, 3, false)).toBe(0);
    expect(nextTab(0, 3, true)).toBe(2);
    expect(nextTab(1, 3, false)).toBeNull();
    expect(nextTab(1, 3, true)).toBeNull();
  });

  it('pulls focus in from outside the dialog', () => {
    expect(nextTab(-1, 3, false)).toBe(0);
    expect(nextTab(-1, 3, true)).toBe(2);
    expect(nextTab(0, 0, false)).toBeNull();
  });
});

describe('dialog inert', () => {
  it('keeps a confirmation host and the date-picker overlay clickable', () => {
    const body = new El();
    const page = new El();
    const person = new El('dialog');
    const host = new El();
    const overlay = new El('overlay');
    body.append(page);
    body.append(person);
    body.append(host);
    body.append(overlay);

    const behindPerson = inertTargets([person as unknown as HTMLElement]);
    expect(behindPerson).toContain(page);
    expect(behindPerson).toContain(host);
    expect(behindPerson).not.toContain(overlay);

    const confirm = new El('dialog');
    host.append(confirm);
    const behindBoth = inertTargets([person, confirm] as unknown as HTMLElement[]);
    expect(behindBoth).toContain(page);
    expect(behindBoth).not.toContain(host);
    expect(behindBoth).not.toContain(overlay);
    expect(behindBoth).not.toContain(confirm);
  });

  it('leaves inert that another part of the page applied', () => {
    const body = new El();
    const person = new El('dialog');
    const foreign = new El();
    foreign.setAttribute('inert');
    body.append(person);
    body.append(foreign);

    expect(inertTargets([person as unknown as HTMLElement])).not.toContain(foreign);
  });
});

describe('dialog close button', () => {
  it('says Back when the step on the confirm button is itself called Cancel', () => {
    expect(dialogCloseLabel('Cancel', t('ui.common.cancel'))).toBe(t('ui.common.back'));
    expect(dialogCloseLabel(' cancel ', t('ui.common.cancel'))).toBe(t('ui.common.back'));
  });

  it('leaves the close button alone for every other step', () => {
    expect(dialogCloseLabel('Mark as paid', t('ui.common.cancel'))).toBe(t('ui.common.cancel'));
    expect(dialogCloseLabel('Cancel donation', t('ui.common.cancel'))).toBe(t('ui.common.cancel'));
    expect(dialogCloseLabel('Suspend', t('ui.common.back'))).toBe(t('ui.common.back'));
  });
});
