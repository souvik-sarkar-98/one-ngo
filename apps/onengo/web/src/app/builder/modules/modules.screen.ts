import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import type { ModuleRow } from '../../core/builder/http-access';
import { t } from '../../core/i18n/i18n';
import type { DefinitionKind } from '../../core/models';
import { kindName } from '../../core/starters';
import { TranslatePipe } from '../../services/i18n';
import { MobileFormSheet } from '../../ui/form-panel';
import { PageBack } from '../../ui/page-back';
import { ModulesStore } from './modules-store';

/** Builder 19: the ready-made modules, turned on or off, and their updates reviewed against the organisation's changes. */
@Component({
  selector: 'app-modules-screen',
  imports: [TranslatePipe, MobileFormSheet, PageBack, PageFrame],
  providers: [ModulesStore],
  styleUrl: '../builder.css',
  template: `
    <app-page-frame>
      <header class="builder-head"><app-page-back /><h1>{{ 'ui.crumbs.builder.modules' | t }}</h1></header>
      @if (store.error()) { <div class="notice error" role="alert">{{ store.error() }}</div> }
      @if (store.message()) { <div class="notice ok" role="status">{{ store.message() }}</div> }
      @if (store.narrow()) { <div class="notice info">{{ 'ui.builder.phoneReadOnly' | t }}</div> }

      @if (store.loading() && !store.modules().length) {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      } @else if (!store.modules().length) {
        <p class="muted">{{ 'ui.builder.modules.none' | t }}</p>
      } @else {
        <div class="builder-panel">
          <table class="modules-table">
            <thead>
              <tr>
                <th>{{ 'ui.builder.modules.module' | t }}</th>
                <th>{{ 'ui.builder.modules.adds' | t }}</th>
                <th>{{ 'ui.builder.version' | t }}</th>
                <th>{{ 'ui.builder.status' | t }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (m of store.modules(); track m.key) {
                <tr>
                  <th scope="row">
                    {{ m.label }}
                    @if (m.description) { <p class="muted">{{ m.description }}</p> }
                  </th>
                  <td>
                    <p class="muted">{{ 'ui.builder.modules.definitions' | t: { count: m.definitions.length } }}</p>
                    <ul class="builder-lines">
                      @for (d of m.definitions; track d.kind + d.key) { <li>{{ kind(d.kind) }} {{ d.key }}</li> }
                    </ul>
                  </td>
                  <td>
                    {{ m.installedVersion ?? '—' }}
                    @if (m.updateAvailable) { <span class="badge warn">{{ 'ui.builder.modules.available' | t: { version: m.version } }}</span> }
                  </td>
                  <td><span class="badge" [class.ok]="m.enabled">{{ (m.enabled ? 'ui.builder.modules.on' : 'ui.builder.modules.off') | t }}</span></td>
                  <td class="modules-actions">
                    @if (m.updateAvailable) {
                      <button type="button" class="small" [disabled]="store.busy()" (click)="store.openReview(m)">{{ 'ui.builder.modules.review' | t }}</button>
                    }
                    @if (store.canChange()) {
                      @if (m.enabled) {
                        <button type="button" class="small" [disabled]="store.busy()" (click)="turnOff(m)">{{ 'ui.builder.modules.turnOff' | t }}</button>
                      } @else {
                        <button type="button" class="small primary" [disabled]="store.busy()" (click)="store.turnOn(m)">{{ 'ui.builder.modules.turnOn' | t }}</button>
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="notice info">{{ 'ui.builder.modules.keepsChanges' | t }}</div>
      }

      @let r = store.review();
      <app-mobile-form-sheet
        [open]="!!r"
        [title]="'ui.builder.modules.reviewTitle' | t: { name: r?.label ?? '', from: r?.installedVersion ?? '—', to: r?.version ?? '' }"
        [saving]="store.busy()"
        [saveLabel]="'ui.builder.modules.update' | t"
        [cancelLabel]="'ui.common.back' | t"
        [showDefaultFooter]="!!r?.canUpdate && store.canChange()"
        (dismissed)="store.closeReview()"
        (save)="store.update()">
        @if (r) {
          <h3>{{ 'ui.builder.whatChanges' | t }}</h3>
          @for (d of changed(r.definitions); track d.kind + d.key) {
            <p>
              <strong>{{ kind(d.kind) }} {{ d.key }}</strong>
              <span class="badge">{{ 'ui.builder.modules.status.' + d.status | t }}</span>
              @if (d.patched) { <span class="badge warn">{{ 'ui.builder.modules.patched' | t }}</span> }
            </p>
            @if (d.lines.length) { <ul class="builder-lines">@for (line of d.lines; track $index) { <li>{{ line }}</li> }</ul> }
          } @empty {
            <p class="muted">{{ 'ui.builder.changes.none' | t }}</p>
          }
          @if (r.conflicts.length) {
            <div class="notice error" role="alert">
              <strong>{{ 'ui.builder.modules.conflicts' | t }}</strong>
              <ul>@for (c of r.conflicts; track $index) { <li><code>{{ c.kind }}:{{ c.key }}{{ c.path }}</code> {{ c.message }}</li> }</ul>
            </div>
          }
        }
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
  styles: `
    .modules-table { width: 100%; border-collapse: collapse; }
    .modules-table th, .modules-table td { text-align: left; padding: .5rem .65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    .modules-table th p { margin: .2rem 0 0; font-weight: 400; }
    .modules-table td p { margin: 0 0 .2rem; }
    .modules-actions { display: flex; gap: .4rem; justify-content: flex-end; }
  `,
})
export class ModulesScreen {
  readonly store = inject(ModulesStore);

  kind(k: DefinitionKind): string {
    return kindName(k);
  }

  changed<T extends { status: string }>(list: T[]): T[] {
    return list.filter((d) => d.status !== 'unchanged');
  }

  turnOff(m: ModuleRow): void {
    if (confirm(t('ui.builder.modules.confirmOff', { name: m.label }))) void this.store.turnOff(m);
  }
}
