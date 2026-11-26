// Smoke test for a deployed service. Used before a new version receives
// traffic, and again after traffic moves.
//
//   node .github/scripts/smoke-test.mjs <main|console> <base-url>
//
// Every check must pass, within the warm-up window:
//   main     GET /health          200 and {"status":"ok"}       the process is up
//            GET /ready           200 and {"status":"ready"}    the database answers
//            GET /sign-in         200 and the web app shell      the web bundle is served
//   console  GET /health          200 and {"status":"ok"}       the process is up
//
// The console is behind Identity-Aware Proxy apart from /health, so nothing
// else can be requested without a sign-in. Browser checks are a separate,
// manual workflow (e2e-test.yml).

const [service, rawBase] = process.argv.slice(2);
if (!['main', 'console'].includes(service) || !rawBase) {
  console.error('Usage: node .github/scripts/smoke-test.mjs <main|console> <base-url>');
  process.exit(2);
}
const base = rawBase.replace(/\/$/, '');

const WARM_UP_MS = 120_000; // a new App Engine version starts on its first request
const REQUEST_MS = 20_000;

async function get(path) {
  return fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
}

async function expectJson(path, status) {
  const res = await get(path);
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status !== 200 || body?.status !== status) {
    throw new Error(`GET ${path}: status ${res.status}, body ${JSON.stringify(body)}`);
  }
}

async function expectAppShell(path) {
  const res = await get(path);
  const text = await res.text();
  if (res.status !== 200 || !text.includes('<app-root')) {
    throw new Error(`GET ${path}: status ${res.status}, no web app shell in the response`);
  }
}

const checks = {
  main: [() => expectJson('/health', 'ok'), () => expectJson('/ready', 'ready'), () => expectAppShell('/sign-in')],
  console: [() => expectJson('/health', 'ok')],
}[service];

const deadline = Date.now() + WARM_UP_MS;
for (let attempt = 1; ; attempt += 1) {
  try {
    for (const check of checks) await check();
    console.log(`PASS  ${checks.length} check(s) on ${service} at ${base}`);
    break;
  } catch (error) {
    if (Date.now() > deadline) {
      console.error(`FAIL  ${service} at ${base}: ${error.message}`);
      process.exit(1);
    }
    console.log(`waiting for ${base} (attempt ${attempt}): ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
