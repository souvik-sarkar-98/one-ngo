import { Component, computed, inject, signal } from '@angular/core';
import { Icon, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { PRODUCT_NAME } from '../../ui/app-bar';
import { CfForm } from '../../ui/cf-form';
import { ScreenHeading } from '../../ui/screen-heading';
import { OrganisationStore } from './organisation-store';
import { SettingsStore } from './settings-store';

/** Identity: the logo beside the display name, then the names and default language. The logo is saved on its own; the names are saved to the organisation. */
@Component({
  selector: 'app-admin-identity',
  imports: [CfForm, Icon, PageFrame, ScreenHeading, TranslatePipe],
  providers: [OrganisationStore, SettingsStore],
  styleUrl: '../admin.css',
  styles: `
    .org__facts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 4px 0 14px;
    }
    .org__facts > div {
      min-width: 0;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #f8fafc;
    }
    .org__facts dt {
      margin: 0;
      color: var(--muted);
      font-size: 0.72rem;
      font-weight: 600;
    }
    .org__facts dd {
      margin: 2px 0 0;
      overflow-wrap: anywhere;
      font-weight: 600;
    }
    .org__bar {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 56px;
      margin: 0 0 6px;
      padding: 0 12px;
      border-radius: 12px;
      background: var(--brand, #1f5f8b);
      color: var(--brand-fg, #fff);
    }
    .org__product {
      flex: 0 0 auto;
      font-size: 1rem;
      font-weight: 700;
    }
    .org__logo {
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
      object-fit: contain;
      border-radius: 6px;
      background: #fff;
    }
    .org__logo--empty {
      display: grid;
      place-items: center;
      padding: 2px;
      border: 1px dashed rgba(255, 255, 255, 0.7);
      background: rgba(255, 255, 255, 0.16);
      color: #fff;
      font-size: 0.62rem;
      font-weight: 700;
      line-height: 1.1;
      text-align: center;
    }
    .org__org {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-inline-start: 10px;
      border-inline-start: 1px solid rgba(255, 255, 255, 0.35);
      font-size: 0.95rem;
      font-weight: 600;
    }
    .org__bar-end {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-inline-start: auto;
      opacity: 0.9;
    }
    .org__ghost {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.16);
      --icon-size: 18px;
    }
    .org__caption {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 0.8rem;
    }
    .org__drop {
      position: relative;
      display: flex;
      align-items: center;
      gap: 14px;
      margin: 0 0 8px;
      padding: 14px 16px;
      border: 1.5px dashed color-mix(in srgb, var(--brand) 35%, var(--line));
      border-radius: 12px;
      background: color-mix(in srgb, var(--brand) 5%, #fff);
      cursor: pointer;
    }
    .org__drop[data-over='true'],
    .org__drop:focus-within {
      border-color: var(--brand);
      background: color-mix(in srgb, var(--brand) 12%, #fff);
      outline: none;
    }
    .org__drop[data-invalid='true'] {
      border-color: var(--bad, #b3261e);
    }
    .org__drop[data-busy='true'] {
      opacity: 0.6;
      pointer-events: none;
    }
    .org__file {
      position: absolute;
      width: 1px;
      height: 1px;
      min-height: 0;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .org__drop-mark {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      color: var(--brand);
    }
    .org__drop-mark svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
    .org__drop-copy {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .org__drop-title {
      font-size: 0.95rem;
      font-weight: 700;
    }
    .org__drop-help {
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.35;
    }
    .org__error {
      margin: 0 0 8px;
      color: var(--bad, #b91c1c);
      font-size: 0.85rem;
    }
    .org__remove {
      margin-bottom: 4px;
    }
    .org__signature {
      max-width: 200px;
      max-height: 72px;
      object-fit: contain;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .org__form {
      margin-top: 12px;
    }
    @media (max-width: 759.98px) {
      .org__facts {
        grid-template-columns: 1fr;
      }
      .org__bar-end {
        display: none;
      }
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.identity' | t" />
      <p class="muted">{{ 'ui.admin.organisation.identityIntro' | t }}</p>
      @if (org.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (settings.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (org.error() || settings.error()) {
        <div class="notice error" role="alert">{{ org.error() || settings.error() }}</div>
      }
      @if (org.loading() || settings.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (org.view(); as o) {
        <section class="card" aria-labelledby="org-identity-title">
          <h2 id="org-identity-title">{{ 'ui.admin.organisation.identityTitle' | t }}</h2>
          <dl class="org__facts">
            <div>
              <dt>{{ 'ui.admin.organisation.code' | t }}</dt>
              <dd>{{ o.code }}</dd>
            </div>
            <div>
              <dt>{{ 'ui.admin.organisation.signInLink' | t }}</dt>
              <dd>{{ org.signInLink() }}</dd>
            </div>
          </dl>
          <div class="org__bar" role="img" [attr.aria-label]="'ui.admin.organisation.previewHint' | t">
            <span class="org__product">{{ productName }}</span>
            @if (org.logo(); as src) {
              <img class="org__logo" [src]="src" alt="" />
            } @else {
              <span class="org__logo org__logo--empty">{{ 'ui.admin.organisation.logoEmpty' | t }}</span>
            }
            <span class="org__org">{{ displayName() }}</span>
            <span class="org__bar-end">
              <span class="org__ghost"><app-icon name="bell" /></span>
              <span class="org__ghost"></span>
            </span>
          </div>
          <p class="org__caption">{{ 'ui.admin.organisation.previewHint' | t }}</p>
          <label
            class="org__drop"
            [attr.data-over]="over()"
            [attr.data-busy]="org.logoBusy()"
            [attr.data-invalid]="org.logoError() ? true : null"
            (dragover)="dragOver($event)"
            (dragleave)="over.set(false)"
            (drop)="dropped($event)">
            <input
              id="org-logo"
              class="org__file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              [attr.aria-invalid]="org.logoError() ? true : null"
              [disabled]="org.logoBusy()"
              (change)="chooseLogo($event)" />
            <span class="org__drop-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5z" /></svg>
            </span>
            <span class="org__drop-copy">
              <span class="org__drop-title">{{ (o.logo ? 'ui.admin.organisation.replaceLogo' : 'ui.admin.organisation.uploadLogo') | t }}</span>
              <span class="org__drop-help">{{ 'ui.admin.organisation.logoHelp' | t }}</span>
            </span>
          </label>
          @if (org.logoError()) {
            <div class="org__error" role="alert">{{ org.logoError() }}</div>
          }
          @if (o.logo) {
            <div class="admin__line org__remove">
              <button type="button" class="app-btn" [disabled]="org.logoBusy()" (click)="org.removeLogo()">{{ 'ui.admin.organisation.removeLogo' | t }}</button>
            </div>
          }
          <div class="org__form">
            <cf-form [fields]="settings.general()" [values]="settings.values()" [errors]="settings.errors()" idPrefix="org-identity" [columns]="3" (valuesChange)="settings.values.set($event)" />
          </div>
          <div class="admin__line">
            <span class="admin__grow"></span>
            <button type="button" class="app-btn app-btn--primary" [disabled]="settings.saving()" (click)="settings.save('identity')">
              {{ (settings.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}
            </button>
          </div>
        </section>
        <section class="card" aria-labelledby="org-signatory-title">
          <h2 id="org-signatory-title">{{ 'ui.admin.organisation.signatoryTitle' | t }}</h2>
          <p class="org__caption">{{ 'ui.admin.organisation.signatoryHelp' | t }}</p>
          <div class="field">
            <label for="org-signatory-name">{{ 'ui.admin.organisation.signatoryName' | t }}</label>
            <input
              id="org-signatory-name"
              [value]="org.signatoryName()"
              [attr.aria-invalid]="org.signatoryErrors()['name'] ? true : null"
              [disabled]="org.signatoryBusy()"
              (input)="org.signatoryName.set(fieldValue($event))" />
            @if (org.signatoryErrors()['name']) {
              <div class="org__error" role="alert">{{ org.signatoryErrors()['name'] }}</div>
            }
          </div>
          <div class="field">
            <label for="org-signatory-designation">{{ 'ui.admin.organisation.signatoryDesignation' | t }}</label>
            <input
              id="org-signatory-designation"
              [value]="org.signatoryDesignation()"
              [attr.aria-invalid]="org.signatoryErrors()['designation'] ? true : null"
              [disabled]="org.signatoryBusy()"
              (input)="org.signatoryDesignation.set(fieldValue($event))" />
            @if (org.signatoryErrors()['designation']) {
              <div class="org__error" role="alert">{{ org.signatoryErrors()['designation'] }}</div>
            }
          </div>
          <div class="admin__line">
            <span class="admin__grow"></span>
            <button type="button" class="app-btn app-btn--primary" [disabled]="org.signatoryBusy()" (click)="org.saveSignatory()">
              {{ (org.signatoryBusy() ? 'ui.common.saving' : 'ui.admin.organisation.signatorySave') | t }}
            </button>
          </div>
          <div class="admin__line">
            @if (org.signature(); as src) {
              <img class="org__signature" [src]="src" [alt]="'ui.admin.organisation.signatureAlt' | t" />
            } @else {
              <span class="muted">{{ 'ui.admin.organisation.noSignature' | t }}</span>
            }
            <span class="admin__grow"></span>
            @if (o.signatory) {
              <button type="button" class="app-btn" [disabled]="org.signatoryBusy()" (click)="org.removeSignatory()">{{ 'ui.admin.organisation.removeSignatory' | t }}</button>
            }
          </div>
          <label class="org__drop" [attr.data-busy]="org.signatoryBusy()" [attr.data-invalid]="org.signatureError() ? true : null">
            <input
              id="org-signature"
              class="org__file"
              type="file"
              accept="image/png"
              aria-describedby="org-signature-help"
              [attr.aria-invalid]="org.signatureError() ? true : null"
              [disabled]="org.signatoryBusy()"
              (change)="chooseSignature($event)" />
            <span class="org__drop-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5z" /></svg>
            </span>
            <span class="org__drop-copy">
              <span class="org__drop-title">{{ (o.signatory?.image ? 'ui.admin.organisation.replaceSignature' : 'ui.admin.organisation.uploadSignature') | t }}</span>
              <span id="org-signature-help" class="org__drop-help">{{ 'ui.admin.organisation.signatureHelp' | t }}</span>
            </span>
          </label>
          @if (org.signatureError()) {
            <div class="org__error" role="alert">{{ org.signatureError() }}</div>
          }
        </section>
      }
    </app-page-frame>
  `,
})
export class IdentityScreen {
  readonly productName = PRODUCT_NAME;
  readonly org = inject(OrganisationStore);
  readonly settings = inject(SettingsStore);
  readonly over = signal(false);
  /** The display name as typed, so the preview follows the form. */
  readonly displayName = computed(() => String(this.settings.values()['name'] ?? ''));

  chooseLogo(e: Event): void {
    const input = e.target as HTMLInputElement;
    void this.org.chooseLogo(input.files?.[0]).finally(() => (input.value = ''));
  }

  dragOver(e: DragEvent): void {
    e.preventDefault();
    if (!this.org.logoBusy()) this.over.set(true);
  }

  dropped(e: DragEvent): void {
    e.preventDefault();
    this.over.set(false);
    if (this.org.logoBusy()) return;
    void this.org.chooseLogo(e.dataTransfer?.files?.[0]);
  }

  chooseSignature(e: Event): void {
    const input = e.target as HTMLInputElement;
    void this.org.chooseSignature(input.files?.[0]).finally(() => (input.value = ''));
  }

  fieldValue(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
}
