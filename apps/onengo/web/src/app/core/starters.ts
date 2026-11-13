import { t } from './i18n/i18n';
import type { DefinitionKind } from './models';

/** Starting bodies for new definitions in the builder. */
export function starterBody(kind: DefinitionKind, key: string, recordType = ''): Record<string, unknown> {
  switch (kind) {
    case 'recordType':
      return { key, label: '', fields: [{ key: 'name', label: t('ui.builder.starter.name'), type: 'text', required: true }], titleField: 'name' };
    case 'workflow':
      return {
        key,
        recordType: recordType || key,
        initial: 'open',
        states: [
          { key: 'open', label: t('ui.builder.starter.open') },
          { key: 'closed', label: t('ui.builder.starter.closed'), final: true },
        ],
        transitions: [{ key: 'close', label: t('ui.builder.starter.close'), from: ['open'], to: 'closed' }],
      };
    case 'automation':
      return { key, recordType, trigger: { event: 'created' }, actions: [{ type: 'notify', template: '', to: { creator: true }, channels: ['inApp'] }] };
    case 'template':
      return { key, subject: t('ui.builder.starter.subject'), body: t('ui.builder.starter.body') };
    case 'postingRule':
      return {
        key,
        recordType,
        whenStatus: '',
        date: 'today()',
        lines: [
          { side: 'debit', account: 'BANK', amount: 'record.amount' },
          { side: 'credit', account: '', amount: 'record.amount' },
        ],
      };
    case 'receiptRule':
      return { key, recordType, whenStatus: '', series: '', amount: 'record.amount', date: 'today()' };
    case 'script':
      return { key, recordType, hook: 'beforeSave', code: "// ctx.record, ctx.previous, ctx.status, ctx.user\n// ctx.fail('message') stops the save\n" };
    case 'theme':
      return { key, label: t('ui.builder.starter.theme'), brand: '#1f5f8b', brandForeground: '#ffffff', background: '#f5f7fa', surface: '#ffffff', text: '#1d2733', radius: '6px' };
    case 'listView':
      return { key, recordType };
    case 'recordGroup':
      return { key, label: '', recordTypes: recordType ? [recordType] : [] };
    case 'translation':
      return { key, locale: /^[a-z]{2}$/.test(key) ? key : 'hi', entries: {} };
    case 'action':
      return { key, recordType, label: '', placement: ['panel'], steps: [{ type: 'setFields', values: {} }] };
    case 'page':
      return { key, label: '', widgets: [{ type: 'groups' }] };
    case 'report':
      return {
        key,
        label: 'Sample',
        datasets: [{ key: 'rows', source: 'query', recordType: recordType || 'donation', fields: ['amount'] }],
        outputs: { excel: { sheets: [{ dataset: 'rows' }] } },
      };
    case 'reportGroup':
      return { key, label: '', reports: ['sample'] };
    case 'dataFeed':
      return { key, label: '', source: 'content', entries: [{ key: 'note', label: 'Note', text: '' }] };
  }
}

/** One definition of a kind, e.g. "Record type". */
export const kindName = (kind: DefinitionKind): string => t(`ui.builder.kind.${kind}`);
