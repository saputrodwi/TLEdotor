#!/usr/bin/env node
/**
 * TL Editor — worker smoke test.
 *
 * Drives the real worker router (worker/index.js) under Node with a stubbed
 * global fetch, so we exercise routing, provider dispatch, validation and the
 * security gates WITHOUT hitting the network. Run with:
 *
 *   node test/smoke.mjs
 */

// index.js is an ESM module that exports a default object with fetch(req, env, ctx).
const worker = (await import('../index.js')).default;

const realFetch = globalThis.fetch;
let fetchLog = [];
function mockFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    fetchLog.push({ url: String(url), method: (init.method || 'GET') });
    return handler(String(url), init || {});
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

function okRes(payload, status = 200, ct = 'application/json') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const env = {
  ASSETS: null,
  GATEWAY_SECRET: '',
  MAX_TEXT_BYTES: '400000',
  RATE_LIMIT_EDIT: '1000',
  RATE_LIMIT_OTHER: '1000',
  CORS_ALLOWED_ORIGINS: '',
};

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  \u2713 ' + name + (extra ? ' ' + extra : '')); }
  else { failed++; console.error('  \u2717 ' + name + (extra ? ' ' + extra : '')); }
}

async function call(req, e = env) {
  const res = await worker.fetch(req, e, {});
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, res };
}

function req(url, init = {}) {
  return new Request('https://tl.example' + url, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

console.log('\n== /api/health ==');
{
  const r = await call(req('/api/health'));
  check('health 200', r.status === 200);
  check('health lists providers', r.body.ok && Array.isArray(r.body.providers) && r.body.providers.includes('gemini'));
  check('health flags gateway protection', r.body.gatewayProtected === false);
}

console.log('\n== /api/edit — Gemini dispatch ==');
mockFetch((u, init) => {
  if (u.includes(':generateContent')) {
    const payload = { candidates: [{ content: { parts: [{ text: 'BAGIAN 1 — HASIL\nP1\n- halo dunia' }] } } ], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    return okRes(payload);
  }
  return okRes({});
});
{
  const r = await call(req('/api/edit', {
    method: 'POST',
    body: { provider: 'gemini', model: 'gemini-3.8-flash', keys: ['AIzaTESTKEY123'], text: 'P1\n- hi' },
  }));
  check('gemini edit 200', r.status === 200, JSON.stringify(r.body.code || ''));
  check('gemini raw echoed', r.body.ok === true && r.body.raw.includes('halo dunia'));
  check('gemini key used index', r.body.keyUsed === 0 && r.body.keyCount === 1);
  check('gemini usage metadata', r.body.usage && r.body.usage.promptTokenCount === 10);
}
restoreFetch();

console.log('\n== /api/edit — multi-key failover (first 429, second ok) ==');
mockFetch((u, init) => {
  const key = init.headers.Authorization.replace('Bearer ', '');
  if (u.includes('chat/completions')) {
    if (key === 'BADKEY') return okRes({ error: { message: 'rate limited' } }, 429);
    return okRes({ choices: [{ message: { content: 'BAGIAN 1\nOK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
  return okRes({});
});
{
  const r = await call(req('/api/edit', {
    method: 'POST',
    body: { provider: 'sumopod', model: 'gpt-4o-mini', keys: ['BADKEY', 'GOODKEY'], text: 'P1' },
  }));
  check('failover 200', r.status === 200, JSON.stringify(r.body.code || ''));
  check('failover used second key', r.body.keyUsed === 1 && r.body.keyCount === 2, 'keyUsed=' + r.body.keyUsed);
}
restoreFetch();

console.log('\n== /api/edit — validation & security ==');
mockFetch((u) => okRes({ choices: [] }));
{
  let r = await call(req('/api/edit', { method: 'POST', body: { provider: 'nope', model: 'x', keys: ['sk-testkey1234'], text: 'P1' } }));
  check('bad provider -> 400', r.status === 400 && r.body.code === 'BAD_PROVIDER');

  r = await call(req('/api/edit', { method: 'POST', body: { provider: 'gemini', model: 'm', keys: [], text: 'P1' } }));
  check('no keys -> 400', r.status === 400 && r.body.code === 'NO_KEYS');

  r = await call(req('/api/edit', { method: 'POST', body: { provider: 'custom', model: 'm', keys: ['sk-testkey1234'], text: 'P1', custom: { baseUrl: 'https://127.0.0.1/v1' } } }));
  check('SSRF loopback blocked -> 400', r.status === 400 && r.body.code === 'SSRF_BLOCKED');

  r = await call(req('/api/edit', { method: 'POST', body: { provider: 'custom', model: 'm', keys: ['sk-testkey1234'], text: 'P1', custom: { baseUrl: 'http://insecure.example.com/v1' } } }));
  check('non-https custom blocked -> 400', r.status === 400 && r.body.code === 'HTTPS_ONLY');

  r = await call(req('/api/edit', { method: 'POST', body: { provider: 'cloudflare', model: 'm', keys: ['sk-testkey1234'], text: 'P1', cloudflare: {} } }));
  check('cloudflare no account + no binding -> NO_CREDENTIALS 400', r.status === 400 && r.body.code === 'NO_CREDENTIALS', 'code=' + (r.body && r.body.code));

  r = await call(req('/api/edit', { method: 'POST', body: { provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', keys: ['sk-testkey1234'], text: 'P1', cloudflare: { accountId: 'test-account' } } }));
  check('cloudflare BYOK (account+token) -> 200', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.code));

  r = await call(req('/api/edit', { method: 'POST', body: { provider: 'gemini', model: 'm', keys: ['sk-testkey1234'], text: 'P1' } }));
  check('valid edit no network fail -> provider path', r.status === 200, 'status=' + r.status);
}
restoreFetch();

console.log('\n== /api/edit — cloudflare [ai] binding ==');
mockFetch(() => okRes({}));
{
  // Stub the server-side [ai] binding so we can exercise the no-credentials path.
  const eBind = { ...env, AI: { run: async (model, opts) => 'BAGIAN 1 — HASIL\nP1\n- ok-binding ' + model } };
  const r = await call(req('/api/edit', { method: 'POST', body: { provider: 'cloudflare', model: '@cf/aisingapore/gemma-sea-lion-v4-27b-it', keys: [], text: 'P1' } }), eBind);
  check('cloudflare binding -> 200', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.code));
  check('cloudflare binding raw + flag', r.body.ok === true && r.body.binding === true && r.body.raw.includes('ok-binding'));
}
restoreFetch();

console.log('\n== gateway secret gate ==');
mockFetch(() => okRes({}));
{
  const e2 = { ...env, GATEWAY_SECRET: 's3cret' };
  let r = await call(req('/api/health'), e2);
  check('missing secret -> 401', r.status === 401 && r.body.code === 'UNAUTHORIZED');

  r = await call(req('/api/health', { headers: { 'X-TL-Gateway': 's3cret' } }), e2);
  check('correct secret -> 200', r.status === 200, 'status=' + r.status);

  r = await call(req('/api/health', { headers: { 'X-TL-Gateway': 'wrong' } }), e2);
  check('wrong secret -> 401', r.status === 401);
}
restoreFetch();

console.log('\n== rate limiting ==');
mockFetch(() => okRes({}));
{
  // Use a dedicated client IP so the sliding-window bucket starts empty.
  const freshIp = { 'cf-connecting-ip': '203.0.113.5' };
  const e3 = { ...env, RATE_LIMIT_OTHER: '2', RATE_LIMIT_EDIT: '1000' };
  const r1 = await call(req('/api/health', { headers: freshIp }), e3);
  const r2 = await call(req('/api/health', { headers: freshIp }), e3);
  const r3 = await call(req('/api/health', { headers: freshIp }), e3);
  check('first two pass', r1.status === 200 && r2.status === 200, r1.status + '/' + r2.status);
  check('third rate-limited', r3.status === 429 && r3.body.code === 'RATE_LIMITED');
}
restoreFetch();

console.log('\n== /api/models & /api/ping ==');
mockFetch((u) => {
  if (u.includes('/v1/models')) return okRes({ data: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }, { id: 'gpt-4o', name: 'GPT-4o' }] });
  return okRes({});
});
{
  const qs = '/api/models?provider=sumopod&keys=' + encodeURIComponent(JSON.stringify(['k']));
  const r = await call(req(qs));
  check('models 200', r.status === 200, 'status=' + r.status);
  check('models returns ids', Array.isArray(r.body.models) && r.body.models[0].id === 'gpt-4o-mini');

  const p = await call(req('/api/ping', { method: 'POST', body: { provider: 'sumopod', keys: ['sk-testkey1234'] } }));
  check('ping 200 with results', p.status === 200 && Array.isArray(p.body.results) && p.body.results[0].ok === true);
}
restoreFetch();

console.log('\n== static fallback (no ASSETS) ==');
{
  const r = await call(req('/index.html'));
  check('non-api with no assets -> 404', r.status === 404);
}

console.log('\n== summary ==');
console.log('  fetch calls observed: ' + fetchLog.length);
console.log(failed === 0 ? '  \u2705 ALL PASSED (' + passed + ' checks)' : '  \u274c ' + failed + ' FAILED of ' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);
