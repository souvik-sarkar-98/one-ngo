import { Component, computed, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { ACCESS_CHIPS } from '../../core/builder/access-map';
import { t } from '../../core/i18n/i18n';
import type { DefinitionKind } from '../../core/models';
import { kindName } from '../../core/starters';
import { TranslatePipe } from '../../services/i18n';
import { ChipFilterBar } from '../../ui/chip-bar';
import { RolePreview } from '../../ui/role-preview';
import { MenuButton, type MenuItem } from '../../ui/menu-button';
import { PageBack } from '../../ui/page-back';
import { PermissionField } from '../../ui/permission-field';
import { AccessStore } from './access-store';

/**
 * Builder 24–25: what each part of the app requires and who holds it, with
 * inline changes of the overridable permissions; with a role chosen, what
 * that role sees, in words and in a live preview.
 */
@Component({
  selector: 'app-access-screen',
  imports: [TranslatePipe, ChipFilterBar, MenuButton, PermissionField, RolePreview, PageBack, PageFrame],
  providers: [AccessStore],
  styleUrls: ['../builder.css', './access.css'],
  template: `
    <app-page-frame>
      @let role = store.role();
      @if (role) {
        <header class="builder-head">
          <app-page-back />
          <h1>{{ 'ui.builder.access.roleTitle' | t: { role: role.label } }}</h1>
          <span class="builder-spacer"></span>
          <button type="button" (click)="store.closeRoleView()">{{ 'ui.builder.access.backToMap' | t }}</button>
          @if (store.canEditRoles()) { <button type="button" (click)="store.editRole(role.key)">{{ 'ui.builder.access.editRole' | t: { role: role.label } }}</button> }
        </header>
        <app-chip-filter-bar [chips]="roleChips()" [activeId]="role.key" (chipSelect)="store.openRoleView($event)" />
      } @else {
        <header class="builder-head">
          <app-page-back />
          <h1>{{ 'ui.crumbs.builder.access' | t }}</h1>
          <span class="builder-spacer"></span>
          @if (store.showRoles()) {
            <app-menu-button [label]="'ui.builder.access.whatCanRoleSee' | t" [items]="roleItems()" (choose)="store.openRoleView($event)" />
          }
        </header>
        <p class="muted">{{ 'ui.builder.access.intro' | t }}</p>
      }

      @if (store.error()) { <div class="notice error" role="alert">{{ store.error() }}</div> }
      @if (store.loading() && !store.map()) {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      } @else if (role) {
        @if (store.summary(); as s) {
          <div class="access-role">
            <div>
              <h3>{{ 'ui.builder.access.records' | t }}</h3>
              <ul class="builder-body access-summary">
                @for (r of s.records; track r.key) {
                  <li>
                    <strong>{{ r.label }}</strong>
                    @if (r.visible) {
                      @for (line of r.lines; track $index) { <div>{{ line }}</div> }
                    } @else { <span class="muted">{{ 'ui.builder.access.notVisible' | t }}</span> }
                  </li>
                }
              </ul>
              @if (s.pages.length) {
                <h3>{{ 'ui.builder.access.groupPages' | t }}</h3>
                <ul class="builder-body access-summary">
                  @for (p of s.pages; track p.key) {
                    <li>
                      <strong>{{ p.label }}</strong>
                      @if (p.visible) {
                        @for (line of p.lines; track $index) { <div>{{ line }}</div> } @empty { <div>{{ 'ui.builder.access.allWidgets' | t }}</div> }
                      } @else { <span class="muted">{{ 'ui.builder.access.notInAudience' | t }}</span> }
                    </li>
                  }
                </ul>
              }
              <h3>{{ 'ui.builder.access.groupApp' | t }}</h3>
              <p class="builder-body">
                @for (a of s.areas; track a.label) { <span class="access-area" [class.on]="a.on">{{ a.on ? '✓' : '✗' }} {{ a.label }}</span> }
              </p>
            </div>
            <div>
              <div class="field">
                <label for="preview-type">{{ 'ui.builder.access.previewOf' | t }}</label>
                <select id="preview-type" [value]="previewKey()" (change)="store.previewType.set($any($event.target).value)">
                  @for (r of store.recordTypes(); track r.key) { <option [value]="r.key">{{ r.label }}</option> }
                </select>
              </div>
              @if (store.preview(); as p) {
                @if (p.visible) {
                  <app-role-preview
                    [title]="p.title"
                    [chips]="p.chips"
                    [rows]="p.rows"
                    [canCreate]="p.canCreate"
                    [panelTitle]="p.panelTitle"
                    [sections]="p.sections"
                    [steps]="p.steps"
                    [note]="'ui.builder.access.previewNote' | t: { role: role.label }" />
                } @else {
                  <p class="muted">{{ 'ui.builder.access.notVisible' | t }}</p>
                }
              }
            </div>
          </div>
        }
      } @else {
        <app-chip-filter-bar [chips]="areaChips()" [activeId]="store.address().area" (chipSelect)="store.selectArea($event)" />
        <div class="access-filters">
          <input type="search" [value]="store.searchText()" [placeholder]="'ui.builder.access.searchPlaceholder' | t" [attr.aria-label]="'ui.builder.access.searchPlaceholder' | t" (input)="store.search($any($event.target).value)" />
          <label>
            {{ 'ui.builder.access.recordType' | t }}
            <select [value]="store.address().recordType ?? ''" (change)="store.setRecordType($any($event.target).value)">
              <option value="">{{ 'ui.builder.access.any' | t }}</option>
              @for (r of store.recordTypes(); track r.key) { <option [value]="r.key">{{ r.label }}</option> }
            </select>
          </label>
          @if (store.showRoles()) {
            <label>
              {{ 'ui.builder.access.heldBy' | t }}
              <select [value]="store.address().heldBy ?? ''" (change)="store.setHeldBy($any($event.target).value)">
                <option value="">{{ 'ui.builder.access.any' | t }}</option>
                @for (r of store.roles(); track r.key) { <option [value]="r.key">{{ r.label }}</option> }
              </select>
            </label>
            <label class="access-check">
              <input type="checkbox" [checked]="store.address().problems" (change)="store.setProblems($any($event.target).checked)" />
              {{ 'ui.builder.access.onlyProblems' | t }}
            </label>
          }
        </div>

        @let v = store.view();
        @for (p of v.problems; track p.permission) {
          <div class="notice info" role="status">⚠ {{ 'ui.builder.access.problem' | t: { list: p.labels.join(', ') } }} <code>{{ p.permission }}</code></div>
        }

        @if (v.groups.length) {
          <div class="builder-panel">
            <table class="access-table">
              <thead>
                <tr>
                  <th>{{ 'ui.builder.access.element' | t }}</th>
                  <th>{{ 'ui.builder.access.where' | t }}</th>
                  <th>{{ 'ui.builder.access.requires' | t }}</th>
                  @if (store.showRoles()) { <th>{{ 'ui.builder.access.heldBy' | t }}</th> }
                </tr>
              </thead>
              @for (g of v.groups; track g.id) {
                <tbody>
                  <tr class="access-group"><th [attr.colspan]="store.showRoles() ? 4 : 3" scope="colgroup">{{ g.label }}</th></tr>
                  @for (r of g.rows; track r.id) {
                    <tr [class.sel]="store.editing()?.id === r.id">
                      <td>{{ r.label }}</td>
                      <td class="muted">{{ r.where }}</td>
                      <td>
                        @if (store.editing()?.id === r.id) {
                          <app-permission-field [label]="'ui.builder.access.requires' | t" [value]="store.editing()!.value" [source]="store.permissionSource" [hint]="'ui.builder.access.emptyDefault' | t" (valueChange)="store.type($event)" />
                          <div class="access-edit">
                            <button type="button" class="primary small" (click)="store.applyEdit(r.element)">{{ 'ui.builder.access.apply' | t }}</button>
                            <button type="button" class="small" (click)="store.cancelEdit()">{{ 'ui.common.cancel' | t }}</button>
                          </div>
                        } @else {
                          @if (r.permission) { <code>{{ r.permission }}</code> } @else { <span class="muted">{{ 'ui.builder.access.noPermission' | t }}</span> }
                          @if (r.note) { <span class="muted"> {{ r.note }}</span> }
                          @if (r.changed) { <span class="badge warn">{{ 'ui.builder.access.draft' | t }}</span> }
                          @if (r.element.overridable && store.canEdit() && r.element.definition) {
                            <button type="button" class="small" (click)="store.startEdit(r.element)">{{ 'ui.builder.access.change' | t }}</button>
                          }
                        }
                      </td>
                      @if (store.showRoles()) {
                        <td>
                          @if (r.noRole) { <span class="badge warn">{{ 'ui.builder.access.noRole' | t }}</span> } @else { {{ r.holders }} }
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              }
            </table>
          </div>
        } @else if (!store.loading()) {
          <p class="muted">{{ 'ui.common.noItemsFound' | t }}</p>
        }

        @let d = store.draft();
        @if (d.error) {
          <div class="notice error" role="alert">
            {{ d.error }}
            @if (d.issues.length) { <ul>@for (i of d.issues; track $index) { <li><code>{{ i.path }}</code> {{ i.message }}</li> }</ul> }
          </div>
        } @else if (d.issues.length) {
          <div class="notice info" role="status"><ul>@for (i of d.issues; track $index) { <li><code>{{ i.path }}</code> {{ i.message }}</li> }</ul></div>
        }
        @if (d.message) { <div class="notice ok" role="status">{{ d.message }}</div> }
        @if (d.drafts.length) {
          <footer class="builder-foot">
            <span class="muted">{{ draftsText() }}</span>
            <span class="builder-spacer"></span>
            <button type="button" [disabled]="d.busy" (click)="discard()">{{ 'ui.builder.discardDraft' | t }}</button>
            <button type="button" [disabled]="d.busy" (click)="store.check()">{{ 'ui.builder.check' | t }}</button>
            <button type="button" class="primary" [disabled]="d.busy || !store.canEdit()" (click)="publish()">{{ 'ui.builder.publishEllipsis' | t }}</button>
          </footer>
        }
      }
    </app-page-frame>
  `,
})
export class AccessScreen {
  readonly store = inject(AccessStore);
  readonly areaChips = computed(() => ACCESS_CHIPS.map((id) => ({ id, label: t(`ui.builder.access.chip.${id}`) })));
  readonly roleChips = computed(() => this.store.roles().map((r) => ({ id: r.key, label: r.label })));
  readonly roleItems = computed<MenuItem[]>(() => this.store.roles().map((r) => ({ id: r.key, label: r.label })));
  readonly previewKey = computed(() => this.store.previewType() ?? this.store.summary()?.records.find((r) => r.visible)?.key ?? '');
  readonly draftsText = computed(() => {
    const drafts = this.store.draft().drafts;
    return t('ui.builder.access.drafts', { count: drafts.length, list: drafts.map((d) => this.definitionName(d.kind, d.key)).join(', ') });
  });

  definitionName(kind: DefinitionKind, key: string): string {
    return `${kindName(kind)} ${key}`;
  }

  async publish(): Promise<void> {
    if (confirm(t('ui.builder.access.confirmPublish', { list: this.draftsText() }))) await this.store.publish();
  }

  async discard(): Promise<void> {
    if (confirm(t('ui.builder.confirmDiscard'))) await this.store.discard();
  }
}
