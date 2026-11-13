import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { CfForm } from '../../ui/cf-form';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { ScreenHeading } from '../../ui/screen-heading';
import { ConnectorStore } from './connectors-store';

/**
 * One connector, one column on every size: settings with secrets shown only
 * as set or not set, Test, then the delivery log; a delivery opens the
 * service's answer with Retry now.
 */
@Component({
  selector: 'app-admin-connector',
  imports: [FilteredInfiniteList, MobileFormSheet, CfForm, ScreenHeading, TranslatePipe, PageFrame],
  providers: [ConnectorStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../admin.css'],
  template: `
    <app-page-frame>
      @if (store.key) {
        <app-screen-heading [text]="store.key" />
      }
      @let s = store.state();
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (s.error && !s.saving) {
        <div class="notice error" role="alert">{{ s.error }}</div>
      }
      @if (s.loading) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else {
        <div class="card admin__card">
          <div class="admin__line">
            <strong>{{ store.key }}</strong>
            @if (store.kindName()) {
              <span class="badge">{{ store.kindName() }}</span>
            }
          </div>
          @if (s.kind === 'oauth') {
            <div class="admin__line">
              <span class="badge" [class.ok]="!!s.view?.oauth?.connected">{{ store.oauthState() }}</span>
              <span class="admin__grow"></span>
              <button type="button" class="app-btn" [disabled]="s.isNew || s.saving" (click)="store.connect()">{{ (s.view?.oauth?.connected ? 'ui.admin.connectors.reconnect' : 'ui.admin.connectors.connect') | t }}</button>
            </div>
            @if (s.isNew) {
              <span class="help">{{ 'ui.admin.connectors.connectAfterSave' | t }}</span>
            }
          }
          @if (s.isNew) {
            <div class="field">
              <label for="connector-kind">{{ 'ui.admin.connectors.col.kind' | t }}<span class="cf-required-mark" aria-hidden="true"> *</span></label>
              <select id="connector-kind" [value]="s.kindChosen ? s.kind : ''" (change)="store.chooseKind($any($event.target).value)" aria-required="true">
                <option value=""></option>
                @for (k of store.kinds; track k.key) {
                  <option [value]="k.key">{{ k.label }}</option>
                }
              </select>
              @if (s.errors['kind']; as e) {
                <span class="error" role="alert">{{ e }}</span>
              }
            </div>
          }
          <cf-form [fields]="store.fields()" [values]="s.values" [errors]="s.errors" idPrefix="connector" (valuesChange)="store.connector.setValues($event)" />
          @for (secret of s.secrets; track secret.name) {
            <div class="field">
              <label [attr.for]="'secret-' + secret.name">{{ secret.label }}</label>
              @if (secret.editing) {
                <input [id]="'secret-' + secret.name" type="password" autocomplete="new-password" [value]="secret.value" (input)="store.connector.typeSecret(secret.name, $any($event.target).value)" />
              } @else {
                <div class="admin__line">
                  <span class="badge ok">{{ 'ui.admin.connectors.set' | t }}</span>
                  <span class="admin__grow"></span>
                  <button type="button" class="app-btn" (click)="store.connector.editSecret(secret.name)">{{ 'ui.admin.connectors.replace' | t }}</button>
                </div>
              }
              @if (!secret.set && !secret.value) {
                <span class="help">{{ 'ui.admin.connectors.notSet' | t }}</span>
              }
              @if (s.errors[secret.name]; as e) {
                <span class="error" role="alert">{{ e }}</span>
              }
            </div>
          }
          @if (s.kind === 'http') {
            <div class="field">
              <label for="connector-new-secret">{{ 'ui.admin.connectors.secretNameLabel' | t }}</label>
              <div class="admin__line">
                <input id="connector-new-secret" class="admin__grow" [value]="s.newSecret" (input)="store.connector.setNewSecret($any($event.target).value)" (keydown.enter)="store.connector.addSecret()" />
                <button type="button" class="app-btn" (click)="store.connector.addSecret()">{{ 'ui.admin.connectors.addSecret' | t }}</button>
              </div>
              <span class="help">{{ 'ui.admin.connectors.h.secrets' | t }}</span>
              @if (s.errors['newSecret']; as e) {
                <span class="error" role="alert">{{ e }}</span>
              }
            </div>
          }
          @if (s.kind === 'oauth') {
            <div class="field">
              <label for="connector-redirect">{{ 'ui.admin.connectors.redirect' | t }}</label>
              <input id="connector-redirect" readonly [value]="store.redirectUrl" />
            </div>
          }
          @if (!s.isNew) {
            @switch (store.testMode()) {
              @case ('phone') {
                <div class="field">
                  <label for="connector-test-to">{{ 'ui.admin.connectors.testTo' | t }}</label>
                  <input id="connector-test-to" type="tel" [value]="s.testTo" (input)="store.connector.setTestTo($any($event.target).value)" />
                </div>
              }
              @case ('email') {
                <div class="field">
                  <label for="connector-test-email">{{ 'ui.admin.connectors.testToEmail' | t }}</label>
                  <input id="connector-test-email" type="email" [value]="s.testTo" (input)="store.connector.setTestTo($any($event.target).value)" />
                </div>
              }
              @case ('sample') {
                <p class="help">{{ 'ui.admin.connectors.testSample' | t }}</p>
              }
              @case ('lookup') {
                <h2 class="admin__caption">{{ 'ui.admin.connectors.tryLookup' | t }}</h2>
                @for (f of store.lookupInputs(); track f) {
                  <div class="field">
                    <label [attr.for]="'connector-input-' + f">{{ f }}</label>
                    <input [id]="'connector-input-' + f" [value]="s.testInputs[f]" (input)="store.connector.setTestInput(f, $any($event.target).value)" />
                  </div>
                }
              }
            }
          }
          <div class="admin__line">
            @if (!s.isNew) {
              <button type="button" class="app-btn" [disabled]="s.saving" (click)="store.test()">{{ (store.testMode() === 'lookup' ? 'ui.admin.connectors.lookUp' : 'ui.admin.connectors.test') | t }}</button>
            }
            <span class="admin__grow"></span>
            <button type="button" class="app-btn app-btn--primary" [disabled]="s.saving" (click)="store.save()">{{ (s.saving ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
          </div>
          @if (s.testResult; as r) {
            <div class="notice" [class.ok]="r.ok" [class.error]="!r.ok" role="status">{{ r.message }}</div>
            @if (r.values) {
              <div class="admin__kv">
                @for (v of r.values; track v.key) {
                  <b>{{ v.key }}</b><span>{{ v.value }}</span>
                }
              </div>
            }
          }
        </div>

        @if (!s.isNew) {
          <h2 class="admin__caption">{{ 'ui.admin.connectors.deliveries' | t }}</h2>
          <section class="list-dashboard">
            <app-filtered-infinite-list
              [chips]="store.chips()"
              [activeChipId]="s.chip"
              [toolbar]="false"
              [items]="store.rows()"
              [emptyMessage]="'ui.admin.empty' | t"
              [layout]="store.layout()"
              [columns]="store.columns()"
              [selectedId]="store.result()"
              badgeKey="result"
              (chipSelect)="store.connector.setChip($event)"
              (rowClick)="store.connector.openResult($event.id, !!store.result())">
            </app-filtered-infinite-list>
          </section>
        }
      }

      <app-mobile-form-sheet
        [open]="!!store.openDelivery()"
        [title]="'ui.admin.connectors.del.result' | t"
        [showDefaultFooter]="false"
        (dismissed)="store.connector.closeResult()">
        @if (store.openDelivery(); as d) {
          <div class="admin__kv">
            <b>{{ 'ui.admin.connectors.del.sent' | t }}</b><span>{{ d.event }}</span>
            <b>{{ 'ui.admin.connectors.del.record' | t }}</b><span>{{ d.recordId ?? '—' }}</span>
            <b>{{ 'ui.admin.connectors.del.tries' | t }}</b><span>{{ 'ui.admin.connectors.tries' | t: { count: d.attempts } }}</span>
            <b>{{ 'ui.admin.connectors.del.result' | t }}</b><span>{{ d.responseStatus !== null ? ('ui.admin.connectors.answer' | t: { status: d.responseStatus }) : '—' }}</span>
          </div>
          @if (d.error) {
            <div class="admin__problem">{{ d.error }}</div>
          }
        }
        <button sheetFooterActions type="button" class="app-btn" (click)="store.connector.closeResult()">{{ 'ui.common.close' | t }}</button>
        @if (store.openDelivery()?.status !== 'sent') {
          <button sheetFooterActions type="button" class="app-btn app-btn--primary" (click)="store.retry(store.openDelivery()!.id)">{{ 'ui.admin.connectors.retry' | t }}</button>
        }
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class ConnectorScreen {
  readonly store = inject(ConnectorStore);
}
