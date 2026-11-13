import type { RecordView } from '../models';
import type { RecordsGateway } from '../records/gateway/gateway';
import { NO_SUBJECT, type ExpressionCheck, type ExpressionSubject } from './expression-catalogue';
import type { BuilderGateway, ExpressionCheckRequest, ExpressionTry, ExpressionTryRequest } from './http-builder';

/**
 * What an expression field needs from the server: what to suggest for a
 * record type, the live check, "Try it", and real records to try on.
 */
export interface ExpressionAssist {
  /** The published record type and its workflows; nothing when it is not published. */
  subject(recordType: string | null): Promise<ExpressionSubject>;
  check(request: ExpressionCheckRequest): Promise<ExpressionCheck>;
  try(request: ExpressionTryRequest): Promise<ExpressionTry>;
  records(recordType: string, search: string): Promise<RecordView[]>;
}

type AssistBuilder = Pick<BuilderGateway, 'catalogue' | 'detail' | 'publishedRecordType' | 'checkExpression' | 'tryExpression'>;

/** Subjects are read once per assist; a Builder screen makes one assist. */
export function expressionAssist(builder: AssistBuilder, records: Pick<RecordsGateway, 'query'>): ExpressionAssist {
  const subjects = new Map<string, Promise<ExpressionSubject>>();
  let workflowTypes: Promise<Map<string, string>> | null = null;
  const workflowsOf = async (recordType: string): Promise<string[]> => {
    workflowTypes ??= builder
      .catalogue()
      .then(async (items) => {
        const keys = items.filter((i) => i.kind === 'workflow' && i.publishedVersion !== null).map((i) => i.key);
        const pairs = await Promise.all(
          keys.map((k) =>
            builder
              .detail('workflow', k)
              .then((d): [string, string] => [k, String(d.published?.body['recordType'] ?? '')])
              .catch((): [string, string] => [k, '']),
          ),
        );
        return new Map(pairs);
      })
      .catch(() => {
        workflowTypes = null;
        return new Map<string, string>();
      });
    return [...(await workflowTypes)].filter(([, t]) => t === recordType).map(([k]) => k);
  };

  return {
    subject(recordType) {
      if (!recordType) return Promise.resolve(NO_SUBJECT);
      let s = subjects.get(recordType);
      if (!s) {
        s = builder
          .publishedRecordType(recordType)
          .then((d) => d.body)
          .catch(() => null)
          .then(async (type) => ({ recordType: type, workflows: type ? await workflowsOf(recordType) : [] }));
        subjects.set(recordType, s);
      }
      return s;
    },
    check: (request) => builder.checkExpression(request),
    try: (request) => builder.tryExpression(request),
    records: (recordType, search) => records.query(recordType, { ...(search.trim() ? { search: search.trim() } : {}), limit: 8 }).then((r) => r.items),
  };
}
