// Health check for a deployed service. Used before a new version receives
// traffic, after traffic moves, and after a rollback.
//
//   node .github/scripts/smoke-test.mjs <main|console> <base-url>
//
// The only request is GET /health, expecting 200 and {"status":"ok"}.
// Browser checks run afterwards in the Playwright job.

const [service, rawBase] = process.argv.slice(2);
if (!['main', 'console'].includes(service) || !rawBase) {
  console.error('Usage: node .github/scripts/smoke-test.mjs <main|console> <base-url>');
  process.exit(2);
}
const base = rawBase.replace(/\/$/, '');

const WARM_UP_MS = 120_000; // a new App Engine version starts on its first request
const REQUEST_MS = 20_000;

async function check() {
  const res = await fetch(`${base}/health`, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status !== 200 || body?.status !== 'ok') {
    throw new Error(`status ${res.status}, body ${JSON.stringify(body)}`);
  }
}

const deadline = Date.now() + WARM_UP_MS;
for (let attempt = 1; ; attempt += 1) {
  try {
    await check();
    console.log(`PASS  GET /health on ${service} at ${base}`);
    break;
  } catch (error) {
    if (Date.now() > deadline) {
      console.error(`FAIL  GET /health on ${service} at ${base}: ${error.message}`);
      process.exit(1);
    }
    console.log(`waiting for ${base} (attempt ${attempt}): ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
