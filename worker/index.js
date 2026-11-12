// TL Editor — Cloudflare Worker backend (API-only)
// Reached only through a Cloudflare Pages Service Binding (TL_WORKER) set up
// via Pages Functions (functions/api/[[path]].js). The static frontend itself
// is served by Cloudflare Pages (build output = frontend/), not by this worker.
// Security goals: no key logging, HTTPS-only, SSRF-safe custom hosts, per-IP rate limits,
// strict response headers, constant-time gateway-secret check, provider isolation.
//
// Env (see wrangler.toml):
//   GATEWAY_SECRET     optional shared secret; when set, requests must send X-TL-Gateway
//   CORS_ALLOWED_ORIGINS optional comma list; default = reflect request origin only
//   MAX_TEXT_BYTES     optional max .txt input bytes (default 400000)

const PROVIDERS = ['gemini', 'default', 'sumopod', 'custom'];

// Trusted fixed provider endpoints (HTTPS only, pinned hosts).
const BASE = {
  gemini: 'https://generativelanguage.googleapis.com',
  default: 'https://apihub.agnes-ai.com/v1',
  sumopod: 'https://ai.sumopod.com/v1',
};

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

const err = (status, code, message) => json({ ok: false, code, message }, status);

/* ---------------- security helpers ---------------- */

function publicIp(req, env) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown';
}

// Simple in-isolate sliding-window rate limiter (best effort; isolates are ephemeral).
const rateBuckets = new Map();
function rateLimit(ip, limitPerMin, windowMs = 60_000) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.window > windowMs) { b = { window: now, hits: [] }; rateBuckets.set(ip, b); }
  while (b.hits.length && now - b.hits[0] > windowMs) b.hits.shift();
  b.hits.push(now);
  return b.hits.length <= limitPerMin;
}

function isPrivateOrLoopbackHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.ts.net') || h.endsWith('.localhost')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^::ffff:/.test(h) && (h.includes('127.') || h.includes('10.') || h.includes('192.168') || h.includes('169.254'))) return true;
  // bare IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b2] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b2 === 254) return true;               // link-local / cloud metadata
    if (a === 172 && b2 >= 16 && b2 <= 31) return true;      // 172.16.0.0/12
    if (a === 192 && b2 === 168) return true;                 // 192.168.0.0/16
    if (a === 100 && b2 >= 64 && b2 <= 127) return true;      // CGNAT
    return false;
  }
  return false;
}

function assertSafeHttpsUrl(raw, label) {
  let u;
  try { u = new URL(String(raw || '')); } catch { throw httpError(400, 'BAD_URL', `${label} is not a valid URL`); }
  if (u.protocol !== 'https:') throw httpError(400, 'HTTPS_ONLY', `${label} must use https://`);
  const host = u.hostname;
  if (host === '') throw httpError(400, 'BAD_URL', `${label} has an empty host`);
  const port = u.port === '' ? '443' : u.port;
  if (port !== '443') throw httpError(400, 'PORT', `${label} must use the default https port (443)`);
  if (u.username || u.password) throw httpError(400, 'CRED_IN_URL', `embedded credentials are not allowed`);
  if (isPrivateOrLoopbackHost(host)) throw httpError(400, 'SSRF_BLOCKED', `${label} points to a private/loopback host`);
  return u;
}

function httpError(status, code, message) { return new WorkerHTTPError(status, code, message); }
class WorkerHTTPError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// constant-time-ish string compare (timing is not a real boundary here, but avoids trivial early-exit)
function safeEqual(a, b) {
  const ab = String(a || ''), bb = String(b || '');
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.min(ab.length, bb.length); i++) diff |= ab.charCodeAt(i) ^ bb.charCodeAt(i);
  return diff === 0;
}

function checkGateway(req, env) {
  if (!env.GATEWAY_SECRET) return true; // open mode
  const provided = req.headers.get('x-tl-gateway') || '';
  return safeEqual(provided, env.GATEWAY_SECRET);
}

function corsHeaders(req, env) {
  const out = {};
  const allowed = (env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const sameHost = origin === '' || new URL(origin).host === new URL(req.url).host;
  if (sameHost || (origin && allowed.includes(origin))) {
    out['Access-Control-Allow-Origin'] = origin || '*';
    out['Vary'] = 'Origin';
  }
  out['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
  out['Access-Control-Allow-Headers'] = 'Content-Type, X-TL-Gateway';
  out['Access-Control-Max-Age'] = '86400';
  return out;
}

// Merge security + CORS headers onto an existing API response body.
async function decorate(resp, req, env) {
  const h = new Headers(resp.headers);
  Object.assign(h, securityHeaders(req, env, true));
  Object.assign(h, corsHeaders(req, env));
  const body = resp.body ? await resp.arrayBuffer() : null;
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function securityHeaders(req, env, isApi) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (isApi) {
    h['Cache-Control'] = 'no-store';
    h['Cross-Origin-Resource-Policy'] = 'same-site';
  } else {
    h['Content-Security-Policy'] =
      "default-src 'self'; script-src 'self'; " +
      "style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: blob:; connect-src 'self' https://; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
    h['X-Frame-Options'] = 'DENY';
    h['Cross-Origin-Opener-Policy'] = 'same-origin';
    h['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  return h;
}

function validateKeys(provider, keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw httpError(400, 'NO_KEYS', 'Setiap provider butuh minimal 1 API key');
  if (keys.length > 40) throw httpError(400, 'TOO_MANY_KEYS', 'Maksimal 40 key per request');
  const cleaned = keys.map((k) => String(k || '').trim());
  for (const k of cleaned) {
    if (k.length === 0) throw httpError(400, 'EMPTY_KEY', 'API key kosong');
    if (k.length > 500) throw httpError(400, 'KEY_TOO_LONG', 'API key terlalu panjang');
    if (/[{}\[\]<>\/\\]/.test(k) && provider !== 'custom') throw httpError(400, 'KEY_FORMAT', 'API key mengandung karakter tidak valid');
    if (k.length < 4) throw httpError(400, 'KEY_FORMAT', 'API key terlalu pendek');
  }
  return cleaned;
}

/* ---------------- provider calls ---------------- */

async function withTimeout(promise, ms, label) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await promise({ signal: ctl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

function retryableStatus(s) { return s === 401 || s === 403 || s === 429 || s === 503 || s >= 500; }
function keyStatusNote(status) {
  if (status === 401) return 'key ditolak (401)';
  if (status === 403) return 'key tidak punya akses (403)';
  if (status === 429) return 'limit/rate (429)';
  if (status >= 500) return 'server provider (' + status + ')';
  return 'provider ' + status;
}

function buildOpenAIBase(provider, body, env) {
  if (provider === 'sumopod') return BASE.sumopod;
  if (provider === 'default') return BASE.default;
  // custom
  const raw = body.custom && body.custom.baseUrl;
  const u = assertSafeHttpsUrl(raw, 'custom baseUrl');
  let base = u.toString();
  base = base.replace(/\/$/, '');
  // accept either "https://host/v1" or "https://host" -> we append /v1 only if it ends in /v1 already
  if (!/\/v\d+$/.test(base)) base += '/v1';
  return base;
}

async function callOpenAI({ baseUrl, key, model, system, userMsg, temperature, maxTokens, timeoutMs }) {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body = { model, messages: [], temperature, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  if (system) body.messages.push({ role: 'system', content: system });
  body.messages.push({ role: 'user', content: userMsg });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  const raw = await (ct.includes('application/json') ? '' : res.text());
  if (!res.ok) {
    const e = new Error('provider ' + res.status);
    e.status = res.status;
    e.detail = (data && (data.error && data.error.message)) || (typeof raw === 'string' ? raw.slice(0, 300) : 'provider ' + res.status);
    throw e;
  }
  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return { text, usage: data && data.usage ? data.usage : null };
}

async function callGemini({ base, key, model, system, userMsg, temperature, maxTokens, timeoutMs }) {
  const u = new URL(base + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent');
  u.searchParams.set('key', key);
  const body = {
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig: { temperature },
  };
  if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error('provider ' + res.status);
    e.status = res.status;
    e.detail = (data && data.error && data.error.message) || ('provider ' + res.status);
    throw e;
  }
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  return { text, usage: data && data.usageMetadata ? data.usageMetadata : null };
}

/* ---------------- list-models ---------------- */

async function listModels(provider, body, key, timeoutMs) {
  let res, data;
  if (provider === 'gemini') {
    res = await fetch(BASE.gemini + '/v1beta/models?key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(timeoutMs) });
    data = await res.json().catch(() => null);
    if (!res.ok) throw httpError(res.status, 'LIST_FAILED', 'Gagal memuat model Gemini');
    const items = ((data && data.models) || []).map(m => ({ id: String(m.name || '').replace(/^models\//, ''), displayName: m.displayName || m.name })).filter(m => {
      const s = (m.id + ' ' + m.displayName).toLowerCase();
      if (/embed|gemma|imagen|veo|tts|asr|transcribe|live\b|safety|code/ .test(s)) return false;
      return /gemini/.test(s);
    });
    return items;
  }
  if (provider === 'sumopod' || provider === 'default') {
    const base = provider === 'sumopod' ? BASE.sumopod : BASE.default;
    res = await fetch(base.replace(/\/v\d+$/, '') + '/v1/models', {
      headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs),
    });
    data = await res.json().catch(() => null);
    if (!res.ok) throw httpError(res.status, 'LIST_FAILED', 'Gagal memuat model');
    return ((data && data.data) || []).map(m => ({ id: m.id, displayName: m.name || m.id }));
  }
  // custom
  const baseUrl = buildOpenAIBase('custom', body, null);
  res = await fetch(baseUrl + '/models', {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
  });
  data = await res.json().catch(() => null);
  if (!res.ok) throw httpError(res.status, 'LIST_FAILED', 'Custom: gagal memuat model (' + res.status + ')');
  return ((data && data.data) || []).map(m => ({ id: m.id, displayName: m.name || m.id }));
}

/* ---------------- main ---------------- */

const SYSTEM_PROMPT_FALLBACK = 'Kamu adalah editor terjemahan komik bahasa Inggris ke bahasa Indonesia yang sangat teliti. Perbaiki naturalitas, typo, dan makna; pertahankan struktur file, penanda halaman, istilah Inggris, dan kata ganti pengguna. Jaga output rapi dan tetap mengikuti format tiga bagian (Hasil, Perubahan, Perlu Dicek).';

async function handleEdit(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    throw httpError(400, 'BAD_JSON', 'Body harus JSON valid');
  }

  const provider = String(body.provider || '').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw httpError(400, 'BAD_PROVIDER', 'Provider tidak dikenal');
  const model = String(body.model || '').trim();
  if (!model || model.length > 200) throw httpError(400, 'BAD_MODEL', 'Model wajib diisi');
  if (/[<>{}]/.test(model)) throw httpError(400, 'BAD_MODEL', 'Model mengandung karakter tidak valid');

  const text = String(body.text || '');
  const maxText = Number(env.MAX_TEXT_BYTES || 400000);
  if (text.length === 0) throw httpError(400, 'EMPTY_TEXT', 'Isi file terjemahan (.txt) kosong');
  if (text.length > maxText) throw httpError(413, 'TEXT_TOO_LONG', 'File terlalu besar (maks ' + maxText + ' karakter)');

  let system = String(body.systemPrompt || '').trim();
  if (!system) system = env.DEFAULT_SYSTEM_PROMPT || SYSTEM_PROMPT_FALLBACK;
  if (system.length > 60000) throw httpError(413, 'PROMPT_TOO_LONG', 'System prompt terlalu panjang');

  const temperature = Number.isFinite(body.temperature) ? Math.max(0, Math.min(1.5, Number(body.temperature))) : 0.2;
  const maxTokens = Number.isFinite(body.maxOutputTokens) ? Math.max(256, Math.min(32768, Math.round(body.maxOutputTokens))) : 8192;

  // provider-specific extras
  let customBaseUrl = null, customFormat = 'openai';
  if (provider === 'custom') {
    customBaseUrl = String((body.custom && body.custom.baseUrl) || '').trim();
    if (!customBaseUrl) throw httpError(400, 'NO_CUSTOM_URL', 'Custom butuh baseUrl');
    customFormat = (body.custom && body.custom.format) === 'gemini' ? 'gemini' : 'openai';
    const safeU = assertSafeHttpsUrl(customBaseUrl, 'custom baseUrl');
    let norm = safeU.toString().replace(/\/+$/, '');
    if (customFormat === 'openai' && !/\/v\d+$/.test(norm)) norm += '/v1';
    customBaseUrl = norm;
  }

  // "default" provider: allow user-provided keys OR fall back to server key.
  const serverKeyMode = provider === 'default';
  const keys = validateKeys(provider, body.keys || []);
  // If user provided keys, use them; otherwise use server key as fallback
  const effectiveKeys = keys.length > 0 ? keys : (serverKeyMode ? [env.DEFAULT_API_KEY || ''] : []);
  if (serverKeyMode && !effectiveKeys[0]) {
    throw httpError(500, 'NO_SERVER_KEY', 'Worker: DEFAULT_API_KEY belum diset. Jalankan: wrangler secret put DEFAULT_API_KEY');
  }

  // build the user message
  const userMsg = assembleUserMessage(text, body.continueFromPage);

  const timeoutMs = 180_000; // 3 minutes

  // Server-key mode ("default") but user may have provided their own key.
  const useServerKey = keys.length === 0;
  if (useServerKey) {
    const key = env.DEFAULT_API_KEY || '';
    try {
      const { text: out, usage } = await dispatch({
        provider, model, key, customBaseUrl, customFormat,
        system, userMsg, temperature, maxTokens, timeoutMs,
      });
      return json({ ok: true, provider, model, serverKey: true, keyUsed: -1, keyCount: 0, raw: out, usage: usage || null });
    } catch (e) {
      return err(e.status || 502, 'PROVIDER_FAILED', 'Default provider gagal: ' + String(e.detail || e.message || 'kesalahan').slice(0, 260));
    }
  }
  const strategy = (body.strategy || 'sequential').toLowerCase(); // sequential | round-robin
  const startIdx = strategy === 'round-robin' ? (keys.length ? Math.floor(Math.random() * keys.length) : 0) : 0;

  const lastError = { status: 0, detail: 'no attempt' };
  for (let i = 0; i < keys.length; i++) {
    const idx = (startIdx + i) % keys.length;
    const key = keys[idx];
    try {
      const { text: out, usage } = await dispatch({
        provider, model, key, customBaseUrl, customFormat,
        system, userMsg, temperature, maxTokens, timeoutMs,
      });
      return json({
        ok: true,
        provider, model,
        keyUsed: idx, keyCount: keys.length,
        raw: out,
        usage: usage || null,
      });
    } catch (e) {
      const status = e.status || 0;
      if (!retryableStatus(status || 599) && (status >= 400 && status < 500 && status !== 429)) {
        // non-key error (bad request etc): return immediately, not worth trying other keys
        lastError.status = status; lastError.detail = e.detail || e.message || 'error';
        break;
      }
      lastError.status = status || 599;
      lastError.detail = e.detail || e.message || 'gagal (' + (status || 'network') + ')';
      if (e.status === 404) {
        // model not found is the same for every key: no point rotating.
        break;
      }
    }
  }
  return err(lastError.status || 502, 'PROVIDER_FAILED', 'Semua key gagal. Terakhir: ' + keyStatusNote(lastError.status) + ' — ' + String(lastError.detail).slice(0, 200));
}

async function dispatch(o) {
  const { provider } = o;
  if (provider === 'gemini') {
    return callGemini({ base: BASE.gemini, key: o.key, model: o.model, system: o.system, userMsg: o.userMsg, temperature: o.temperature, maxTokens: o.maxTokens, timeoutMs: o.timeoutMs });
  }
  // openai-compatible: default, sumopod, custom
  if (provider === 'custom' && o.customFormat === 'gemini') {
    return callGemini({ base: o.customBaseUrl, key: o.key, model: o.model, system: o.system, userMsg: o.userMsg, temperature: o.temperature, maxTokens: o.maxTokens, timeoutMs: o.timeoutMs });
  }
  // For default provider, use explicit baseUrl if provided (user's own key), else use default
  const baseUrl = o.customBaseUrl || (provider === 'custom' ? o.customBaseUrl : buildOpenAIBase(provider, {}, null));
  return callOpenAI({ baseUrl, key: o.key, model: o.model, system: o.system, userMsg: o.userMsg, temperature: o.temperature, maxTokens: o.maxTokens, timeoutMs: o.timeoutMs });
}

function assembleUserMessage(text, continueFromPage) {
  let parts = [];
  parts.push('# PERMINTAAN EDITOR');
  parts.push('Berikut adalah file naskah terjemahan (bahasa Indonesia) yang perlu kamu sunting. Ikuti seluruh aturan system prompt dan kembalikan hasil dalam tiga bagian (HASIL, PERUBAHAN, PERLU DICEK).');
  if (continueFromPage) {
    parts.push('Lanjutkan dari halaman ' + continueFromPage + '. Jangan mengulang bagian yang sudah selesai sebelumnya.');
  }
  parts.push('');
  parts.push('# FILE HASIL TERJEMAHAN (.txt)');
  parts.push('```txt');
  parts.push(text);
  parts.push('```');
  parts.push('');
  parts.push('Mulai. Jangan menambah komentar di luar format tiga bagian.');
  return parts.join('\n');
}

async function handleModels(req, env) {
  let body;
  try { body = await req.json(); } catch { throw httpError(400, 'BAD_JSON', 'Body harus JSON valid'); }
  const provider = String(body.provider || '').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw httpError(400, 'BAD_PROVIDER', 'Provider tidak dikenal');
  const keys = Array.isArray(body.keys) ? body.keys.map(k => String(k || '').trim()).filter(Boolean) : [];
  const key = keys[0] || '';
  if (provider === 'default') {
    // server key mode: use env key, no user keys needed
    const srvKey = env.DEFAULT_API_KEY || '';
    const items = await listModels(provider, body, srvKey, 20_000);
    return json({ ok: true, provider, models: items.slice(0, 500) });
  } else if (!key) {
    throw httpError(400, 'NO_KEYS', 'Lihat model butuh 1 API key');
  }
  const items = await listModels(provider, body, key, 20_000);
  return json({ ok: true, provider, models: items.slice(0, 500) });
}

async function handlePing(req, env) {
  const body = await req.json().catch(() => ({}));
  const provider = String(body.provider || '').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw httpError(400, 'BAD_PROVIDER', 'Provider tidak dikenal');
  const model = String(body.model || '').trim() || defaultModel(provider);
  // Server key mode: no user keys
  if (provider === 'default') {
    const srvKey = env.DEFAULT_API_KEY || '';
    try {
      await pingProvider(provider, srvKey, model, body, 12_000);
      return json({ ok: true, results: [{ index: 0, ok: true, serverKey: true }] });
    } catch (e) {
      return json({ ok: true, results: [{ index: 0, ok: false, code: e.status || 599, detail: (e.detail || e.message || 'gagal').slice(0, 160), serverKey: true }] });
    }
  }
  const keys = validateKeys(provider, body.keys || []);
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      await pingProvider(provider, key, model, body, 12_000);
      results.push({ index: i, ok: true });
    } catch (e) {
      results.push({ index: i, ok: false, code: e.status || 599, detail: (e.detail || e.message || 'gagal').slice(0, 160) });
    }
  }
  return json({ ok: true, results });
}

async function pingProvider(provider, key, model, body, timeoutMs) {
  if (provider === 'gemini') {
    const res = await fetch(BASE.gemini + '/v1beta/models?key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { const e = new Error('ping'); e.status = res.status; e.detail = 'gemini ' + res.status; throw e; }
    return;
  }
  if (provider === 'sumopod' || provider === 'default') {
    const base = provider === 'sumopod' ? BASE.sumopod : BASE.default;
    const res = await fetch(base.replace(/\/v\d+$/, '') + '/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { const e = new Error('ping'); e.status = res.status; e.detail = provider + ' ' + res.status; throw e; }
    return;
  }
  const baseUrl = buildOpenAIBase('custom', { custom: { baseUrl: body.custom && body.custom.baseUrl } }, null);
  const res = await fetch(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error('ping'); e.status = res.status; e.detail = 'custom ' + res.status; throw e; }
}

function defaultModel(provider) {
  switch (provider) {
    case 'gemini': return 'gemini-3.5-flash-lite';
    case 'default': return 'agnes-2.5-flash';
    case 'sumopod': return 'gpt-4o-mini';
    case 'custom': return '';
    default: return '';
  }
}

async function handleHealth(req, env) {
  return json({ ok: true, providers: PROVIDERS, gatewayProtected: !!env.GATEWAY_SECRET });
}

/* ---------------- router ---------------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response('', { status: 204, headers: corsHeaders(req, env) });
    }

    const isApi = path.startsWith('/api/');

    if (isApi) {
      if (!['GET', 'POST'].includes(method)) {
        return decorate(json({ ok: false, code: 'METHOD', message: 'Method tidak diizinkan' }, 405), req, env);
      }

      // rate limit
      const ip = publicIp(req, env);
      const limit = path === '/api/edit' ? Number(env.RATE_LIMIT_EDIT || 30) : Number(env.RATE_LIMIT_OTHER || 60);
      if (!rateLimit(ip + path, limit)) {
        return decorate(json({ ok: false, code: 'RATE_LIMITED', message: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' }, 429), req, env);
      }

      if (!checkGateway(req, env)) {
        return decorate(json({ ok: false, code: 'UNAUTHORIZED', message: 'Gateway secret tidak valid' }, 401), req, env);
      }

      try {
        let resp;
        if (method === 'GET' && path === '/api/health') resp = await handleHealth(req, env);
        else if (method === 'POST' && path === '/api/models') resp = await handleModels(req, env);
        else if (method === 'GET' && path === '/api/prompt') { const m = await import('./prompts.js'); resp = m.handlePrompt(req, env); }
        else if (method === 'GET' && path === '/api/sample') { const m = await import('./prompts.js'); resp = m.handleSample(req, env); }
        else if (method === 'POST' && path === '/api/ping') resp = await handlePing(req, env);
        else if (method === 'POST' && path === '/api/edit') resp = await handleEdit(req, env);
        else resp = err(404, 'NOT_FOUND', 'Endpoint tidak ditemukan');
        return decorate(resp, req, env);
      } catch (e) {
        if (e instanceof WorkerHTTPError) {
          return decorate(err(e.status, e.code, e.message), req, env);
        }
        // Unknown error — never leak internals
        return decorate(err(500, 'INTERNAL', 'Kesalahan internal. Coba lagi.'), req, env);
      }
    }

    // API-only worker: the static frontend is served by Cloudflare Pages.
    // Only /api/* should ever reach this worker (via the Pages service binding).
    return new Response(
      JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'Worker ini hanya melayani /api/*. Frontend statis ada di Cloudflare Pages.' }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(req, env, true), ...corsHeaders(req, env) } },
    );
  },
};
