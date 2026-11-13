import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONNECTOR, PATHS } from './constants.js';
import { basic, bearer, escapeHtml, header, readForm, readText, redirect, sendHtml, sendJson, type Handler } from './http.js';
import type { FixtureLog } from './log.js';

const LOOKUPS: Record<string, { name: string; district: string; state: string }> = {
  '110001': { name: 'Connaught Place', district: 'New Delhi', state: 'Delhi' },
  '400001': { name: 'Fort', district: 'Mumbai', state: 'Maharashtra' },
  '560001': { name: 'Bengaluru GPO', district: 'Bengaluru Urban', state: 'Karnataka' },
  '700001': { name: 'BBD Bagh', district: 'Kolkata', state: 'West Bengal' },
};

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const token = () => randomBytes(24).toString('base64url');

/** The connector settings to save in Administration, each pointing at this fixture. */
export function connectorSettings(origin: string): Record<string, unknown> {
  return {
    sms: {
      kind: 'sms',
      enabled: true,
      config: { url: `${origin}${PATHS.sms}`, method: 'POST', headers: { Authorization: 'Bearer {{secrets.apiKey}}' }, body: '{"to":"{{to}}","message":"{{message}}"}', contentType: 'json' },
      secrets: { apiKey: CONNECTOR.smsApiKey },
    },
    whatsapp: {
      kind: 'whatsapp',
      enabled: true,
      config: { baseUrl: `${origin}${PATHS.whatsapp}`, phoneNumberId: CONNECTOR.whatsappPhoneNumberId },
      secrets: { accessToken: CONNECTOR.whatsappToken },
    },
    webhook: {
      kind: 'webhook',
      enabled: true,
      config: { url: `${origin}${PATHS.hooksIn}` },
      secrets: { signingSecret: CONNECTOR.webhookSigningSecret },
    },
    pincode: {
      kind: 'http',
      enabled: true,
      config: { mode: 'lookup', method: 'GET', url: `${origin}${PATHS.lookup}{{record.pincode}}`, inputs: ['pincode'], responseMap: { area: 'data.name', district: 'data.district' } },
    },
    demoOauth: {
      kind: 'oauth',
      enabled: true,
      config: { authorizationUrl: `${origin}${PATHS.connectorAuthorize}`, tokenUrl: `${origin}${PATHS.connectorToken}`, clientId: CONNECTOR.oauthClientId, scopes: ['demo.read'] },
      secrets: { clientSecret: CONNECTOR.oauthClientSecret },
    },
  };
}

/** Targets for SMS, WhatsApp, webhook, lookup and OAuth connectors. */
export function connectorRoutes(log: FixtureLog): Handler {
  const codes = new Map<string, { redirectUri: string; challenge: string | null; expiresAt: number }>();
  const refreshTokens = new Set<string>();

  return async (req, res) => {
    const path = req.url.pathname;

    if (req.method === 'POST' && path === PATHS.sms) {
      const body = await readText(req);
      if (bearer(req) !== CONNECTOR.smsApiKey) {
        log.add('connectors', 'SMS refused: wrong API key');
        return sendJson(res, 401, { error: 'invalid api key' });
      }
      const id = `sms_${randomBytes(6).toString('hex')}`;
      log.add('connectors', `SMS ${id}`, { contentType: header(req, 'content-type'), body: body.slice(0, 2000) });
      return sendJson(res, 200, { id, status: 'queued' });
    }

    const whatsapp = /^\/whatsapp\/(\d{5,30})\/messages$/.exec(path);
    if (req.method === 'POST' && whatsapp) {
      const body = await readText(req);
      if (bearer(req) !== CONNECTOR.whatsappToken) {
        log.add('connectors', 'WhatsApp refused: wrong access token');
        return sendJson(res, 401, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
      }
      let to = '';
      try {
        to = String((JSON.parse(body) as { to?: unknown }).to ?? '');
      } catch {
        return sendJson(res, 400, { error: { message: 'Body is not JSON.', code: 100 } });
      }
      const id = `wamid.demo${randomBytes(8).toString('hex')}`;
      log.add('connectors', `WhatsApp ${id} from ${whatsapp[1]} to ${to}`, { body: body.slice(0, 2000) });
      return sendJson(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id }] });
    }

    if (req.method === 'POST' && path === PATHS.hooksIn) {
      const body = await readText(req);
      const expected = `sha256=${createHmac('sha256', CONNECTOR.webhookSigningSecret).update(body).digest('hex')}`;
      const signature = header(req, 'x-ngo-signature') ?? '';
      const signed = sameText(signature, expected);
      log.add('connectors', `Webhook ${header(req, 'x-ngo-event') ?? '(no event)'}: signature ${signed ? 'matches' : 'does not match'}`, { body: body.slice(0, 2000) });
      return signed ? sendJson(res, 200, { ok: true }) : sendJson(res, 401, { ok: false, error: 'signature does not match' });
    }

    if (req.method === 'GET' && path.startsWith(PATHS.lookup)) {
      const code = decodeURIComponent(path.slice(PATHS.lookup.length));
      const found = LOOKUPS[code];
      log.add('connectors', `Lookup ${code}: ${found ? 'found' : 'not found'}`);
      return found ? sendJson(res, 200, { data: { code, ...found } }) : sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && path === PATHS.connectorAuthorize) {
      const p = req.url.searchParams;
      if (p.get('client_id') !== CONNECTOR.oauthClientId || p.get('response_type') !== 'code' || !p.get('redirect_uri') || !p.get('state')) {
        return sendHtml(res, 400, '<p>Unknown client or missing redirect_uri/state.</p>');
      }
      log.add('connectors', 'OAuth consent page shown');
      return sendHtml(
        res,
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo consent</title></head>
<body style="font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto"><h1>Allow access?</h1>
<p>one-ngo asks for <code>${escapeHtml(p.get('scope') ?? '')}</code>.</p>
<form method="post" action="${PATHS.connectorAuthorize}">
${[...p].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n')}
<button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form></body></html>`,
      );
    }
    if (req.method === 'POST' && path === PATHS.connectorAuthorize) {
      const form = await readForm(req);
      let back: URL;
      try {
        back = new URL(form.get('redirect_uri') ?? '');
      } catch {
        return sendHtml(res, 400, '<p>redirect_uri is not an address.</p>');
      }
      back.searchParams.set('state', form.get('state') ?? '');
      if (form.get('decision') !== 'allow') {
        back.searchParams.set('error', 'access_denied');
        log.add('connectors', 'OAuth consent denied');
        return redirect(res, back.toString());
      }
      const code = token();
      codes.set(code, { redirectUri: back.origin + back.pathname, challenge: form.get('code_challenge'), expiresAt: Date.now() + 5 * 60_000 });
      back.searchParams.set('code', code);
      log.add('connectors', 'OAuth code issued');
      return redirect(res, back.toString());
    }
    if (req.method === 'POST' && path === PATHS.connectorToken) {
      const form = await readForm(req);
      const creds = basic(req);
      const clientId = creds?.user ?? form.get('client_id') ?? '';
      const clientSecret = creds?.password ?? form.get('client_secret') ?? '';
      if (!sameText(clientId, CONNECTOR.oauthClientId) || !sameText(clientSecret, CONNECTOR.oauthClientSecret)) {
        log.add('connectors', 'OAuth token refused: wrong client id or secret');
        return sendJson(res, 401, { error: 'invalid_client' });
      }
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const code = form.get('code') ?? '';
        const pending = codes.get(code);
        codes.delete(code);
        if (!pending || pending.expiresAt < Date.now() || pending.redirectUri !== form.get('redirect_uri')) return sendJson(res, 400, { error: 'invalid_grant' });
        if (pending.challenge && s256(form.get('code_verifier') ?? '') !== pending.challenge) return sendJson(res, 400, { error: 'invalid_grant' });
        const refresh = token();
        refreshTokens.add(refresh);
        log.add('connectors', 'OAuth tokens issued');
        return sendJson(res, 200, { access_token: token(), refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 });
      }
      if (grant === 'refresh_token') {
        if (!refreshTokens.has(form.get('refresh_token') ?? '')) {
          log.add('connectors', 'OAuth refresh refused: unknown refresh token');
          return sendJson(res, 400, { error: 'invalid_grant' });
        }
        log.add('connectors', 'OAuth access token refreshed');
        return sendJson(res, 200, { access_token: token(), token_type: 'Bearer', expires_in: 3600 });
      }
      return sendJson(res, 400, { error: 'unsupported_grant_type' });
    }
    return false;
  };
}
