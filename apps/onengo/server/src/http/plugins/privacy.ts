import type { FastifyInstance } from 'fastify';
import type { PrivacyApi } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import { eraseSubjectRequest, recordConsentRequest, type EraseSubjectRequest, type RecordConsentRequest } from '@onengo/platform/contracts';

/** Consent records and erasure of data subjects. Signed-in scope only. */
export async function privacyRoutes(api: FastifyInstance, { deps }: { deps: PrivacyApi }): Promise<void> {
  /** { subjectKind, subjectId, purpose, state, source } → 201 the event (privacy:consent:record). */
  api.post<{ Body: RecordConsentRequest }>('/api/privacy/consents', { schema: { body: recordConsentRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.recordConsent.run(contextOf(req), req.body)),
  );
  /** ?subjectKind=record|member&subjectId= → { current, history, erased } (privacy:consent:read). */
  api.get<{ Querystring: { subjectKind?: string; subjectId?: string } }>('/api/privacy/consents', async (req) =>
    deps.consent.consent(contextOf(req), req.query),
  );
  /** { subjectKind, subjectId, reason? } → 201 the erasure, or 200 the earlier one when already erased (privacy:erase). */
  api.post<{ Body: EraseSubjectRequest }>('/api/privacy/erasures', { schema: { body: eraseSubjectRequest } }, async (req, reply) => {
    const { erasure, created } = await deps.eraseSubject.run(contextOf(req), req.body);
    return reply.status(created ? 201 : 200).send(erasure);
  });
}
