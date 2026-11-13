import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { t } from '../../core/i18n/i18n';
import { TranslatePipe } from '../../services/i18n';
import { PageBack } from '../../ui/page-back';
import { RolesStore } from './roles-store';

/**
 * One role as a definition (Builder 18): its name, two-step requirement and
 * the permission grid. The member count links to Administration › Roles.
 */
@Component({
  selector: 'app-role-screen',
  imports: [TranslatePipe, PageBack, PageFrame, NgTemplateOutlet],
  providers: [RolesStore],
  styleUrls: ['../builder.css', './roles.css'],
  template: `
    <ng-template #roleBody>
      @let r = store.role();
      @let d = store.draft();
      @let g = store.grid();
      @if (store.error()) { <div class="notice error" role="alert">{{ store.error() }}</div> }
      @if (store.loading()) {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      } @else if (r && d && g) {
        @if (!embedded()) {
        <header class="builder-head">
          <app-page-back />
          <div class="builder-head__title">
            <h1>{{ r.label }}</h1>
            <span class="badge">{{ (r.customised ? 'ui.builder.roles.changed' : 'ui.builder.roles.unchanged') | t }}</span>
          </div>
          <span class="builder-spacer"></span>
          <a class="muted" [href]="membersHref()" (click)="$event.preventDefault(); store.openMembers(r.key)">{{ 'ui.builder.roles.membersLink' | t: { count: r.members } }}</a>
          <button type="button" (click)="store.openRoleView(r.key)">{{ 'ui.builder.roles.whatCanSee' | t: { role: r.label } }}</button>
          @if (store.canEdit()) {
            <button type="button" class="primary" [disabled]="store.busy() || !store.dirty()" (click)="store.save()">{{ 'ui.common.save' | t }}</button>
          }
        </header>
        }
        @if (store.message()) { <div class="notice ok" role="status">{{ store.message() }}</div> }
        @if (!store.canEdit()) { <div class="notice info">{{ (store.narrow() ? 'ui.builder.phoneReadOnly' : 'ui.builder.roles.needsPermission') | t }}</div> }

        <section class="builder-body role-general">
          <div class="field">
            <label for="role-name">{{ 'ui.builder.roles.name' | t }}</label>
            <input id="role-name" [value]="d.label" [disabled]="!store.canEdit()" (input)="store.setLabel($any($event.target).value)" />
          </div>
          <label class="role-check">
            <input type="checkbox" [checked]="d.requireTwoStep" [disabled]="!store.canEdit()" (change)="store.setTwoStep($any($event.target).checked)" />
            {{ 'ui.builder.roles.twoStepRequire' | t }}
          </label>
        </section>

        @if (g.recordTypes.length) {
          <div class="builder-panel">
            <table class="role-grid">
              <thead>
                <tr>
                  <th>{{ 'ui.builder.roles.recordType' | t }}</th>
                  @for (c of g.columns; track c) { <th>{{ columnLabel(c) }}</th> }
                  <th>{{ 'ui.builder.roles.steps' | t }}</th>
                  <th>{{ 'ui.builder.roles.actions' | t }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of g.recordTypes; track row.key) {
                  <tr>
                    <th scope="row">{{ row.label }}</th>
                    @for (c of g.columns; track c) {
                      <td>
                        @if (row.cells[c]; as cell) {
                          <input type="checkbox" [checked]="cell.on" [disabled]="!store.canEdit() || !!cell.via" [title]="cellTitle(cell.label, cell.via)" [attr.aria-label]="cell.label" (change)="store.toggle(cell.permission, $any($event.target).checked)" />
                        }
                      </td>
                    }
                    @for (list of [row.steps, row.actions]; track $index) {
                      <td>
                        @for (cell of list; track cell.permission) {
                          <label class="role-pill" [class.on]="cell.on" [title]="cellTitle(cell.permission, cell.via)">
                            <input type="checkbox" [checked]="cell.on" [disabled]="!store.canEdit() || !!cell.via" (change)="store.toggle(cell.permission, $any($event.target).checked)" />
                            {{ cell.label }}
                          </label>
                        } @empty { <span class="muted">—</span> }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        <div class="role-groups">
          @for (group of groups(); track group.id) {
            @if (group.cells.length) {
              <section class="builder-body">
                <h3>{{ group.label }}</h3>
                @for (cell of group.cells; track cell.permission) {
                  <label class="role-check">
                    <input type="checkbox" [checked]="cell.on" [disabled]="!store.canEdit() || !!cell.via" (change)="store.toggle(cell.permission, $any($event.target).checked)" />
                    <span>{{ cell.label }} <code>{{ cell.permission }}</code></span>
                  </label>
                }
              </section>
            }
          }
          @if (g.extra.length) {
            <section class="builder-body">
              <h3>{{ 'ui.builder.roles.otherGrants' | t }}</h3>
              <p class="muted">{{ 'ui.builder.roles.otherGrantsHint' | t }}</p>
              @for (p of g.extra; track p) {
                <label class="role-check">
                  <input type="checkbox" checked [disabled]="!store.canEdit()" (change)="store.toggle(p, $any($event.target).checked)" />
                  <code>{{ p }}</code>
                </label>
              }
            </section>
          }
        </div>

        @if (store.canEdit()) {
          <footer class="builder-foot">
            <span class="muted">{{ (store.dirty() ? 'ui.builder.unsaved' : 'ui.builder.roles.allSaved') | t }}</span>
            <span class="builder-spacer"></span>
            <button type="button" [disabled]="store.busy() || !store.dirty()" (click)="store.revert()">{{ 'ui.builder.roles.undo' | t }}</button>
            <button type="button" class="primary" [disabled]="store.busy() || !store.dirty()" (click)="store.save()">{{ 'ui.common.save' | t }}</button>
          </footer>
        }
      }
    </ng-template>
    @if (embedded()) {
      <ng-container *ngTemplateOutlet="roleBody" />
    } @else {
      <app-page-frame>
        <ng-container *ngTemplateOutlet="roleBody" />
      </app-page-frame>
    }
  `,
})
export class RoleScreen {
  readonly store = inject(RolesStore);
  readonly key = input.required<string>();
  /** Drawn inside Administration's role page, which already has the page frame and the members list. */
  readonly embedded = input(false);
  readonly membersHref = computed(() => `/admin/roles/${encodeURIComponent(this.key())}`);
  readonly groups = computed(() => {
    const g = this.store.grid();
    if (!g) return [];
    return [
      { id: 'money', label: t('ui.builder.roles.money'), cells: g.money },
      { id: 'setup', label: t('ui.builder.roles.setup'), cells: g.setup },
      { id: 'used', label: t('ui.builder.roles.used'), cells: g.used },
      { id: 'others', label: t('ui.builder.roles.more'), cells: g.recordTypes.flatMap((r) => r.others) },
    ];
  });

  constructor() {
    effect(() => {
      const key = this.key();
      untracked(() => void this.store.loadRole(key));
    });
  }

  columnLabel(column: string): string {
    return t(`ui.builder.roles.column.${column === 'read:all' ? 'seeAll' : column}`);
  }

  cellTitle(label: string, via: string | null): string {
    return via ? t('ui.builder.roles.via', { label, grant: via }) : label;
  }
}
