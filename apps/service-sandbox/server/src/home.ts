import { CASHFREE, CONNECTOR, GOOGLE, RAZORPAY, SMTP } from './constants.js';
import { escapeHtml } from './http.js';
import type { LogEntry } from './log.js';
import type { StoredOrder } from './payments.js';
import type { MailMessage } from './smtp.js';

export interface HomeView {
  origin: string;
  smtpHost: string;
  smtpPort: number;
  caPath: string;
  filesDir: string;
  oneNgoBaseUrl: string;
  fileStoreBucket: string | undefined;
  fileStorePrefix: string | undefined;
  defaultOrg: string;
  connectors: Record<string, unknown>;
  orders: StoredOrder[];
  messages: MailMessage[];
  log: readonly LogEntry[];
}

/** The lines to paste into one-ngo's .env. File settings keep their existing values. */
export function envBlock(v: Pick<HomeView, 'origin' | 'smtpHost' | 'smtpPort' | 'caPath' | 'fileStoreBucket' | 'fileStorePrefix'>): string {
  return [
    '# Trust the fixture certificate (one-ngo reads this at process start).',
    `NODE_EXTRA_CA_CERTS=${v.caPath}`,
    '',
    `OIDC_ISSUER=${v.origin}`,
    `OIDC_CLIENT_ID=${GOOGLE.clientId}`,
    `OIDC_CLIENT_SECRET=${GOOGLE.clientSecret}`,
    'OIDC_PROVIDER_ID=google',
    'OIDC_PROVIDER_LABEL=Google',
    '',
    `RAZORPAY_API_BASE=${v.origin}`,
    `CASHFREE_API_BASE=${v.origin}`,
    '',
    `SMTP_HOST=${v.smtpHost}`,
    `SMTP_PORT=${v.smtpPort}`,
    'SMTP_SECURE=0',
    `SMTP_USER=${SMTP.user}`,
    `SMTP_PASSWORD=${SMTP.password}`,
    `SMTP_FROM=${SMTP.from}`,
    '',
    'CONNECTOR_ALLOWED_HOSTS=127.0.0.1',
    'BREACHED_PASSWORD_CHECK=online',
    '',
    '# Unchanged: one-ngo always sends Cloud Storage calls to this fixture.',
    v.fileStoreBucket ? `FILE_STORE_BUCKET=${v.fileStoreBucket}` : '# FILE_STORE_BUCKET=<keep your value; set one to store files here>',
    v.fileStorePrefix !== undefined ? `FILE_STORE_PREFIX=${v.fileStorePrefix}` : '# FILE_STORE_PREFIX=<keep your value>',
  ].join('\n');
}

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

export function homePage(v: HomeView): string {
  const orders = v.orders.length
    ? `<table><tr><th>Provider</th><th>Order</th><th>Amount</th><th>Reference</th><th>Status</th><th></th></tr>${v.orders
        .map(
          (o) => `<tr><td>${o.provider}</td><td><code>${escapeHtml(o.orderId)}</code></td><td>${rupees(o.amountPaise)}</td><td>${escapeHtml(o.reference)}</td><td>${o.status}</td>
<td><form method="post" class="row"><input name="org" value="${escapeHtml(v.defaultOrg)}" size="10" aria-label="Organisation code" required>
<button formaction="/orders/${o.provider}/${encodeURIComponent(o.orderId)}/capture">Capture</button>
<button formaction="/orders/${o.provider}/${encodeURIComponent(o.orderId)}/fail">Fail</button></form></td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No orders yet. Request a payment in one-ngo with the demo gateway keys saved.</p>';
  const messages = v.messages.length
    ? `<ul>${v.messages.map((m) => `<li><a href="/mail/${m.id}">${escapeHtml(m.subject || '(no subject)')}</a> to ${escapeHtml(m.to.join(', '))} <span class="muted">${m.at}</span></li>`).join('')}</ul>`
    : '<p class="muted">No messages yet.</p>';
  const log = [...v.log]
    .reverse()
    .map(
      (e) => `<tr><td class="muted">${e.at.slice(11, 19)}</td><td>${e.area}</td><td>${escapeHtml(e.summary)}${
        e.detail === undefined ? '' : `<details><summary>detail</summary><pre>${escapeHtml(JSON.stringify(e.detail, null, 2))}</pre></details>`
      }</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>one-ngo integration fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:15px system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#222}
h1{margin-bottom:.2rem}h2{margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}
pre{background:#f5f5f5;padding:.75rem;overflow:auto;font-size:13px}code{font-size:13px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:.35rem;text-align:left;vertical-align:top}
.muted{color:#777}.row{display:flex;gap:.3rem}.warn{background:#fff6dd;padding:.5rem .75rem;border-left:4px solid #e0b000}
</style></head><body>
<h1>one-ngo integration fixture</h1>
<p class="muted">Test use only. HTTPS on <code>${escapeHtml(v.origin)}</code>, SMTP on <code>${escapeHtml(v.smtpHost)}:${v.smtpPort}</code>. Webhooks go to <code>${escapeHtml(v.oneNgoBaseUrl)}</code>. Files are kept in <code>${escapeHtml(v.filesDir)}</code>.</p>
<p class="warn">one-ngo always sends Cloud Storage, metadata token and breached-password calls here. Payment and Google calls come here only after you paste the settings below into <code>.env</code> and restart one-ngo.</p>

<h2>Settings for one-ngo's .env</h2>
<pre>${escapeHtml(envBlock(v))}</pre>

<h2>Credentials to save on the organisation</h2>
<table>
<tr><th>Razorpay</th><td>key id <code>${RAZORPAY.keyId}</code>, key secret <code>${RAZORPAY.keySecret}</code>, webhook secret <code>${RAZORPAY.webhookSecret}</code></td></tr>
<tr><th>Cashfree</th><td>client id <code>${CASHFREE.clientId}</code>, client secret <code>${CASHFREE.clientSecret}</code>, environment <code>${CASHFREE.environment}</code></td></tr>
<tr><th>Google</th><td>client id <code>${GOOGLE.clientId}</code>, secret <code>${GOOGLE.clientSecret}</code> (installation settings above)</td></tr>
<tr><th>SMTP</th><td>user <code>${SMTP.user}</code>, password <code>${SMTP.password}</code>, from <code>${SMTP.from}</code></td></tr>
<tr><th>Breached password</th><td><code>password</code> is reported as breached; anything else is not.</td></tr>
</table>

<h2>Connectors to save (Administration → Connectors)</h2>
<p class="muted">Each key below is a connector key. <code>CONNECTOR_ALLOWED_HOSTS</code> must include <code>127.0.0.1</code>. The webhook connector's signing secret is <code>${CONNECTOR.webhookSigningSecret}</code>.</p>
<pre>${escapeHtml(JSON.stringify(v.connectors, null, 2))}</pre>

<h2>Orders</h2>
${orders}

<h2>Email</h2>
${messages}

<h2>Log</h2>
<p><a href="/">Refresh</a> · <a href="/api/log">JSON</a></p>
<table><tr><th>Time</th><th>Area</th><th>What happened</th></tr>${log || '<tr><td colspan="3" class="muted">Nothing yet.</td></tr>'}</table>
</body></html>`;
}
