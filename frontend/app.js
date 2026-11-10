/* ============================================================
   TL Editor — frontend logic
   Cloudflare Pages (static) -> Cloudflare Worker (/api)
   Security: AES-GCM + PBKDF2 encrypted key vault, memory-only
   plaintext, per-provider multi-key, HTTPS-only. No key logging.
   ============================================================ */
(() => {
'use strict';

/* ---------- tiny DOM helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) { if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind;
  t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------- provider catalog (curated; Load Models can refresh) ---------- */
const PROVIDERS = {
  gemini: {
    label: 'Gemini', icon: '✦', tag: 'Gemini 3.8 Flash',
    keyLabel: 'Gemini API Key', multiKey: true,
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-live', 'gemini-3.8-flash-lite-tts'],
    keyHint: 'Mulai dengan AIza… (bukan model Gemini 2 / 2.5 — sudah discontinued)',
    keyRe: /^[A-Za-z0-9_\-./+]{8,}$/
  },
  sumopod: {
    label: 'Sumopod', icon: '∑', tag: 'ai.sumopod.com',
    keyLabel: 'Sumopod API Key', multiKey: true,
    models: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat'],
    keyHint: 'Base https://ai.sumopod.com/v1 (OpenAI-compatible)',
    keyRe: /^[A-Za-z0-9_\-]{8,}$/
  },
  agnes: {
    label: 'Agnes AI', icon: 'A', tag: 'apihub.agnes-ai.com',
    keyLabel: 'Agnes API Key', multiKey: true,
    models: ['agnes-2.5-flash', 'agnes-2.0-flash', 'agnes-1.5-flash'],
    keyHint: 'Base https://apihub.agnes-ai.com/v1 (OpenAI-compatible)',
    keyRe: /^[A-Za-z0-9_\-]{8,}$/
  },
  cloudflare: {
    label: 'Cloudflare', icon: '▣', tag: 'Workers AI (binding / BYOK)',
    keyLabel: 'Cloudflare API Token', multiKey: true, needsAccount: true,
    // Daftar model teks gratis (termasuk dalam kuota 10k neuron/hari Workers AI).
    // ID terkini diambil dari katalog live CF; klik "Load Models" untuk daftar hidup.
    models: [
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // flagship, andal untuk editing
      '@cf/aisingapore/gemma-sea-lion-v4-27b-it', // SEA-tuned, paling cocok untuk Bahasa Indonesia
      '@cf/qwen/qwen3.8-27b',                     // multilingual kuat
      '@cf/meta/llama-4-scout-17b-16e-instruct',  // cepat (MoE), konteks 131K
      '@cf/meta/llama-3.1-8b-instruct-fp8',       // hemat neuron, paling ringan
    ],
    keyHint: 'Gratis (10k neuron/hari). Kosongkan Account ID = pakai [ai] binding server; atau isi Account ID + API Token untuk BYOK. Model besar (70B/32B) memakai neuron lebih banyak.',
    keyRe: /^[A-Za-z0-9_\-]{8,}$/
  },
  custom: {
    label: 'Custom', icon: '⚙', tag: 'OpenAI-compatible',
    keyLabel: 'API Key', multiKey: true, needsUrl: true,
    models: [],
    keyHint: 'Isi Base URL + model. Format OpenAI (default) atau Gemini.',
    keyRe: /^[A-Za-z0-9_\-/.+]{6,}$/
  },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

/* ---------- state ---------- */
const state = {
  provider: 'gemini',
  keys: { gemini: [], sumopod: [], agnes: [], cloudflare: [], custom: [] }, // {id,value,shown}
  models: {},          // provider -> selected model id
  temperature: 0.2,
  maxTokens: 8192,
  cloudflare: { accountId: '' },
  custom: { baseUrl: '', format: 'openai' },
  settings: { workerUrl: '', gatewaySecret: '' },
  storageMode: 'device',   // device | session
  unlocked: false,
  systemPrompt: '',
  lastResult: null,
  lastRun: null,
};
let _aesKey = null;   // in-memory AES-GCM key (device mode, unlocked)
const KEY_IDS = {};
let KEY_SEQ = 0;
const nextKey = (p) => (KEY_IDS[p] = (KEY_IDS[p] || 0) + 1, KEY_SEQ++, 'k' + KEY_SEQ);

/* ---------- Web Crypto vault ---------- */
const b64 = {
  enc: (u8) => btoa(String.fromCharCode.apply(null, u8)),
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
async function deriveAesKey(passphrase, salt, iter = 310000) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function vaultEncrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64.enc(iv), data: b64.enc(new Uint8Array(ct)) };
}
async function vaultDecrypt(key, packed) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(packed.iv) }, key, b64.dec(packed.data));
  return JSON.parse(new TextDecoder().decode(pt));
}
function collectVaultPayload() {
  return {
    keys: Object.fromEntries(PROVIDER_IDS.map(p => [p, state.keys[p].map(k => k.value)])),
    models: state.models,
    temperature: state.temperature,
    maxTokens: state.maxTokens,
    cloudflare: state.cloudflare,
    custom: state.custom,
    settings: state.settings,
  };
}
async function persistVault() {
  if (state.storageMode === 'device' && _aesKey) {
    const packed = await vaultEncrypt(_aesKey, collectVaultPayload());
    let meta = JSON.parse(localStorage.getItem('tl.vault.meta') || '{}');
    localStorage.setItem('tl.vault.data', JSON.stringify(packed));
    localStorage.setItem('tl.vault.meta', JSON.stringify({ v: 1, iter: meta.iter || 310000, salt: meta.salt }));
  } else if (state.storageMode === 'session') {
    sessionStorage.setItem('tl.session', JSON.stringify(collectVaultPayload()));
  }
}
function applyVaultPayload(p) {
  for (const pid of PROVIDER_IDS) {
    const arr = Array.isArray(p.keys?.[pid]) ? p.keys[pid] : [];
    state.keys[pid] = arr.map(v => ({ id: nextKey(pid), value: String(v), shown: false }));
  }
  if (p.models) state.models = p.models;
  state.temperature = p.temperature ?? 0.2;
  state.maxTokens = p.maxTokens ?? 8192;
  if (p.cloudflare) state.cloudflare = p.cloudflare;
  if (p.custom) state.custom = p.custom;
  if (p.settings) state.settings = p.settings;
}

async function createVault(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  _aesKey = await deriveAesKey(passphrase, salt);
  const packed = await vaultEncrypt(_aesKey, collectVaultPayload());
  localStorage.setItem('tl.vault.data', JSON.stringify(packed));
  localStorage.setItem('tl.vault.meta', JSON.stringify({ v: 1, iter: 310000, salt: b64.enc(salt) }));
  state.storageMode = 'device'; state.unlocked = true;
  await persistVault();
}
async function unlockVault(passphrase) {
  const metaRaw = localStorage.getItem('tl.vault.meta'); const dataRaw = localStorage.getItem('tl.vault.data');
  if (!metaRaw || !dataRaw) throw new Error('Vault tidak ditemukan.');
  const meta = JSON.parse(metaRaw); const data = JSON.parse(dataRaw);
  const key = await deriveAesKey(passphrase, b64.dec(meta.salt), meta.iter || 310000);
  const p = await vaultDecrypt(key, data);
  _aesKey = key; applyVaultPayload(p); state.storageMode = 'device'; state.unlocked = true;
  await persistVault();
}

/* ---------- provider config UI ---------- */
const TILE_CODE = { gemini: 'G', sumopod: 'S', agnes: 'A', cloudflare: 'CF', custom: 'C' };
function renderProviderTiles() {
  const wrap = $('#providerTiles'); wrap.innerHTML = '';
  PROVIDER_IDS.forEach(id => {
    const p = PROVIDERS[id];
    const active = state.provider === id;
    const b = el('button', { class: 'ptile' + (active ? ' active' : ''), title: p.keyHint },
      el('span', { class: 'pico' }, TILE_CODE[id]),
      el('span', { class: 'pname' }, p.label),
      el('span', { class: 'ptag' }, p.tag),
      active ? el('span', { class: 'ptag-on' }, 'AKTIF') : null,
    );
    b.onclick = () => selectProvider(id);
    wrap.append(b);
  });
}
function selectProvider(id) {
  state.provider = id;
  renderProviderTiles();
  syncProviderUI();
  renderKeys();
  renderModelSelect();
}
function syncProviderUI() {
  const p = PROVIDERS[state.provider];
  $('#cfAccountWrap').classList.toggle('hidden', state.provider !== 'cloudflare');
  $('#customWrap').classList.toggle('hidden', state.provider !== 'custom');
  $('#cfAccountId').value = state.cloudflare.accountId;
  $('#customBaseUrl').value = state.custom.baseUrl;
  $$('#customFormatTabs [data-cf]').forEach(b => b.classList.toggle('active', b.dataset.cf === state.custom.format));
  $('#keyEncryptionNote').textContent = p.keyLabel + ' • terenkripsi (AES-GCM), hanya di perangkat.';
  updateRunSummary();
}
function renderModelSelect() {
  const p = PROVIDERS[state.provider];
  const dl = $('#modelOptions'); dl.innerHTML = '';
  (p.models || []).forEach(m => dl.append(el('option', { value: m }, m)));
  if (!state.models[state.provider]) state.models[state.provider] = p.models[0] || '';
  $('#modelInput').value = state.models[state.provider];
  updateRunSummary();
}
function updateRunSummary() {
  const p = PROVIDERS[state.provider];
  const pc = $('#providerChip'); if (pc) pc.textContent = p.label;
  const mc = $('#modelChip');
  if (mc) { const m = state.models[state.provider] || ''; mc.textContent = m ? (m.length > 34 ? m.slice(0, 32) + '…' : m) : '—'; }
}

/* ---------- keys UI ---------- */
function renderKeys() {
  const list = $('#kunciList'); list.innerHTML = '';
  const keys = state.keys[state.provider];
  const p = PROVIDERS[state.provider];
  $('#keyCount').textContent = keys.filter(k => k.value).length + ' aktif';
  if (state.storageMode === 'device' && !state.unlocked && localStorage.getItem('tl.vault.data')) {
    const b = el('button', { class: 'ghost-btn', style: 'width:100%;padding:8px' }, 'Terkunci — ' + keys.length + ' kunci tersimpan terenkripsi. Buka kunci.');
    b.onclick = () => { showView('security'); setTimeout(() => $('#unlockPass').focus(), 50); };
    list.append(el('div', { class: 'key-item' }, el('span', { class: 'kdot' }), el('span', { class: 'kname' }, ''), b));
    updateSecChecklist();
    return;
  }
  if (keys.length === 0) {
    const msg = state.provider === 'cloudflare'
      ? 'Kosongkan = pakai [ai] binding server (tanpa kunci). Atau tambah token untuk BYOK.'
      : 'Belum ada kunci untuk ' + p.label + '. Klik “+ Tambah kunci”.';
    list.append(el('div', { class: 'muted', style: 'padding:4px' }, msg));
    updateSecChecklist();
    return;
  }
  keys.forEach((k, i) => {
    const valid = p.keyRe ? p.keyRe.test(k.value) : k.value.length >= 4;
    const mask = k.value ? '•'.repeat(Math.min(10, Math.max(4, Math.floor(k.value.length / 3)))) + ' ' + k.value.slice(-4) : '(kosong)';
    const item = el('div', { class: 'key-item' + (valid ? '' : ' invalid') });
    item.append(
      el('span', { class: 'kdot' }),
      el('span', { class: 'kname' }, 'Kunci ' + (i + 1)),
      el('span', { class: 'kmask', id: 'mask-' + k.id }, k.shown ? k.value : mask),
    );
    const acts = el('span', { class: 'kactions' });
    const eye = el('button', { class: 'kbtn', title: 'Tampilkan' }, 'Lihat');
    eye.style.fontSize = '11px';
    eye.onclick = () => { k.shown = !k.shown; eye.textContent = k.shown ? 'Semb' : 'Lihat'; const m2 = document.getElementById('mask-' + k.id); if (m2) m2.textContent = k.shown ? k.value : mask; };
    const del = el('button', { class: 'kbtn del', title: 'Hapus' }, '×');
    del.onclick = () => { keys.splice(i, 1); renderKeys(); autoSave(); };
    acts.append(eye, del);
    item.append(acts);
    const inp = el('input', { class: 'kedit', value: k.value, placeholder: p.keyLabel, spellcheck: 'false' });
    inp.onchange = () => { k.value = inp.value.trim(); renderKeys(); autoSave(); toast('Kunci diperbarui', 'ok'); };
    item.append(inp);
    list.append(item);
  });
  updateSecChecklist();
}
$('#btnAddKey').onclick = async () => {
  const p = PROVIDERS[state.provider];
  const first = state.keys[state.provider].length === 0;
  if (first && !state.unlocked) await maybePromptPass();
  state.keys[state.provider].push({ id: nextKey(state.provider), value: '', shown: false });
  renderKeys(); autoSave();
  if (first) $('#pingResults').classList.add('hidden');
};
function autoSave() { if (state.unlocked) persistVault().catch(e => toast('Gagal menyimpan vault: ' + e.message, 'err')); }

/* ---------- ping / health ---------- */
async function apiCall(path, body, method = 'POST') {
  const base = state.settings.workerUrl ? state.settings.workerUrl.replace(/\/$/, '') : '';
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.settings.gatewaySecret) headers['X-TL-Gateway'] = state.settings.gatewaySecret;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Tidak bisa menjangkau Worker. Periksa URL Worker / koneksi. (' + e.message + ')');
  }
  let data; try { data = await res.json(); } catch { data = { ok: false, code: 'BAD_RESPONSE', message: 'Respon bukan JSON' }; }
  if (!res.ok) { const e = new Error(data.message || ('HTTP ' + res.status)); e.code = data.code; e.status = res.status; throw e; }
  return data;
}

$('#btnPingAll').onclick = async () => {
  const keys = state.keys[state.provider].map(k => k.value).filter(Boolean);
  if (!keys.length) return toast('Tambahkan key dulu.', 'err');
  const box = $('#pingResults'); box.classList.remove('hidden'); box.innerHTML = '<div class="muted">Menguji ' + keys.length + ' key…</div>';
  try {
    const body = { provider: state.provider, model: PROVIDERS[state.provider].models[0] || '', keys };
    if (state.provider === 'cloudflare') body.cloudflare = { accountId: state.cloudflare.accountId };
    if (state.provider === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/ping', body);
    box.innerHTML = '';
    r.results.forEach(row => {
      box.append(el('div', { class: 'ping-row ' + (row.ok ? 'ok' : 'bad') },
        el('span', {}, 'Kunci ' + (row.index + 1)), el('span', {}, row.ok ? 'OK' : 'Gagal — ' + (row.detail || row.code))));
    });
  } catch (e) { box.innerHTML = ''; box.append(el('div', { class: 'ping-row bad' }, 'Gagal: ' + e.message)); }
};

function checkWorkerStatus() {
  apiCall('/api/health').then(h => {
    const c = $('#workerStatusChip'); c.className = 'chip chip-status ok';
    $('#workerStatusText').textContent = 'Worker online' + (h.gatewayProtected ? ' • ter-proteksi' : '');
  }).catch(() => {
    const c = $('#workerStatusChip'); c.className = 'chip chip-status err';
    $('#workerStatusText').textContent = 'Worker belum tercapai';
  });
}

/* ---------- source file handling ---------- */
function updateSourceStats() {
  const t = $('#txtPaste').value;
  const lines = t ? t.split('\n').filter(x => x.length).length : 0;
  const pages = (t.match(/^\s*P\d+/gm) || []).length;
  $('#statLines').textContent = lines + ' baris';
  $('#statPages').textContent = pages + ' halaman';
  $('#statChars').textContent = t.length.toLocaleString('en-US') + ' karakter';
  $('#statTokens').textContent = '~' + Math.round(t.length / 3.5).toLocaleString('en-US') + ' token';
  updateLineNumbers();
}
function updateLineNumbers() {
  const on = $('#lineNumbers').checked;
  const g = $('#lineGutter'); g.parentElement;
  if (!on) { g.innerHTML = ''; g.style.visibility = 'hidden'; return; }
  g.style.visibility = 'visible';
  const n = $('#txtPaste').value.split('\n').length;
  let s = ''; for (let i = 1; i <= n; i++) s += String(i).padStart(2, '0');
  g.textContent = s;
}
['input'].forEach(ev => { $('#txtPaste').addEventListener(ev, updateSourceStats); });
$('#lineNumbers').onchange = updateLineNumbers;
$('#txtPaste').addEventListener('scroll', () => { $('#lineGutter').scrollTop = $('#txtPaste').scrollTop; });

function normalizeText(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')          // cap huge blank gaps
    .replace(/[ \t]+(\n)/g, '$1');          // trim trailing spaces before newline
}
$('#btnNormalize').onclick = () => { const t = normalizeText($('#txtPaste').value); $('#txtPaste').value = t; updateSourceStats(); toast('Dinormalisasi (baris kosong & spasi berlebih dirapikan, konten tidak diubah)'); };
$('#btnClearSource').onclick = () => { $('#txtPaste').value = ''; $('#txtSource').value = ''; updateSourceStats(); };
$('#btnSample').onclick = async () => {
  try { const r = await fetch('prompts/SAMPLE_CH121.txt'); $('#txtPaste').value = await r.text(); updateSourceStats(); toast('Contoh naskah dimuat'); }
  catch { toast('Gagal memuat contoh', 'err'); }
};

/* source tabs */
$$('[data-srctab]').forEach(b => b.onclick = () => {
  $$('.seg-tabs [data-srctab]').forEach(x => x.classList.remove('active')); b.classList.add('active');
  const mode = b.dataset.srctab;
  $('#txtPaste').classList.toggle('hidden', mode === 'source');
  $('#txtSource').classList.toggle('hidden', mode !== 'source');
  $('#uploadHint').classList.toggle('hidden', mode === 'paste');
  $('#lineGutter').style.visibility = (mode === 'paste' && $('#lineNumbers').checked) ? 'visible' : 'hidden';
  if (mode === 'paste') updateSourceStats();
});
$('#btnChooseFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const txt = await files[0].text();
  const isSource = $$('.seg-tabs [data-srctab]').find(x => x.classList.contains('active'))?.dataset.srctab === 'source';
  if (isSource) $('#txtSource').value = txt; else { $('#txtPaste').value = txt; updateSourceStats(); }
  toast('File "' + files[0].name + '" dimuat (' + files[0].size.toLocaleString() + ' bytes)');
};
// drag & drop
const srcArea = $('#srcArea');
['dragover', 'drop'].forEach(ev => srcArea.addEventListener(ev, e => e.preventDefault()));
srcArea.addEventListener('drop', async e => {
  const f = e.dataTransfer.files?.[0]; if (!f) return;
  if (!/\.txt$|text\/plain/i.test(f.name)) return toast('Hanya file .txt', 'err');
  const txt = await f.text(); $('#txtPaste').value = txt; updateSourceStats(); toast('Drag-in: ' + f.name);
});

/* ---------- model loading ---------- */
$('#btnLoadModels').onclick = async () => {
  const p = state.provider;
  const keys = state.keys[p].map(k => k.value).filter(Boolean);
  const panel = $('#modelList');
  if (p !== 'cloudflare' && keys.length === 0) return toast('Isi minimal 1 kunci untuk load model ' + PROVIDERS[p].label, 'err');
  panel.innerHTML = '';
  panel.append(el('div', { class: 'model-opt', style: 'cursor:default' }, el('span', { class: 'muted' }, 'Memuat daftar ' + PROVIDERS[p].label + '…')));
  try {
    let qs = '/api/models?provider=' + encodeURIComponent(p) + '&keys=' + encodeURIComponent(JSON.stringify(keys));
    if (p === 'cloudflare') qs += '&cf=' + encodeURIComponent(state.cloudflare.accountId);
    if (p === 'custom') qs += '&cust=' + encodeURIComponent(JSON.stringify({ baseUrl: state.custom.baseUrl, format: state.custom.format }));
    const r = await apiCall(qs, null, 'GET');
    const models = r.models || [];
    panel.innerHTML = '';
    if (!models.length) { panel.append(el('div', { class: 'model-opt', style: 'cursor:default' }, el('span', { class: 'muted' }, '0 model via API. Gunakan daftar bawaan (input di atas) atau ketik manual.'))); return; }
    models.slice(0, 100).forEach(m => {
      const row = el('div', { class: 'model-opt' + (state.models[p] === m.id ? ' sel' : '') }, el('span', { class: 'mid' }, m.id), el('span', { class: 'mdisp' }, m.displayName || ''));
      row.onclick = () => { state.models[p] = m.id; $('#modelInput').value = m.id; $$('#modelList .model-opt').forEach(x => x.classList.remove('sel')); row.classList.add('sel'); updateRunSummary(); autoSave(); };
      panel.append(row);
    });
  } catch (e) { panel.innerHTML = ''; panel.append(el('div', { class: 'ping-row bad' }, 'Gagal load model: ' + e.message)); }
};
$('#modelInput').oninput = () => { state.models[state.provider] = $('#modelInput').value.trim(); updateRunSummary(); };

function applyParams() {
  const tv = state.temperature.toFixed(2), mv = Number(state.maxTokens).toLocaleString('en-US');
  ['editorTempVal', 'tempVal'].forEach(id => { const e = document.getElementById(id); if (e) e.textContent = tv; });
  ['editorMaxTokVal', 'maxTokVal'].forEach(id => { const e = document.getElementById(id); if (e) e.textContent = mv; });
  const tP = $('#temperature'), tE = $('#editorTemperature');
  if (tP) tP.value = state.temperature; if (tE) tE.value = state.temperature;
  const mP = $('#maxTokens'), mE = $('#editorMaxTokens');
  if (mP) mP.value = state.maxTokens; if (mE) mE.value = state.maxTokens;
}
$('#temperature').oninput = () => { state.temperature = +$('#temperature').value; applyParams(); };
$('#editorTemperature').oninput = () => { state.temperature = +$('#editorTemperature').value; applyParams(); };
$('#maxTokens').oninput = () => { state.maxTokens = +$('#maxTokens').value; applyParams(); };
$('#editorMaxTokens').oninput = () => { state.maxTokens = +$('#editorMaxTokens').value; applyParams(); };
$$('.preset').forEach(b => b.onclick = () => { state.maxTokens = +b.dataset.max; applyParams(); autoSave(); });
$('#cfAccountId').oninput = () => { state.cloudflare.accountId = $('#cfAccountId').value.trim(); autoSave(); };
$('#customBaseUrl').oninput = () => { state.custom.baseUrl = $('#customBaseUrl').value.trim(); autoSave(); };
$$('#customFormatTabs [data-cf]').forEach(b => b.onclick = () => { state.custom.format = b.dataset.cf; syncProviderUI(); autoSave(); });

/* ---------- system prompt ---------- */
async function loadDefaultPrompt() {
  try { const r = await fetch('prompts/INDONESIAN_TRANSLATION_EDITOR.md'); state.systemPrompt = await r.text(); $('#systemPrompt').value = state.systemPrompt; updatePromptMeta(); }
  catch { /* leave empty -> worker fallback */ }
}
function updatePromptMeta() { $('#promptChars').textContent = $('#systemPrompt').value.length.toLocaleString() + ' karakter'; }
$('#systemPrompt').oninput = () => { state.systemPrompt = $('#systemPrompt').value; updatePromptMeta(); };
$('#btnTogglePrompt').onclick = () => {
  const open = $('#systemPrompt').classList.toggle('hidden');
  $('#btnTogglePrompt').textContent = open ? 'Perinci' : 'Tutup';
  $('#promptSummary').classList.toggle('hidden', !open);
};
$('#btnReloadPrompt').onclick = loadDefaultPrompt;
$('#btnResetPrompt').onclick = () => { loadDefaultPrompt(); toast('System prompt di-reset ke bawaan'); };

/* ---------- run ---------- */
async function runEditor() {
  const p = state.provider;
  const model = $('#modelInput').value.trim();
  const keys = state.keys[p].map(k => k.value).filter(Boolean);
  const text = $('#txtPaste').value;
  if (!model) return toast('Pilih / isi model', 'err');
  const cfBindingMode = (p === 'cloudflare' && !state.cloudflare.accountId && keys.length === 0);
  if (!cfBindingMode && keys.length === 0) return toast('Tambahkan minimal 1 ' + PROVIDERS[p].keyLabel, 'err');
  if (p === 'custom' && !state.custom.baseUrl) return toast('Isi Base URL custom', 'err');
  if (!text.trim()) return toast('File terjemahan kosong', 'err');

  const btn = $('#btnRun'); btn.disabled = true;
  $('#runTimer').classList.remove('hidden'); $('#runTimer').textContent = 'Diproses…';
  const t0 = performance.now();
  let tick; tick = setInterval(() => { $('#runTimer').textContent = 'Diproses… ' + ((performance.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
  try {
    const body = {
      provider: p, model, keys,
      text, sourceText: $('#txtSource').value,
      systemPrompt: $('#systemPrompt').value,
      temperature: state.temperature, maxOutputTokens: state.maxTokens,
      strategy: 'round-robin',
    };
    if (p === 'cloudflare') body.cloudflare = { accountId: state.cloudflare.accountId };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/edit', body);
    state.lastResult = r.raw; state.lastRun = { provider: p, model, ms: Math.round(performance.now() - t0), usage: r.usage, keyUsed: r.keyUsed, keyCount: r.keyCount };
    renderResults(r.raw, state.lastRun);
    showView('results');
    toast('Selesai. ' + state.lastRun.keyCount + ' key, dipakai #' + (r.keyUsed + 1), 'ok');
  } catch (e) {
    toast('Gagal: ' + (e.message || e), 'err');
  } finally {
    clearInterval(tick); btn.disabled = false; $('#runTimer').classList.add('hidden');
    autoSave();
  }
}
$('#btnRun').onclick = runEditor;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runEditor(); }
});

/* ---------- result parsing ---------- */
function parseEntries(sectionText, labelsSet) {
  const lines = (sectionText || '').split('\n');
  const entries = []; let cur = null;
  const locRe = /^\s*\[([^\[\]]+)\]\s*$/;
  const labelRe = new RegExp('^(sebelum|sesudah|alasan|teks|masalah|saran)\\s*:\\s*(.*)$', 'i');
  const singleLabels = new Set(['sebelum', 'sesudah', 'alasan', 'teks', 'masalah', 'saran']);
  for (const raw of lines) {
    const loc = raw.match(locRe);
    if (loc && /p\s*\d+|baris/i.test(loc[1])) { if (cur) entries.push(cur); cur = { loc: loc[1].trim(), before: '', after: '', reason: '', teks: '', masalah: '', saran: '', _pend: null }; continue; }
    if (!cur) continue;
    const t = raw.trim();
    const inl = t.match(labelRe);
    if (inl) { const k = inl[1].toLowerCase(); cur[k === 'sebelum' ? 'before' : k === 'sesudah' ? 'after' : k === 'alasan' ? 'reason' : k === 'teks' ? 'teks' : k === 'masalah' ? 'masalah' : 'saran'] = inl[2]; cur._pend = null; continue; }
    for (const L of singleLabels) { if (new RegExp('^' + L + '\\s*:', 'i').test(t)) { cur._pend = L === 'sebelum' ? 'before' : L === 'sesudah' ? 'after' : L === 'alasan' ? 'reason' : L; continue; } }
    if (cur._pend && raw.length) cur[cur._pend] += (cur[cur._pend] ? '\n' : '') + raw;
  }
  if (cur) entries.push(cur);
  for (const e of entries) for (const k of Object.keys(e)) { if (typeof e[k] === 'string') e[k] = e[k].replace(/^["']|["']$/g, '').trim(); }
  return entries;
}

function splitSections(raw) {
  const s = String(raw || '').replace(/\r\n/g, '\n');
  const i2 = s.search(/BAGIAN\s*2/);
  const i3 = s.search(/BAGIAN\s*3/);
  const i1 = s.search(/BAGIAN\s*1/);
  const startHasil = i1 >= 0 ? i1 : 0;
  const hasilSec = s.slice(startHasil, i2 >= 0 ? i2 : s.length);
  const perubSec = i2 >= 0 ? s.slice(i2, i3 >= 0 ? i3 : s.length) : '';
  const dicekSec = i3 >= 0 ? s.slice(i3) : '';
  // extract HASIL content: prefer fenced block
  let hasilText = '';
  const fence = hasilSec.match(/```[^\n]*\n?([\s\S]*?)```/);
  if (fence) hasilText = fence[1].replace(/\s+$/, '');
  else {
    // strip the "BAGIAN 1 — HASIL" heading line and instructional prose before the file
    hasilText = hasilSec.replace(/^.*?BAGIAN\s*1[^\n]*\n/i, '');
    // if it still starts with instruction-like text, drop leading lines until first plausible file marker
    hasilText = hasilText.replace(/^\s*\n/, '');
  }
  return { hasilText, perubSec, dicekSec };
}

function renderResults(raw, run) {
  const { hasilText, perubSec, dicekSec } = splitSections(raw);
  // HASIL
  const hasChanges = !!hasilText;
  $('#resultHasil code').outerHTML = '<code>' + (hasChanges ? highlightResult(hasilText) : escapeHtml(raw || '(kosong)')) + '</code>';
  $('#cntHasil').textContent = hasChanges ? hasilText.split('\n').length : 0;
  $('#hasilNote').textContent = hasChanges ? '' : 'Tiga bagian tidak dikenali. Lihat tab “Raw” untuk output mentah.';
  // PERUBAHAN
  let perub = parseEntries(perubSec, null).filter(e => e.loc);
  const perubEmpty = /tidak ada perubahan/i.test(perubSec);
  renderCards($('#resultPerubahan'), perub, perubEmpty, 'perubahan');
  $('#cntPerubahan').textContent = perubEmpty ? 0 : perub.length;
  // PERLU DICEK
  let dicek = parseEntries(dicekSec, null).filter(e => e.loc);
  const dicekEmpty = /tidak ada/i.test(dicekSec.trim()) && dicekSec.trim().length < 40;
  renderCards($('#resultDicek'), dicek, dicekEmpty, 'dicek');
  $('#cntDicek').textContent = dicekEmpty ? 0 : dicek.length;
  // RAW
  $('#resultRaw').textContent = raw || '';
  $('#cntRaw').textContent = raw ? raw.split('\n').length : 0;
  // meta
  $('#runMeta').innerHTML = '';
  const m = $('#runMeta');
  m.append(
    tag('Provider: ' + run.provider + ' · ' + run.model),
    tag(run.ms + ' ms'),
    tag('Key dipakai #' + (run.keyUsed + 1) + ' / ' + run.keyCount),
    run.usage ? tag('tok in ' + (run.usage.promptTokenCount || run.usage.promptTokens || run.usage.prompt_tokens || '–')
      + ' · out ' + (run.usage.candidatesTokenCount || run.usage.outputTokens || run.usage.completionTokens || run.usage.completion_tokens || '–')) : null,
  );
  window._hasilText = hasilText; window._rawAll = raw;
}
function tag(t) { const s = el('span', { class: 'tag' }, t); return s; }

function renderCards(container, entries, isEmpty, kind) {
  container.innerHTML = '';
  if (isEmpty) { container.append(el('div', { class: 'empty' }, kind === 'dicek' ? 'Tidak ada bagian yang perlu dicek.' : 'Tidak ada perubahan.')); return; }
  if (!entries.length) { container.append(el('div', { class: 'empty' }, 'Format bagian tidak dikenali — lihat tab “Raw”.')); return; }
  entries.forEach(e => {
    if (kind === 'perubahan') {
      const c = el('div', { class: 'ccard' },
        el('div', { class: 'loc' }, '[' + e.loc + ']'),
        e.before ? el('div', {}, el('div', { class: 'lbl' }, 'Sebelum'), el('div', { class: 'before' }, e.before)) : null,
        e.after ? el('div', {}, el('div', { class: 'lbl' }, 'Sesudah'), el('div', { class: 'after' }, e.after)) : null,
        e.reason ? el('div', { class: 'reason' }, 'Alasan: ' + e.reason) : null,
      );
      container.append(c);
    } else {
      const c = el('div', { class: 'ccard warn' },
        el('div', { class: 'loc' }, '[' + e.loc + ']'),
        e.teks ? el('div', {}, el('div', { class: 'lbl' }, 'Teks'), el('div', { class: 'body-text' }, e.teks)) : null,
        e.masalah ? el('div', {}, el('div', { class: 'lbl' }, 'Masalah'), el('div', { class: 'reason' }, e.masalah)) : null,
        e.saran ? el('div', {}, el('div', { class: 'lbl' }, 'Saran'), el('div', { class: 'reason' }, e.saran)) : null,
      );
      container.append(c);
    }
  });
}
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function highlightResult(text) {
  // Highlight changed lines vs the original source (heuristic, index-aligned).
  const show = $('#diffMode').checked;
  const src = $('#txtPaste').value.split('\n');
  const lines = text.split('\n');
  let html = '';
  lines.forEach((ln, i) => {
    const changed = show && (i >= src.length || src[i] !== ln);
    const safe = escapeHtml(ln);
    html += '<span class="ln' + (changed ? ' changed' : '') + '">' + (safe || ' ') + '</span>';
  });
  return html;
}

/* ---------- copy / download ---------- */
$('#btnCopyResult').onclick = async () => {
  const txt = window._hasilText || state.lastResult;
  if (!txt) return toast('Belum ada hasil', 'err');
  try { await navigator.clipboard.writeText(txt); toast('Hasil disalin ke clipboard', 'ok'); }
  catch { window.prompt('Salin manual:', txt); }
};
function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#btnDownloadResult').onclick = () => { if (window._hasilText) download('hasil-terjemahan.txt', window._hasilText); else toast('Belum ada hasil', 'err'); };
$('#btnDownloadAll').onclick = () => { if (state.lastResult) download('hasil-3-bagian.txt', state.lastResult); };
$$('[data-res]').forEach(b => b.onclick = () => showResTab(b.dataset.res));
function showResTab(name) {
  $$('.res-tab').forEach(x => x.classList.toggle('active', x.dataset.res === name));
  $$('.res-pane').forEach(x => x.classList.toggle('hidden', x.dataset.res !== name));
}
$('#diffMode').onchange = () => { if (window._hasilText) renderResults(state.lastResult, state.lastRun); };

/* ---------- views / rail ---------- */
function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  const map = { editor: 'view-editor', results: 'view-results', provider: 'view-provider', guide: 'view-guide', security: 'view-security' };
  const t = document.getElementById(map[name]); if (t) t.classList.remove('hidden');
  $$('.rail-item').forEach(r => r.classList.toggle('active', r.dataset.view === name));
}
$$('.rail-item').forEach(r => r.onclick = () => showView(r.dataset.view));
const _btnToProvider = $('#btnToProvider'); if (_btnToProvider) _btnToProvider.onclick = () => showView('provider');
$('#diffMode').checked = false;

/* ---------- settings modal ---------- */
$('#btnSettings').onclick = () => {
  $('#workerUrl').value = state.settings.workerUrl;
  $('#gatewaySecretInput').value = state.settings.gatewaySecret;
  $('#modal').classList.remove('hidden');
};
$('#modalClose').onclick = $('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
$('#modalSave').onclick = () => {
  const wu = $('#workerUrl').value.trim();
  if (wu && !/^https?:\/\//.test(wu)) { wu = 'https://' + wu.replace(/^\/+/, ''); }
  state.settings.workerUrl = wu.replace(/\/$/, '');
  state.settings.gatewaySecret = $('#gatewaySecretInput').value.trim();
  autoSave(); $('#modal').classList.add('hidden'); checkWorkerStatus(); toast('Pengaturan disimpan', 'ok');
};
$('#btnCheckConn').onclick = async () => {
  state.settings.workerUrl = $('#workerUrl').value.trim().replace(/\/$/, '');
  state.settings.gatewaySecret = $('#gatewaySecretInput').value.trim();
  try { await apiCall('/api/health'); toast('Koneksi ke Worker berhasil ✔', 'ok'); } catch (e) { toast('Gagal: ' + e.message, 'err'); }
};

/* ---------- security view ---------- */
function updateSecChecklist() {
  const items = [
    ['HTTPS-only', /https:/.test(location.protocol)],
    ['Key multi per-provider', true],
    ['Vault terenkripsi (AES-GCM + PBKDF2)', state.storageMode === 'device' ? state.unlocked : false],
    ['Plaintext hanya di memori', true],
    ['Gateway Secret dipakai', !!state.settings.gatewaySecret],
    ['Worker tercapai', true],
  ];
  const ul = $('#secChecklist'); ul.innerHTML = '';
  items.forEach(([label, ok]) => ul.append(el('li', {}, (ok ? '✓ ' : '○ ') + label)));
  $('#vaultState').textContent = state.storageMode === 'device' ? (state.unlocked ? 'dibuka' : 'terkunci') : (sessionStorage.getItem('tl.session') ? 'hanya sesi' : 'tidak disimpan');
}
$('#btnLock').onclick = () => {
  _aesKey = null;
  for (const p of PROVIDER_IDS) state.keys[p].forEach(k => { k.value = ''; k.shown = false; });
  // keep encrypted vault on disk (device mode); clear session plaintext
  sessionStorage.removeItem('tl.session');
  state.unlocked = false;
  renderKeys(); updateSecChecklist(); showView('security');
  toast('Key dikunci. Buka lagi lewat panel Keamanan.');
};
$('#btnWipeVault').onclick = () => {
  if (!confirm('Hapus SEMUA API key dan kunci vault?')) return;
  localStorage.removeItem('tl.vault.data'); localStorage.removeItem('tl.vault.meta');
  sessionStorage.removeItem('tl.session');
  for (const p of PROVIDER_IDS) state.keys[p] = [];
  _aesKey = null; state.unlocked = false;
  renderKeys(); updateSecChecklist(); toast('Semua key dihapus');
};
$$('#storageMode [data-mode]').forEach(b => b.onclick = () => {
  $$('#storageMode [data-mode]').forEach(x => x.classList.remove('active')); b.classList.add('active');
  state.storageMode = b.dataset.mode;
  if (state.storageMode === 'session') { sessionStorage.setItem('tl.session', JSON.stringify(collectVaultPayload())); localStorage.removeItem('tl.vault.data'); localStorage.removeItem('tl.vault.meta'); _aesKey = null; }
  updateSecChecklist();
});
$('#btnUnlock').onclick = async () => {
  try { await unlockVault($('#unlockPass').value); renderKeys(); updateSecChecklist(); toast('Vault dibuka', 'ok'); $('#unlockPass').value = ''; }
  catch (e) { toast('Passphrase salah / vault rusak: ' + e.message, 'err'); }
};
$('#btnRotateSecret').onclick = () => {
  const v = prompt('Gateway Secret baru (kosongkan untuk menghapus):');
  if (v != null) { state.settings.gatewaySecret = v.trim(); autoSave(); updateSecChecklist(); toast('Secret diperbarui'); }
};

/* ---------- first-use passphrase prompt ---------- */
async function maybePromptPass() {
  if (state.unlocked || state.storageMode === 'session' && sessionStorage.getItem('tl.session')) return;
  // choose mode
  const useSession = confirm('Simpan API key di perangkat ini?\n\nOK = terenkripsi (AES-GCM, passphrase, localStorage)\nBatal = hanya sesi ini (jangan simpan ke browser)');
  if (useSession) {
    state.storageMode = 'session'; state.unlocked = true;
    sessionStorage.setItem('tl.session', JSON.stringify(collectVaultPayload()));
    return;
  }
  // device: need passphrase
  await new Promise(res => { $('#passModal').classList.remove('hidden'); $('#passModal')._res = res; });
  const p1 = $('#pass1').value, p2 = $('#pass2').value;
  if (p1.length < 8) { toast('Passphrase minimal 8 karakter', 'err'); $('#passModal').classList.remove('hidden'); return; }
  if (p1 !== p2) { toast('Konfirmasi passphrase tidak cocok', 'err'); $('#passModal').classList.remove('hidden'); return; }
  await createVault(p1);
  $('#passModal').classList.add('hidden');
}
$('#passCreate').onclick = async () => {
  const p1 = $('#pass1').value, p2 = $('#pass2').value;
  if (p1.length < 8) return toast('Passphrase minimal 8 karakter', 'err');
  if (p1 !== p2) return toast('Konfirmasi tidak cocok', 'err');
  await createVault(p1); $('#passModal').classList.add('hidden'); renderKeys(); updateSecChecklist(); toast('Vault dikunci & disimpan', 'ok');
  if ($('#passModal')._res) { $('#passModal')._res(); $('#passModal')._res = null; }
};
$('#passSkip').onclick = () => {
  state.storageMode = 'session'; state.unlocked = true;
  sessionStorage.setItem('tl.session', JSON.stringify(collectVaultPayload()));
  $('#passModal').classList.add('hidden');
  if ($('#passModal')._res) { $('#passModal')._res(); $('#passModal')._res = null; }
};

/* ---------- init ---------- */
(async function init() {
  renderProviderTiles();
  renderKeys();
  renderModelSelect();
  applyParams();
  updateSourceStats();
  updatePromptMeta();
  showView('editor');
  updateSecChecklist();
  checkWorkerStatus();

  // load persisted state
  const meta = localStorage.getItem('tl.vault.meta');
  if (meta) {
    state.storageMode = 'device';
    $('#vaultUnlockWrap').classList.remove('hidden');
    $('#storageMode [data-mode="device"]').classList.add('active');
    $('#unlockPass').focus();
  } else {
    const sess = sessionStorage.getItem('tl.session');
    if (sess) {
      state.storageMode = 'session'; state.unlocked = true;
      applyVaultPayload(JSON.parse(sess));
      $$('#storageMode [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === 'session'));
    }
  }
  if (state.storageMode === 'session') { renderKeys(); renderModelSelect(); syncProviderUI(); }
  loadDefaultPrompt();
})();
})();
