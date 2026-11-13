import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import type { FormNode } from '../../../core/builder/schema-form';
import { TranslatePipe } from '../../../services/i18n';
import { GenericEditorStore } from './generic-store';
import { PreviewStore } from './preview-store';
import { PREVIEWS } from './previews';
import { SchemaNode } from './schema-node';

/**
 * The Visual tab for any kind without a hand-built editor, generated from the
 * kind's JSON schema: settings, sections per group or part, tables of parts.
 */
@Component({
  selector: 'app-generic-editor',
  imports: [NgComponentOutlet, TranslatePipe, SchemaNode],
  providers: [GenericEditorStore, PreviewStore],
  styleUrl: './generic.css',
  template: `
    @if (store.failed()) {
      <div class="notice error" role="alert">{{ 'ui.builder.generic.loadFailed' | t }}</div>
    } @else if (!store.root()) {
      <p class="muted">{{ 'ui.common.loading' | t }}</p>
    } @else {
      <div [class.gen-layout--preview]="!!preview()">
        <div>
          @for (s of store.sections(); track s.id) {
            <section class="gen-section" [attr.aria-labelledby]="s.id + '-title'">
              <h3 class="gen-section__title" [id]="s.id + '-title'">{{ s.label }}</h3>
              @if (s.hint) { <p class="help">{{ s.hint }}</p> }
              <div class="form-grid">
                @for (n of s.nodes; track n.id) { <app-schema-node [node]="n" [bare]="s.nodes.length === 1 && isPart(n)" /> }
              </div>
            </section>
          }
        </div>
        @if (preview(); as p) {
          <aside class="gen-layout__preview" [attr.aria-label]="'ui.builder.preview.title' | t">
            <ng-container *ngComponentOutlet="p; inputs: { value: store.draft(), body: store.draft() }" />
          </aside>
        }
      </div>
    }
  `,
})
export class GenericEditor {
  readonly store = inject(GenericEditorStore);
  readonly preview = computed(() => {
    const id = this.store.preview();
    return id ? (PREVIEWS[id] ?? null) : null;
  });

  isPart(n: FormNode): boolean {
    return n.control === 'object' || n.control === 'variant' || n.control === 'table' || n.control === 'map';
  }
}
