import { Component, inject } from '@angular/core';
import { Btn, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { OrganisationStore } from './organisation-store';

/**
 * Signatories: the people who sign documents, with their signature images. A
 * report or receipt rule chooses its signatories in its builder, and the receipt
 * default is chosen under the receipt rules.
 */
@Component({
  selector: 'app-admin-signatories',
  imports: [Btn, PageFrame, ScreenHeading, TranslatePipe],
  providers: [OrganisationStore],
  styleUrl: '../admin.css',
  styles: `
    .org__caption {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 0.8rem;
    }
    .org__error {
      margin: 0 0 8px;
      color: var(--bad, #b91c1c);
      font-size: 0.85rem;
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
    .org__signature {
      flex: 0 0 auto;
      width: 120px;
      height: 44px;
      object-fit: contain;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--card);
    }
    .org__row {
      flex-wrap: wrap;
    }
    .org__fields {
      display: grid;
      gap: 0 12px;
    }
    @media (min-width: 640px) {
      .org__fields {
        grid-template-columns: 1fr 1fr;
      }
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.signatories' | t" />
      <p class="muted">{{ 'ui.admin.signatories.intro' | t }}</p>
      @if (org.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (org.error()) {
        <div class="notice error" role="alert">{{ org.error() }}</div>
      }
      @if (org.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (org.view(); as o) {
        <section class="card" aria-labelledby="org-signatory-title">
          <div class="admin__line">
            <h2 id="org-signatory-title" class="admin__grow">{{ 'ui.admin.organisation.signatoryTitle' | t }}</h2>
            @if (org.editingSignatory() === null) {
              <button appBtn type="button" [disabled]="org.signatoryBusy() || o.signatories.length >= 20" (click)="org.beginAdd()">{{ 'ui.admin.organisation.addSignatory' | t }}</button>
            }
          </div>
          <p class="muted">{{ 'ui.admin.organisation.signatoryHelp' | t }}</p>
          @if (!o.signatories.length) {
            <p class="muted">{{ 'ui.admin.organisation.noSignatories' | t }}</p>
          } @else {
            <ul class="admin__list">
              @for (signatory of o.signatories; track signatory.id) {
                <li>
                  <div class="admin__row org__row">
                    <span class="admin__label">
                      <strong>{{ signatory.name }}</strong>
                      <span class="muted">{{ signatory.designation }}</span>
                    </span>
                    @if (org.signatures()[signatory.id]; as src) {
                      <img class="org__signature" [src]="src" [alt]="'ui.admin.organisation.signatureAlt' | t" />
                    } @else {
                      <span class="muted">{{ 'ui.admin.organisation.noSignature' | t }}</span>
                    }
                    <button appBtn type="button" [disabled]="org.signatoryBusy()" (click)="org.beginEdit(signatory.id)">{{ 'ui.common.edit' | t }}</button>
                    <label class="app-btn">
                      {{ (signatory.image ? 'ui.admin.organisation.replaceSignature' : 'ui.admin.organisation.uploadSignature') | t }}
                      <input class="org__file" type="file" accept="image/png" [disabled]="org.signatoryBusy()" (change)="chooseSignature(signatory.id, $event)" />
                    </label>
                    <button appBtn type="button" [disabled]="org.signatoryBusy()" (click)="org.removeSignatory(signatory.id)">{{ 'ui.admin.organisation.removeSignatory' | t }}</button>
                  </div>
                </li>
              }
            </ul>
          }
          @if (org.signatureError()) {
            <div class="org__error" role="alert">{{ org.signatureError() }}</div>
          }
          @if (org.editingSignatory() !== null) {
            <div class="card" role="group" aria-labelledby="org-signatory-edit">
              <h3 id="org-signatory-edit">{{ (org.editingSignatory() === 'new' ? 'ui.admin.organisation.addSignatory' : 'ui.common.edit') | t }}</h3>
              <div class="org__fields">
                <div class="field">
                  <label for="org-signatory-name">{{ 'ui.admin.organisation.signatoryName' | t }}</label>
                  <input id="org-signatory-name" [value]="org.signatoryName()" [attr.aria-invalid]="org.signatoryErrors()['name'] ? true : null" [disabled]="org.signatoryBusy()" (input)="org.signatoryName.set(fieldValue($event))" />
                  @if (org.signatoryErrors()['name']) {
                    <div class="org__error" role="alert">{{ org.signatoryErrors()['name'] }}</div>
                  }
                </div>
                <div class="field">
                  <label for="org-signatory-designation">{{ 'ui.admin.organisation.signatoryDesignation' | t }}</label>
                  <input id="org-signatory-designation" [value]="org.signatoryDesignation()" [attr.aria-invalid]="org.signatoryErrors()['designation'] ? true : null" [disabled]="org.signatoryBusy()" (input)="org.signatoryDesignation.set(fieldValue($event))" />
                  @if (org.signatoryErrors()['designation']) {
                    <div class="org__error" role="alert">{{ org.signatoryErrors()['designation'] }}</div>
                  }
                </div>
              </div>
              <p class="org__caption" id="org-signature-help">{{ 'ui.admin.organisation.signatureHelp' | t }}</p>
              <div class="admin__line">
                <span class="admin__grow"></span>
                <button appBtn type="button" [disabled]="org.signatoryBusy()" (click)="org.cancelSignatory()">{{ 'ui.common.cancel' | t }}</button>
                <button appBtn="primary" type="button" [disabled]="org.signatoryBusy()" (click)="org.saveSignatory()">
                  {{ (org.signatoryBusy() ? 'ui.common.saving' : 'ui.admin.organisation.signatorySave') | t }}
                </button>
              </div>
            </div>
          }
        </section>
      }
    </app-page-frame>
  `,
})
export class SignatoriesScreen {
  readonly org = inject(OrganisationStore);

  chooseSignature(id: string, e: Event): void {
    const input = e.target as HTMLInputElement;
    void this.org.chooseSignature(id, input.files?.[0]).finally(() => (input.value = ''));
  }

  fieldValue(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
}
