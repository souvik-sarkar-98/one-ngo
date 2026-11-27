import { Component, inject } from '@angular/core';
import { Btn, PageFrame } from '@onengo/web-kit';
import type { ModuleDefinition, ModuleRow } from '../../core/builder/http-access';
import { behindTheScenes, definitionName, hiddenCount, visibilityGroups } from '../../core/builder/module-visibility';
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
  imports: [Btn, TranslatePipe, MobileFormSheet, PageBack, PageFrame],
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
                    <p class="muted">
                      {{ 'ui.builder.modules.definitions' | t: { count: m.definitions.length } }}
                      @if (m.enabled) {
                        ·
                        @if (hidden(m); as n) { <span class="badge hidden">{{ 'ui.builder.modules.hiddenCount' | t: { count: n } }}</span> }
                        @else { {{ 'ui.builder.modules.allShown' | t }} }
                      }
                    </p>
                    @if (m.enabled) {
                      @if (store.canChange()) {
                        <button appBtn="link" size="sm" type="button" [attr.aria-expanded]="store.open() === m.key" (click)="store.toggleOpen(m)">
                          {{ (store.open() === m.key ? 'ui.builder.modules.closeShown' : 'ui.builder.modules.chooseShown') | t }}
                        </button>
                      } @else if (hiddenNames(m); as names) {
                        <p class="muted">{{ 'ui.builder.modules.hiddenList' | t: { names: names } }}</p>
                      }
                    } @else {
                      <ul class="builder-lines">
                        @for (d of m.definitions; track d.kind + d.key) { <li>{{ kind(d.kind) }} {{ d.key }}</li> }
                      </ul>
                    }
                  </td>
                  <td>
                    {{ m.installedVersion ?? '—' }}
                    @if (m.updateAvailable) { <span class="badge warn">{{ 'ui.builder.modules.available' | t: { version: m.version } }}</span> }
                  </td>
                  <td><span class="badge" [class.ok]="m.enabled">{{ (m.enabled ? 'ui.builder.modules.on' : 'ui.builder.modules.off') | t }}</span></td>
                  <td>
                    <div class="modules-actions">
                      @if (m.updateAvailable) {
                        <button appBtn size="sm" type="button" [disabled]="store.busy()" (click)="store.openReview(m)">{{ 'ui.builder.modules.review' | t }}</button>
                      }
                      @if (store.canChange()) {
                        @if (m.enabled) {
                          <button appBtn size="sm" type="button" [disabled]="store.busy()" (click)="turnOff(m)">{{ 'ui.builder.modules.turnOff' | t }}</button>
                        } @else {
                          <button appBtn="primary" size="sm" type="button" [disabled]="store.busy()" (click)="store.turnOn(m)">{{ 'ui.builder.modules.turnOn' | t }}</button>
                        }
                      }
                    </div>
                  </td>
                </tr>
                @if (m.enabled && store.canChange() && store.open() === m.key) {
                  <tr class="panel-row">
                    <td colspan="5">
                      <section class="vis" [attr.aria-label]="'ui.builder.modules.showInMenus' | t">
                        <div class="vis-head">
                          <strong>{{ 'ui.builder.modules.showInMenus' | t }}</strong>
                          <span class="muted">{{ 'ui.builder.modules.showHint' | t }}</span>
                        </div>
                        @if (m.updateAvailable) {
                          <div class="notice warn">{{ 'ui.builder.modules.updateFirst' | t: { name: m.label, version: m.version } }}</div>
                        }
                        <div class="vis-grid">
                          @for (g of groups(m); track g.kind) {
                            <div class="vis-group">
                              <h4>{{ kind(g.kind) }}</h4>
                              @for (d of g.items; track d.key) {
                                @let locked = store.busy() || m.updateAvailable || d.blocked !== null;
                                <label [class.off]="locked">
                                  <input type="checkbox" [checked]="!d.hidden" [disabled]="locked" (change)="store.setHidden(m, d, !$any($event.target).checked)" />
                                  {{ name(d) }}
                                  @if (d.hidden) { <span class="badge hidden">{{ 'ui.builder.modules.hiddenBadge' | t }}</span> }
                                </label>
                                @if (d.blocked) { <span class="why">{{ 'ui.builder.modules.blocked.' + d.blocked | t }}</span> }
                              }
                            </div>
                          }
                          @if (behind(m).length) {
                            <div class="vis-group">
                              <h4>{{ 'ui.builder.modules.behindScenes' | t }}</h4>
                              <ul>
                                @for (d of behind(m); track d.kind + d.key) { <li>{{ kind(d.kind) }}: {{ name(d) }}</li> }
                              </ul>
                            </div>
                          }
                        </div>
                        <p class="vis-foot muted">{{ 'ui.builder.modules.showFoot' | t }}</p>
                      </section>
                    </td>
                  </tr>
                }
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
    .modules-table { table-layout: auto; }
    .modules-table th, .modules-table td { text-align: left; padding: .5rem .65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    /* The shared table rules put nowrap on every th; the module name and its description must wrap instead. */
    .modules-table tbody th { white-space: normal; min-width: 14rem; }
    .modules-table td { white-space: normal; }
    .modules-table th p { margin: .2rem 0 0; font-weight: 400; white-space: normal; }
    .modules-table td p { margin: 0 0 .2rem; }
    .modules-table td .badge.warn { display: inline-block; margin-top: .3rem; white-space: normal; }
    .modules-actions { display: flex; flex-wrap: wrap; gap: .4rem; justify-content: flex-end; }
    .badge.hidden { display: inline-block; background: var(--badge-hidden-bg); color: var(--badge-hidden-fg); }
    .modules-table tr.panel-row > td { background: var(--surface, #f8faff); padding: 0; }
    .vis { padding: .75rem 1rem .9rem; border-left: 3px solid var(--brand, #2f6fde); }
    .vis-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem; margin-bottom: .6rem; }
    .vis-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .75rem 1.25rem; }
    .vis-group h4 { margin: 0 0 .25rem; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .vis-group label { display: flex; align-items: center; gap: .5rem; padding: .2rem 0; cursor: pointer; }
    .vis-group label.off { color: var(--muted); cursor: not-allowed; }
    .vis-group .why { display: block; font-size: .75rem; color: var(--muted); margin: -.1rem 0 .15rem 1.6rem; }
    .vis-group ul { margin: 0; padding-left: 1.1rem; color: var(--muted); }
    .vis-foot { margin: .75rem 0 0; font-size: .8rem; }
  `,
})
export class ModulesScreen {
  readonly store = inject(ModulesStore);

  kind(k: DefinitionKind): string {
    return kindName(k);
  }

  hidden(m: ModuleRow): number {
    return hiddenCount(m.definitions);
  }

  hiddenNames(m: ModuleRow): string {
    return m.definitions.filter((d) => d.hideable && d.hidden).map(definitionName).join(', ');
  }

  groups(m: ModuleRow) {
    return visibilityGroups(m.definitions);
  }

  behind(m: ModuleRow) {
    return behindTheScenes(m.definitions);
  }

  name(d: ModuleDefinition): string {
    return definitionName(d);
  }

  changed<T extends { status: string }>(list: T[]): T[] {
    return list.filter((d) => d.status !== 'unchanged');
  }

  turnOff(m: ModuleRow): void {
    if (confirm(t('ui.builder.modules.confirmOff', { name: m.label }))) void this.store.turnOff(m);
  }
}
