import type { ErrorObject } from 'ajv';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { asApplicationError, type ErrorCode, type ErrorsApi } from '@onengo/platform/main';
import { shapeIssues } from './validation.js';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 422,
  rule_violation: 422,
  definition_invalid: 422,
  script_failed: 422,
  script_limit: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
};

/**
 * An application error and the database rejections it stands for become `{ code, message, issues }`,
 * with `textKey` where the app ships wording for the refusal;
 * a body that fails its route's schema becomes 400 `bad_request` with an issue per wrong part;
 * other client errors become `bad_request`; anything else is logged and answered 500 with the request id.
 */
export function errorHandler(platform: ErrorsApi) {
  const log = platform.logger;
  return async (error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '';
    const known = asApplicationError(error);
    if (known) {
      if (path.startsWith('/api/auth/') && known.code === 'forbidden') {
        log.log('WARNING', 'Sign-in failed', { trace: req.requestId, path, ip: req.ip, reason: known.name });
      }
      return reply.status(STATUS[known.code]).send({ code: known.code, message: known.message, issues: known.issues, ...(known.textKey ? { textKey: known.textKey } : {}) });
    }
    const rejection = await platform.rejections.explain(error);
    if (rejection) {
      const { mapped } = rejection;
      log.log('WARNING', 'Database rejected the change', {
        trace: req.requestId,
        method: req.method,
        path,
        ip: req.ip,
        dbCode: rejection.code,
        constraint: rejection.constraint,
        dbMessage: rejection.message.slice(0, 300),
      });
      return reply.status(STATUS[mapped.code]).send({ code: mapped.code, message: mapped.message, issues: mapped.issues });
    }
    if (error.validation) {
      return reply.status(400).send({ code: 'bad_request', message: 'The request is not valid.', issues: shapeIssues(error.validation as ErrorObject[]) });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ code: 'bad_request', message: 'The request is not valid.' });
    }
    log.log('ERROR', 'Unhandled error', { alert: platform.alerts.httpUnhandledError, trace: req.requestId, method: req.method, path, ip: req.ip }, error);
    return reply.status(500).send({
      code: 'internal',
      message: 'Something went wrong. Try again later.',
      requestId: req.requestId,
    });
  };
}
