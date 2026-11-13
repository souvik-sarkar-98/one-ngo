import { Component, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import { opensInPlace } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { DialogFocus } from '../../ui/dialog';
import { OrganisationStore } from './organisation-store';

/** The setup checklist: the progress strip on Administration's home, and the checklist it opens. */
@Component({
  selector: 'app-organisation-sections',
  imports: [TranslatePipe, DialogFocus],
  providers: [OrganisationStore],
  styleUrl: '../admin.css',
  styles: `
    .org__done {
      color: var(--ok, #15803d);
      font-weight: 700;
    }
    .org__todo {
      color: var(--muted);
    }
    .org__sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    .org__strip { display: flex; flex-direction: column; gap: 8px; }
    .org__head { display: flex; align-items: center; gap: 8px; }
    .org__head h2 { margin: 0; flex: 1; min-width: 0; }
    .org__note { margin: 0; font-size: 0.85rem; }
    .org__strip .admin__bar { margin: 0; }
    .org__shade {
      position: fixed;
      inset: 0;
      z-index: 350;
      display: grid;
      place-items: center;
      padding: 16px;
      background: color-mix(in srgb, var(--fg) 35%, transparent);
    }
    .org__dialog {
      width: min(560px, 100%);
      max-height: min(640px, calc(100vh - 32px));
      margin: 0;
      overflow: auto;
    }
    .org__dialog .org__note { margin-top: 10px; }
    .org__dialog .admin__bar { margin: 8px 0 0; }
    .org__dialog .admin__list { margin-top: 12px; }
    .org__goto {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
      color: inherit;
      text-decoration: none;
    }
    .org__goto:hover strong { text-decoration: underline; }
  `,
  template: `
    @if (store.notice(); as n) {
      <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
    }
    @if (store.error()) {
      <div class="notice error" role="alert">{{ store.error() }}</div>
    }
    @if (store.loading()) {
      <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
    } @else if (store.view()) {
      <section class="card org__strip" aria-labelledby="org-setup-title">
        <div class="org__head">
          <h2 id="org-setup-title">{{ 'ui.admin.organisation.setupTitle' | t }}</h2>
          <button type="button" class="link-button" #checklistLink [attr.aria-expanded]="checklistOpen()" aria-haspopup="dialog" (click)="openChecklist()">
            {{ 'ui.admin.organisation.setupView' | t }}
          </button>
        </div>
        <p class="muted org__note" id="org-setup-status">{{ store.setupSummary().status }}</p>
        <div
          class="admin__bar"
          role="progressbar"
          [attr.aria-valuenow]="store.setupSummary().done"
          aria-valuemin="0"
          [attr.aria-valuemax]="store.setupSummary().total"
          aria-labelledby="org-setup-status">
          <i [style.width.%]="store.setupSummary().percent"></i>
        </div>
        <p class="muted org__note">{{ store.setupSummary().detail }}</p>
      </section>
      @if (checklistOpen()) {
        <div class="org__shade" data-dialog-shade role="presentation">
          <div
            class="card org__dialog"
            appDialog
            role="dialog"
            aria-labelledby="org-setup-dialog-title"
            (escape)="closeChecklist()">
            <div class="org__head">
              <h2 id="org-setup-dialog-title">{{ 'ui.admin.organisation.setupTitle' | t }}</h2>
              <button type="button" class="app-btn" (click)="closeChecklist()">{{ 'ui.common.close' | t }}</button>
            </div>
            <p class="muted org__note" id="org-setup-dialog-status">{{ store.setupSummary().status }}</p>
            <div
              class="admin__bar"
              role="progressbar"
              [attr.aria-valuenow]="store.setupSummary().done"
              aria-valuemin="0"
              [attr.aria-valuemax]="store.setupSummary().total"
              aria-labelledby="org-setup-dialog-status">
              <i [style.width.%]="store.setupSummary().percent"></i>
            </div>
            <ul class="admin__list">
              @for (item of store.setup(); track item.key) {
                <li>
                  <div class="admin__row">
                    <a class="org__goto" [attr.href]="item.link" (click)="openSetup($event, item.link)">
                      <span [class.org__done]="item.done" [class.org__todo]="!item.done" aria-hidden="true">{{ item.done ? '✓' : '○' }}</span>
                      <span class="admin__label">
                        <strong>{{ item.label }}</strong>
                        <span class="muted">{{ item.hint }}</span>
                      </span>
                      <span class="org__sr">{{ (item.done ? 'ui.admin.organisation.stateDone' : item.required ? 'ui.admin.organisation.stateRequired' : 'ui.admin.organisation.stateOptional') | t }}</span>
                      @if (!item.required) {
                        <span class="muted" aria-hidden="true">{{ 'ui.admin.organisation.stateOptional' | t }}</span>
                      }
                      <span aria-hidden="true">›</span>
                    </a>
                    @if (item.confirm) {
                      <button type="button" class="app-btn" [disabled]="store.confirming() !== null" (click)="confirm(item.key)">
                        {{ (item.key === 'identity' ? 'ui.admin.organisation.confirmIdentity' : 'ui.admin.organisation.confirmReceipts') | t }}
                      </button>
                    }
                  </div>
                </li>
              }
            </ul>
          </div>
        </div>
      }
    }
  `,
})
export class OrganisationSections {
  readonly store = inject(OrganisationStore);
  readonly checklistOpen = signal(false);
  private readonly checklistLink = viewChild<ElementRef<HTMLButtonElement>>('checklistLink');

  openChecklist(): void {
    this.checklistOpen.set(true);
  }

  /** Opens the screen for one step. A modified click keeps the browser's own behaviour. */
  openSetup(event: MouseEvent, link: string): void {
    if (!opensInPlace(event)) return;
    event.preventDefault();
    this.checklistOpen.set(false);
    this.store.go(link);
  }

  closeChecklist(): void {
    if (!this.checklistOpen()) return;
    this.checklistOpen.set(false);
    this.checklistLink()?.nativeElement.focus();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeChecklist();
  }

  confirm(key: string): void {
    if (key === 'identity' || key === 'receiptSeries') void this.store.confirm(key);
  }
}
