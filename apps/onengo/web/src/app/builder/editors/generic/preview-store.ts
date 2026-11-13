import { Injectable, inject } from '@angular/core';
import { httpPreviews, type PostingTry, type ScriptTry, type TemplatePreview } from '../../../core/builder/http-previews';
import type { GroupBody } from '../../../core/builder/record-groups';
import { t } from '../../../core/i18n/i18n';
import type { RecordView } from '../../../core/models';
import { asGatewayError, type GatewayError } from '../../../core/records/gateway/gateway';
import { listSource, type SuggestionSource } from '../../../core/ui-logic/autocomplete';
import { Api } from '../../../services/api';
import { BuilderStore } from '../../builder-store';

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: GatewayError };

const outcome = async <T>(run: () => Promise<T>, fallback: string): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    return { ok: false, error: asGatewayError(e, fallback) };
  }
};

/** What the previews of the generic editor load and try: records to fill them from, record types and their fields, groups. */
@Injectable()
export class PreviewStore {
  private readonly builder = inject(BuilderStore);
  private readonly previews = httpPreviews(inject(Api));
  private readonly recordSources = new Map<string, SuggestionSource>();

  readonly recordTypeSource: SuggestionSource = {
    minLength: 0,
    search: async (text) => listSource(await this.recordTypes()).search(text),
  };

  async recordTypes(): Promise<{ id: string; label: string; hint: string }[]> {
    const items = await this.builder.gateway.catalogue();
    return items.filter((i) => i.kind === 'recordType' && i.publishedVersion !== null).map((i) => ({ id: i.key, label: i.label || i.key, hint: i.key }));
  }

  /** Records of a published record type, by number or title. */
  recordSource(recordType: string): SuggestionSource {
    let s = this.recordSources.get(recordType);
    if (!s) {
      s = {
        minLength: 0,
        search: async (text) => {
          const [subject, records] = await Promise.all([this.builder.expressions.subject(recordType), this.builder.expressions.records(recordType, text)]);
          const title = subject.recordType?.titleField;
          return records.map((r: RecordView) => {
            const name = title && r.data[title] !== undefined && r.data[title] !== null ? String(r.data[title]) : '';
            return { id: r.id, label: r.number ?? (name || r.id), hint: r.number ? name : '' };
          });
        },
      };
      this.recordSources.set(recordType, s);
    }
    return s;
  }

  /** The fields of a published record type, for placeholders. */
  async fields(recordType: string): Promise<{ key: string; label: string }[]> {
    const subject = await this.builder.expressions.subject(recordType);
    return (subject.recordType?.fields ?? []).map((f) => ({ key: f.key, label: f.label || f.key }));
  }

  previewTemplate(request: Parameters<typeof this.previews.previewTemplate>[0]): Promise<Outcome<TemplatePreview>> {
    return outcome(() => this.previews.previewTemplate(request), t('ui.builder.preview.failed'));
  }

  testTemplate(request: Parameters<typeof this.previews.testTemplate>[0]): Promise<Outcome<TemplatePreview & { sentTo: string }>> {
    return outcome(() => this.previews.testTemplate(request), t('ui.builder.preview.failed'));
  }

  tryScript(request: Parameters<typeof this.previews.tryScript>[0]): Promise<Outcome<ScriptTry>> {
    return outcome(() => this.previews.tryScript(request), t('ui.builder.preview.failed'));
  }

  tryPostingRule(request: Parameters<typeof this.previews.tryPostingRule>[0]): Promise<Outcome<PostingTry>> {
    return outcome(() => this.previews.tryPostingRule(request), t('ui.builder.preview.failed'));
  }

  /** The other published record groups and every published record type. */
  async recordGroups(): Promise<{ groups: GroupBody[]; types: { key: string; label: string }[] }> {
    const items = await this.builder.gateway.catalogue();
    const keys = items.filter((i) => i.kind === 'recordGroup' && i.publishedVersion !== null).map((i) => i.key);
    const groups = await Promise.all(
      keys.map((k) =>
        this.builder.gateway
          .detail('recordGroup', k)
          .then((d) => (d.published?.body as unknown as GroupBody | undefined) ?? null)
          .catch(() => null),
      ),
    );
    const types = items.filter((i) => i.kind === 'recordType' && i.publishedVersion !== null).map((i) => ({ key: i.key, label: i.label || i.key }));
    return { groups: groups.filter((g): g is GroupBody => !!g), types };
  }
}
