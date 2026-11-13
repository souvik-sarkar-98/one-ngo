import { Component, input, output } from '@angular/core';
import type { DiagramLayout, PlacedEdge } from '../core/builder/diagram';
import { t } from '../core/i18n/i18n';
import { withDefaults } from './labels';

const LABELS = () => ({ title: t('ui.diagram.title') });
const CHARS = 20;
let nextId = 0;

const clip = (text: string, max = CHARS) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A read-only picture of boxes and arrows laid out by `core/builder/diagram`:
 * plain SVG, scrolled sideways when wider than the screen. Choosing a box or
 * an arrow's label reports its id; the screen decides what that opens.
 */
@Component({
  selector: 'app-diagram',
  styleUrl: './styles/diagram.css',
  template: `
    @let l = layout();
    <div class="diagram">
      <svg
        class="diagram__svg"
        role="group"
        [attr.aria-label]="labels().title"
        [attr.viewBox]="'0 0 ' + l.width + ' ' + l.height"
        [attr.width]="l.width"
        [attr.height]="l.height">
        <defs>
          <marker [id]="marker" class="diagram__marker" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
          <marker [id]="marker + '-accent'" class="diagram__marker diagram__marker--accent" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        @for (e of l.edges; track e.id) {
          <path
            class="diagram__edge"
            [class.diagram__edge--accent]="e.tone === 'accent'"
            [class.diagram__edge--selected]="isSelected(e)"
            [attr.d]="e.path"
            [attr.marker-end]="'url(#' + marker + (e.tone === 'accent' ? '-accent' : '') + ')'" />
        }
        @for (n of l.nodes; track n.id) {
          <g
            class="diagram__node"
            [class.diagram__node--start]="n.tone === 'start'"
            [class.diagram__node--final]="n.tone === 'final'"
            [class.diagram__node--unreachable]="!n.reachable"
            [class.diagram__node--selected]="n.id === selected()"
            role="button"
            tabindex="0"
            [attr.aria-label]="n.label + (n.note ? ', ' + n.note : '')"
            (click)="nodeSelect.emit(n.id)"
            (keydown.enter)="nodeSelect.emit(n.id)"
            (keydown.space)="$event.preventDefault(); nodeSelect.emit(n.id)">
            <rect [attr.x]="n.x" [attr.y]="n.y" [attr.width]="n.width" [attr.height]="n.height" rx="8" />
            <text class="diagram__label" [attr.x]="n.x + n.width / 2" [attr.y]="n.y + (n.note ? n.height / 2 - 3 : n.height / 2 + 4)">{{ clip(n.label) }}</text>
            @if (n.note) {
              <text class="diagram__note" [attr.x]="n.x + n.width / 2" [attr.y]="n.y + n.height / 2 + 13">{{ clip(n.note, 26) }}</text>
            }
          </g>
        }
        @for (e of l.edges; track e.id) {
          <g
            class="diagram__tag"
            [class.diagram__tag--accent]="e.tone === 'accent'"
            [class.diagram__tag--selected]="isSelected(e)"
            role="button"
            tabindex="0"
            [attr.aria-label]="e.label"
            (click)="edgeSelect.emit(e.id)"
            (keydown.enter)="edgeSelect.emit(e.id)"
            (keydown.space)="$event.preventDefault(); edgeSelect.emit(e.id)">
            <rect [attr.x]="e.labelX - tagWidth(e) / 2" [attr.y]="e.labelY - 10" [attr.width]="tagWidth(e)" height="20" rx="10" />
            <text [attr.x]="e.labelX" [attr.y]="e.labelY + 4">{{ clip(e.label, 28) }}</text>
          </g>
        }
      </svg>
    </div>
  `,
})
export class Diagram {
  readonly layout = input.required<DiagramLayout>();
  /** The node to highlight. */
  readonly selected = input<string | null>(null);
  /** Highlights every edge whose id starts with this, such as all arrows of one step. */
  readonly selectedEdge = input<string | null>(null);
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly nodeSelect = output<string>();
  readonly edgeSelect = output<string>();

  readonly marker = `app-diagram-${nextId++}-arrow`;
  readonly clip = clip;

  isSelected(e: PlacedEdge): boolean {
    const p = this.selectedEdge();
    return !!p && (e.id === p || e.id.startsWith(`${p}\u0000`));
  }

  tagWidth(e: PlacedEdge): number {
    return clip(e.label, 28).length * 6.4 + 16;
  }
}
