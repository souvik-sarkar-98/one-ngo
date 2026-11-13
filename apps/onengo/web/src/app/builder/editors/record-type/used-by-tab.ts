import { Component, inject } from '@angular/core';
import { kindName } from '../../../core/starters';
import { TranslatePipe } from '../../../services/i18n';
import { RecordTypeStore } from './record-type-store';

/** The published definitions that use this record type: workflows, list views, references from other record types and more. */
@Component({
  selector: 'app-record-type-used-by',
  imports: [TranslatePipe],
  styleUrl: './record-type.css',
  template: `
    @let used = store.usages();
    @if (used === null) {
      <p class="muted">{{ 'ui.common.loading' | t }}</p>
    } @else if (used.length) {
      <div class="rt-table">
        <table>
          <thead><tr><th>{{ 'ui.builder.definition' | t }}</th><th>{{ 'ui.builder.kindLabel' | t }}</th><th>{{ 'ui.builder.recordType.use' | t }}</th></tr></thead>
          <tbody>
            @for (u of used; track $index) {
              <tr>
                <td><button type="button" class="link" (click)="store.open(u)">{{ u.label || u.key }}</button></td>
                <td>{{ kind(u.kind) }}</td>
                <td>{{ u.what }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="muted">{{ 'ui.builder.recordType.notUsed' | t }}</p>
    }
  `,
})
export class UsedByTab {
  readonly store = inject(RecordTypeStore);

  kind(kind: string): string {
    return kindName(kind as Parameters<typeof kindName>[0]);
  }
}
