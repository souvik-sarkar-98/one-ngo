import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { display, parse, tableRows, type FormNode, type LeafNode, type MapNode, type TableNode, type VariantNode } from '../../../core/builder/schema-form';
import { TranslatePipe } from '../../../services/i18n';
import { Autocomplete } from '../../../ui/autocomplete';
import { EditableTable } from '../../../ui/editable-table';
import { PermissionField } from '../../../ui/permission-field';
import { ExpressionInput } from './expression-input';
import { GenericEditorStore } from './generic-store';
import { HtmlEditor } from './html-editor';
import { PREVIEWS } from './previews';

const WIDE = new Set(['object', 'variant', 'table', 'map', 'json', 'pills', 'textarea', 'code', 'html', 'expression']);
const HEX = /^#[0-9a-f]{6}$/i;

/** One part of a definition drawn from its schema: a setting, an object of settings, a table of parts, or name–value entries. */
@Component({
  selector: 'app-schema-node',
  imports: [NgComponentOutlet, TranslatePipe, Autocomplete, EditableTable, PermissionField, ExpressionInput, HtmlEditor],
  host: { '[class.wide]': 'wide()' },
  styleUrl: './schema-node.css',
  template: `
    @let n = node();
    @switch (n.control) {
      @case ('text') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <input [id]="n.id" [value]="text()" [readOnly]="!!leaf().readOnly" (input)="enter($any($event.target).value)" />
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('textarea') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <textarea class="gen-long" [id]="n.id" [value]="text()" (focus)="store.focusMessage(n.path)" (input)="enter($any($event.target).value)"></textarea>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('html') {
        <app-html-editor [fieldId]="n.id" [label]="n.label" [hint]="n.hint" (focused)="store.focusMessage(n.path)" [value]="text()" (valueChange)="enter($event)" />
      }
      @case ('code') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <textarea class="code" spellcheck="false" [id]="n.id" [value]="text()" [attr.aria-describedby]="n.id + '-keys'" (focus)="store.focusMessage(n.path)" (keydown)="codeKey($event)" (input)="enter($any($event.target).value)"></textarea>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
          <div class="help" [id]="n.id + '-keys'">{{ 'ui.builder.generic.codeKeys' | t }}</div>
        </div>
      }
      @case ('colour') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <span class="gen-colour">
            <input type="color" [value]="colour()" [attr.aria-label]="n.label" (input)="enter($any($event.target).value)" />
            <input [id]="n.id" [value]="text()" spellcheck="false" (change)="enter($any($event.target).value.trim())" />
          </span>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('number') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <input type="number" [id]="n.id" [value]="text()" [attr.step]="leaf().integer ? 1 : null" (change)="enter($any($event.target).value)" />
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
          @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
        </div>
      }
      @case ('switch') {
        <div class="field">
          <label class="gen-switch"><input type="checkbox" role="switch" [id]="n.id" [checked]="on()" (change)="enter($any($event.target).checked)" /> {{ n.label }}</label>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('select') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <select [id]="n.id" (change)="enter($any($event.target).value)">
            @if (!n.required) { <option value="" [selected]="text() === ''">—</option> }
            @for (o of leaf().options; track o.value) { <option [value]="o.value" [selected]="o.value === text()">{{ o.label }}</option> }
          </select>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('expression') {
        <div class="field">
          <app-expression-input [fieldId]="n.id" [label]="n.label" [hint]="n.hint" [value]="text()" [recordType]="leaf().recordType ?? ''" (valueChange)="enter($event)" />
        </div>
      }
      @case ('ref') {
        <div class="field">
          <app-autocomplete [label]="n.label" [text]="text()" [source]="store.source(leaf().ref!)" (typed)="enter($event)" (chosen)="enter($event.id)" />
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('permission') {
        <div class="field">
          <app-permission-field [label]="n.label" [hint]="n.hint" [value]="text()" [source]="store.permissionSource" (valueChange)="enter($event)" />
        </div>
      }
      @case ('choices') {
        <div class="field">
          <span class="gen-label" [id]="n.id">{{ n.label }}</span>
          <div class="gen-pills" role="group" [attr.aria-labelledby]="n.id">
            @for (o of leaf().options; track o.value) {
              <button type="button" class="gen-pill" [class.gen-pill--on]="list().includes(o.value)" [attr.aria-pressed]="list().includes(o.value)" (click)="toggle(o.value)">{{ o.label }}</button>
            }
          </div>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('pills') {
        <div class="field">
          <span class="gen-label" [id]="n.id">{{ n.label }}</span>
          <div class="gen-pills" role="group" [attr.aria-labelledby]="n.id">
            @for (p of list(); track $index; let i = $index) {
              <span class="gen-pill gen-pill--on">{{ p }}<button type="button" class="gen-pill__remove" [attr.aria-label]="('ui.common.remove' | t) + ': ' + p" (click)="removePill(i)">✕</button></span>
            }
            <span class="gen-pills__add" (keydown.enter)="addDraft($event)">
              @for (k of [adds()]; track k) {
                @if (leaf().ref) {
                  <app-autocomplete [text]="draft()" [source]="store.source(leaf().ref!)" [placeholder]="'ui.builder.generic.addValue' | t" (typed)="draft.set($event)" (chosen)="addPill($event.id)" />
                } @else {
                  <input [value]="draft()" [placeholder]="'ui.builder.generic.addValue' | t" [attr.aria-label]="n.label" (input)="draft.set($any($event.target).value)" />
                }
              }
              <button type="button" class="small" [disabled]="!draft().trim()" (click)="addPill(draft())">{{ 'ui.common.add' | t }}</button>
            </span>
          </div>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
        </div>
      }
      @case ('json') {
        <div class="field">
          <label [for]="n.id">{{ n.label }}</label>
          <textarea class="gen-json" spellcheck="false" [id]="n.id" [value]="text()" (change)="enter($any($event.target).value)"></textarea>
          @if (n.hint) { <div class="help">{{ n.hint }}</div> }
          @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
        </div>
      }
      @case ('table') {
        <div class="gen-part">
          @if (!bare()) {
            <h4 class="gen-part__title">{{ n.label }}</h4>
            @if (n.hint) { <p class="help">{{ n.hint }}</p> }
          }
          <app-editable-table
            [rows]="rows()"
            [columns]="columns()"
            [selectedId]="selectedId()"
            (rowSelect)="selectRow($event)"
            (moved)="store.moveItem(table(), $event.from, $event.to)"
            (add)="store.addItem(table())"
            (remove)="store.removeItem(table(), +$event)">
            @if (selectedItem(); as item) {
              <div rowPanel class="gen-row-panel"><app-schema-node [node]="item" [bare]="true" /></div>
            }
          </app-editable-table>
        </div>
      }
      @case ('map') {
        <div class="gen-part">
          @if (!bare()) {
            <h4 class="gen-part__title">{{ n.label }}</h4>
            @if (n.hint) { <p class="help">{{ n.hint }}</p> }
          }
          @for (e of map().entries; track $index) {
            <div class="gen-entry">
              <div class="field">
                <label [for]="e.id + '-name'">{{ 'ui.builder.generic.entryName' | t }}</label>
                <input [id]="e.id + '-name'" [value]="e.name" (change)="store.renameEntry(map(), e.name, $any($event.target).value.trim())" />
              </div>
              @if (e.control === 'expression') {
                <div class="field">
                  <app-expression-input [fieldId]="e.id" [label]="'ui.builder.generic.entryValue' | t" [value]="$any(e.value) ?? ''" [recordType]="e.recordType ?? ''" (valueChange)="store.set(e.path, $event)" />
                </div>
              } @else {
                <div class="field">
                  <label [for]="e.id">{{ 'ui.builder.generic.entryValue' | t }}</label>
                  <input [id]="e.id" [value]="$any(e.value) ?? ''" (input)="store.set(e.path, $any($event.target).value)" />
                </div>
              }
              <button type="button" class="small danger gen-entry__remove" [attr.aria-label]="('ui.common.remove' | t) + ': ' + e.name" (click)="store.set(e.path, undefined)">✕</button>
            </div>
          }
          <button type="button" class="small" (click)="store.addEntry(map())">{{ 'ui.builder.generic.addEntry' | t }}</button>
        </div>
      }
      @case ('fixed') {}
      @default {
        @if (n.value === undefined) {
          <div class="field">
            <button type="button" class="small" (click)="store.addPart(n)">{{ 'ui.builder.generic.addPart' | t: { name: n.label } }}</button>
            @if (n.hint && !bare()) { <div class="help">{{ n.hint }}</div> }
          </div>
        } @else {
          <div [class.gen-part]="!bare()">
            @if (!bare()) {
              <div class="gen-part__head">
                <h4 class="gen-part__title">{{ n.label }}</h4>
                @if (!n.required) {
                  <button type="button" class="small" (click)="store.set(n.path, undefined)">{{ 'ui.builder.generic.removePart' | t: { name: n.label } }}</button>
                }
              </div>
              @if (n.hint) { <p class="help">{{ n.hint }}</p> }
            } @else if (!n.required) {
              <div class="gen-part__head gen-part__head--end">
                <button type="button" class="small" (click)="store.set(n.path, undefined)">{{ 'ui.builder.generic.removePart' | t: { name: n.label } }}</button>
              </div>
            }
            @if (n.control === 'variant') {
              <div class="field">
                <label [for]="n.id + '-kind'">{{ 'ui.builder.generic.kind' | t }}</label>
                <select [id]="n.id + '-kind'" (change)="store.switchVariant(variant(), +$any($event.target).value)">
                  @for (o of variant().variants; track o.value) { <option [value]="o.value" [selected]="+o.value === variant().active">{{ o.label }}</option> }
                </select>
              </div>
            }
            <div class="form-grid">
              @for (c of children(); track c.id) { <app-schema-node [node]="c" /> }
            </div>
          </div>
        }
      }
    }
    @if (preview(); as p) {
      <ng-container *ngComponentOutlet="p; inputs: { value: n.value, body: store.draft() }" />
    }
  `,
})
export class SchemaNode {
  readonly store = inject(GenericEditorStore);
  readonly node = input.required<FormNode>();
  /** Drawn without its own heading, inside a section or a row panel that already names it. */
  readonly bare = input(false);
  readonly error = signal('');
  readonly draft = signal('');
  readonly adds = signal(0);

  readonly leaf = computed(() => this.node() as LeafNode);
  readonly table = computed(() => this.node() as TableNode);
  readonly variant = computed(() => this.node() as VariantNode);
  readonly map = computed(() => this.node() as MapNode);
  readonly wide = computed(() => WIDE.has(this.node().control));
  readonly text = computed(() => String(display(this.leaf())));
  readonly on = computed(() => display(this.leaf()) === true);
  /** The picker needs a full `#rrggbb`; it shows black until one is set. */
  readonly colour = computed(() => (HEX.test(this.text()) ? this.text().toLowerCase() : '#000000'));
  private tabLeaves = false;
  readonly list = computed(() => {
    const d = display(this.leaf());
    return Array.isArray(d) ? d : [];
  });
  readonly children = computed(() => {
    const n = this.node();
    return n.control === 'object' || n.control === 'variant' ? n.children.filter((c) => c.control !== 'fixed') : [];
  });
  readonly rows = computed(() => {
    const n = this.node();
    return n.control === 'table' ? tableRows(n) : [];
  });
  readonly columns = computed(() => {
    const n = this.node();
    return n.control === 'table' ? n.columns.map((c) => ({ key: c.value, label: c.label })) : [];
  });
  readonly selectedId = computed(() => {
    const i = this.store.selected()[this.node().id];
    return i === undefined || i === null ? null : String(i);
  });
  readonly selectedItem = computed(() => {
    const n = this.node();
    const i = this.store.selected()[n.id];
    return n.control === 'table' && i !== undefined && i !== null ? (n.items[i] ?? null) : null;
  });
  readonly preview = computed(() => {
    const id = this.node().preview;
    return id ? (PREVIEWS[id] ?? null) : null;
  });

  enter(input: string | boolean | string[]): void {
    const r = parse(this.leaf(), input);
    if (!r.ok) {
      this.error.set(r.error);
      return;
    }
    this.error.set('');
    this.store.set(this.node().path, r.value);
  }

  /** Tab indents by two spaces; after Escape, Tab moves on as usual so keyboard users are not trapped. */
  codeKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.tabLeaves = true;
      return;
    }
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || this.tabLeaves) {
      this.tabLeaves = false;
      return;
    }
    e.preventDefault();
    const box = e.target as HTMLTextAreaElement;
    box.setRangeText('  ', box.selectionStart, box.selectionEnd, 'end');
    this.enter(box.value);
  }

  toggle(value: string): void {
    const list = this.list();
    this.enter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  addPill(text: string): void {
    const value = text.trim();
    if (!value) return;
    if (!this.list().includes(value)) this.enter([...this.list(), value]);
    this.draft.set('');
    this.adds.update((n) => n + 1);
  }

  addDraft(e: Event): void {
    if (e.defaultPrevented) return;
    e.preventDefault();
    this.addPill(this.draft());
  }

  removePill(index: number): void {
    this.enter(this.list().filter((_, i) => i !== index));
  }

  selectRow(id: string | null): void {
    this.store.select(this.table(), id === null ? null : Number(id));
  }
}
