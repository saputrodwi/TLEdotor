/* ============================================================
   TL Editor — frontend logic (Ocrku-style compact 2-tab)
   Sunting tab: input + run bar + results (inline)
   Pengaturan tab: provider, keys, model, prompt, security
   Cloudflare Pages (static) -> Pages Function -> Worker
   Default: Cloudflare [ai] binding (no key, no token).
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

/* ---------- provider catalog ---------- */
const PROVIDERS = {
  gemini: {
    label: 'Gemini', icon: 'G', tag: 'Gemini 3.5 Flash Lite',
    keyLabel: 'Gemini API Key', multiKey: true,
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-live', 'gemini-3.8-flash-lite-tts'],
    keyHint: 'Mulai dengan AIza…',
    keyRe: /^[A-Za-z0-9_\-./+]{8,}$/
  },
  default: {
    label: 'Default', icon: 'D', tag: '',
    keyLabel: '', multiKey: false, serverKey: true,
    models: ['agnes-2.5-flash', 'agnes-2.0-flash', 'agnes-3.0-flash'],
    modelLabels: { 'agnes-2.5-flash': 'Model B', 'agnes-2.0-flash': 'Model A', 'agnes-3.0-flash': 'Model C' },
    keyHint: 'Kunci di server. Tanpa input.',
    keyRe: null
  },
  sumopod: {
    label: 'Sumopod', icon: 'S', tag: 'ai.sumopod.com',
    keyLabel: 'Sumopod API Key', multiKey: true,
    models: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat'],
    keyHint: 'Base https://ai.sumopod.com/v1',
    keyRe: /^[A-Za-z0-9_\-]{8,}$/
  },
  custom: {
    label: 'Custom', icon: 'C', tag: 'OpenAI-compatible',
    keyLabel: 'API Key', multiKey: true, needsUrl: true,
    models: [],
    keyHint: 'Isi Base URL + model. Format OpenAI (default) atau Gemini.',
    keyRe: /^[A-Za-z0-9_\-/.+]{6,}$/
  },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

/* ---------- state ---------- */
const state = {
  provider: 'default',
  keys: { gemini: [], default: [], sumopod: [], custom: [] },
  models: { default: 'agnes-2.5-flash' },
  temperature: 0.2,
  maxTokens: 8192,
  custom: { baseUrl: '', format: 'openai' },
  storageMode: 'device',
  unlocked: false,
  systemPrompt: '',
  lastResult: null,
  lastRun: null,
};
let _aesKey = null;
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
    custom: state.custom,
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
  if (p.custom) state.custom = p.custom;
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

/* ---------- tab switching ---------- */
function switchView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  const target = document.getElementById('view-' + name);
  if (target) target.classList.remove('hidden');
  $$('.tab-item').forEach(t => t.classList.toggle('active', t.dataset.view === name));
}
$$('.tab-item').forEach(t => t.onclick = () => switchView(t.dataset.view));
$('#btnToSettings').onclick = () => switchView('pengaturan');
$('#btnBackSunting').onclick = () => switchView('sunting');

/* ---------- provider tiles ---------- */
function renderProviderTiles() {
  const wrap = $('#providerTiles'); wrap.innerHTML = '';
  PROVIDER_IDS.forEach(id => {
    const p = PROVIDERS[id];
    const active = state.provider === id;
    const b = el('button', { class: 'ptile' + (active ? ' active' : ''), title: p.keyHint },
      el('span', { class: 'pico' }, p.icon),
      el('span', { class: 'pname' }, p.label),
      el('span', { class: 'ptag' }, p.tag),
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
  $('#customWrap').classList.toggle('hidden', state.provider !== 'custom');
  $('#customBaseUrl').value = state.custom.baseUrl;
  $$('#customFormatTabs [data-cf]').forEach(b => b.classList.toggle('active', b.dataset.cf === state.custom.format));
  $('#provKeyLabel').textContent = p.label;
  $('#runProviderLabel').textContent = p.label;
  if (p.serverKey) {
    $('#keyEncryptionNote').textContent = 'Kunci di server. Tanpa input.';
  } else {
    $('#keyEncryptionNote').textContent = p.keyLabel + ' • terenkripsi (AES-GCM), hanya di perangkat.';
  }
}

/* ---------- model select ---------- */
function renderModelSelect() {
  const p = PROVIDERS[state.provider];
  const popup = $('#modelPopup'); popup.innerHTML = '';
  const trigger = $('#modelTrigger');
  (p.models || []).forEach(m => {
    const label = (p.modelLabels && p.modelLabels[m]) || m;
    const opt = el('button', { class: 'mopt' + (state.models[state.provider] === m ? ' sel' : '') }, label);
    opt.onclick = (e) => {
      e.stopPropagation();
      state.models[state.provider] = m;
      trigger.textContent = label;
      $$('#modelPopup .mopt').forEach(x => x.classList.remove('sel'));
      opt.classList.add('sel');
      popup.classList.add('hidden');
      autoSave();
    };
    popup.append(opt);
  });
  if (!state.models[state.provider]) state.models[state.provider] = p.models[0] || '';
  const cur = p.modelLabels && p.modelLabels[state.models[state.provider]] ? p.modelLabels[state.models[state.provider]] : state.models[state.provider];
  trigger.textContent = cur || '— pilih model —';
}
$('#modelTrigger').onclick = (e) => {
  e.stopPropagation();
  $('#modelPopup').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  const popup = $('#modelPopup');
  if (popup && !popup.classList.contains('hidden') && !e.target.closest('.rb-model')) popup.classList.add('hidden');
});

/* ---------- keys UI ---------- */
function renderKeys() {
  const list = $('#kunciList'); list.innerHTML = '';
  const keys = state.keys[state.provider];
  const p = PROVIDERS[state.provider];
  $('#keyCount').textContent = keys.filter(k => k.value).length + ' aktif';
  if (state.storageMode === 'device' && !state.unlocked && localStorage.getItem('tl.vault.data')) {
    const b = el('button', { class: 'ghost-btn', style: 'width:100%;padding:8px' }, 'Terkunci — ' + keys.length + ' kunci tersimpan. Buka kunci di bawah.');
    b.onclick = () => { switchView('pengaturan'); setTimeout(() => $('#unlockPass').focus(), 60); };
    list.append(el('div', { class: 'key-item' }, el('span', { class: 'kdot' }), b));
    updateSecChecklist();
    return;
  }
  if (keys.length === 0) {
    const msg = p.serverKey
      ? 'Kunci di server (Worker). Tanpa input. Langsung pakai.'
      : 'Belum ada kunci untuk ' + p.label + '. Klik "+ Tambah kunci".';
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

/* ---------- API (same-origin, no gateway secret) ---------- */
async function apiCall(path, body, method = 'POST') {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Tidak bisa menjangkau Worker. (' + e.message + ')');
  }
  let data; try { data = await res.json(); } catch { data = { ok: false, code: 'BAD_RESPONSE', message: 'Respon bukan JSON' }; }
  if (!res.ok) { const e = new Error(data.message || ('HTTP ' + res.status)); e.code = data.code; e.status = res.status; throw e; }
  return data;
}

$('#btnPingAll').onclick = async () => {
  const keys = state.keys[state.provider].map(k => k.value).filter(Boolean);
  const p = state.provider;
  const serverKey = PROVIDERS[p].serverKey;
  if (!serverKey && !keys.length) return toast('Tambahkan key dulu.', 'err');
  const box = $('#pingResults'); box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">' + (serverKey ? 'Menguji server key…' : 'Menguji ' + keys.length + ' key…') + '</div>';
  try {
    const body = { provider: p, model: PROVIDERS[p].models[0] || '', keys };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/ping', body);
    box.innerHTML = '';
    if (serverKey) {
      box.append(el('div', { class: 'ping-row ok' }, el('span', {}, 'Server key'), el('span', {}, r.ok ? 'OK' : 'Gagal — ' + (r.message || ''))));
    } else {
      r.results.forEach(row => {
        box.append(el('div', { class: 'ping-row ' + (row.ok ? 'ok' : 'bad') },
          el('span', {}, 'Kunci ' + (row.index + 1)), el('span', {}, row.ok ? 'OK' : 'Gagal — ' + (row.detail || row.code))));
      });
    }
  } catch (e) { box.innerHTML = ''; box.append(el('div', { class: 'ping-row bad' }, 'Gagal: ' + e.message)); }
};

function checkWorkerStatus() {
  apiCall('/api/health', null, 'GET').catch(() => {});
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
  const g = $('#lineGutter');
  if (!on) { g.style.visibility = 'hidden'; g.innerHTML = ''; return; }
  g.style.visibility = 'visible';
  const n = $('#txtPaste').value.split('\n').length;
  let s = ''; for (let i = 1; i <= n; i++) s += String(i).padStart(2, '0');
  g.textContent = s;
}
$('#txtPaste').addEventListener('input', updateSourceStats);
$('#lineNumbers').onchange = updateLineNumbers;
$('#txtPaste').addEventListener('scroll', () => { $('#lineGutter').scrollTop = $('#txtPaste').scrollTop; });

function normalizeText(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+(\n)/g, '$1');
}
$('#btnNormalize').onclick = () => { const t = normalizeText($('#txtPaste').value); $('#txtPaste').value = t; updateSourceStats(); toast('Dinormalisasi', 'ok'); };
$('#btnClearSource').onclick = () => { $('#txtPaste').value = ''; $('#txtSource').value = ''; updateSourceStats(); };
$('#btnSample').onclick = async () => {
  try { const r = await fetch('prompts/SAMPLE_CH121.txt'); $('#txtPaste').value = await r.text(); updateSourceStats(); toast('Contoh naskah dimuat', 'ok'); }
  catch { toast('Gagal memuat contoh', 'err'); }
};

/* file button always visible — no seg-tabs */
$('#btnChooseFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async (e) => {
  const files = e.target.files;
  if (!files || !files.length) return;
  const f = files[0];
  const txt = await f.text();
  $('#txtPaste').value = txt; updateSourceStats();
  toast('File "' + f.name + '" dimuat (' + f.size.toLocaleString() + ' bytes)', 'ok');
  e.target.value = '';
};
// drag & drop
const srcArea = $('#srcArea');
['dragover', 'drop'].forEach(ev => srcArea.addEventListener(ev, e => e.preventDefault()));
srcArea.addEventListener('drop', async e => {
  const f = e.dataTransfer.files?.[0]; if (!f) return;
  if (!/\.txt$|text\/plain/i.test(f.name)) return toast('Hanya file .txt', 'err');
  const txt = await f.text();
  $('#txtPaste').value = txt; updateSourceStats();
  toast('Dimuat: ' + f.name, 'ok');
});

/* ---------- model loading ---------- */
$('#btnLoadModels').onclick = async () => {
  const p = state.provider;
  const keys = state.keys[p].map(k => k.value).filter(Boolean);
  const serverKey = PROVIDERS[p].serverKey;
  const panel = $('#modelList');
  if (!serverKey && keys.length === 0) return toast('Isi minimal 1 kunci untuk load model ' + PROVIDERS[p].label, 'err');
  panel.innerHTML = '';
  panel.append(el('div', { class: 'model-opt', style: 'cursor:default' }, el('span', { class: 'muted' }, 'Memuat daftar ' + PROVIDERS[p].label + '…')));
  try {
    let qs = '/api/models?provider=' + encodeURIComponent(p) + '&keys=' + encodeURIComponent(JSON.stringify(keys));
    if (p === 'custom') qs += '&cust=' + encodeURIComponent(JSON.stringify({ baseUrl: state.custom.baseUrl, format: state.custom.format }));
    const r = await apiCall(qs, null, 'GET');
    const models = r.models || [];
    panel.innerHTML = '';
    if (!models.length) { panel.append(el('div', { class: 'model-opt', style: 'cursor:default' }, el('span', { class: 'muted' }, serverKey ? 'Pakai daftar di dropdown.' : '0 model via API.'))); return; }
    models.slice(0, 100).forEach(m => {
      const trigger = $('#modelTrigger');
      const label = (PROVIDERS[p].modelLabels && PROVIDERS[p].modelLabels[m.id]) || m.id;
      if (!$('#modelPopup').querySelector('.mopt[data-mid="' + m.id + '"]')) {
        const opt = el('button', { class: 'mopt' + (state.models[p] === m.id ? ' sel' : ''), 'data-mid': m.id }, label);
        opt.onclick = (e) => {
          e.stopPropagation();
          state.models[p] = m.id;
          trigger.textContent = label;
          $$('#modelPopup .mopt').forEach(x => x.classList.remove('sel'));
          opt.classList.add('sel');
          $('#modelPopup').classList.add('hidden');
          autoSave();
        };
        $('#modelPopup').append(opt);
      }
      panel.append(el('div', { class: 'model-opt' + (state.models[p] === m.id ? ' sel' : '') }, el('span', { class: 'mid' }, m.id), el('span', { class: 'mdisp' }, m.displayName || '')));
    });
  } catch (e) { panel.innerHTML = ''; panel.append(el('div', { class: 'ping-row bad' }, 'Gagal load model: ' + e.message)); }
};
$('#modelTrigger').onclick = (e) => {
  e.stopPropagation();
  $('#modelPopup').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  const popup = $('#modelPopup');
  if (popup && !popup.classList.contains('hidden') && !e.target.closest('.rb-model')) popup.classList.add('hidden');
});

/* ---------- params ---------- */
$('#temperature').oninput = () => { state.temperature = +$('#temperature').value; $('#tempVal').textContent = state.temperature.toFixed(2); };
$('#maxTokens').oninput = () => { state.maxTokens = +$('#maxTokens').value; };

$('#customBaseUrl').oninput = () => { state.custom.baseUrl = $('#customBaseUrl').value.trim(); autoSave(); };
$$('#customFormatTabs [data-cf]').forEach(b => b.onclick = () => { state.custom.format = b.dataset.cf; syncProviderUI(); autoSave(); });

function applyParams() {
  $('#temperature').value = state.temperature;
  $('#tempVal').textContent = state.temperature.toFixed(2);
  $('#maxTokens').value = state.maxTokens;
}

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
$('#btnResetPrompt').onclick = () => { loadDefaultPrompt(); toast('System prompt di-reset ke bawaan', 'ok'); };

/* ---------- run ---------- */
async function runEditor() {
  const p = state.provider;
  const model = state.models[state.provider] || '';
  const keys = state.keys[p].map(k => k.value).filter(Boolean);
  const text = $('#txtPaste').value;
  if (!model) return toast('Pilih model', 'err');
  const serverKey = PROVIDERS[p].serverKey;
  if (!serverKey && keys.length === 0) return toast('Tambahkan minimal 1 ' + PROVIDERS[p].keyLabel, 'err');
  if (p === 'custom' && !state.custom.baseUrl) return toast('Isi Base URL custom', 'err');
  if (!text.trim()) return toast('File terjemahan kosong', 'err');

  const btn = $('#btnRun'); btn.disabled = true;
  const t0 = performance.now();
  try {
    const body = {
      provider: p, model, keys,
      text, sourceText: $('#txtSource').value,
      systemPrompt: $('#systemPrompt').value,
      temperature: state.temperature, maxOutputTokens: state.maxTokens,
      strategy: 'round-robin',
    };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/edit', body);
    state.lastResult = r.raw;
    state.lastRun = { provider: p, model, ms: Math.round(performance.now() - t0), usage: r.usage, keyUsed: r.keyUsed, keyCount: r.keyCount };
    renderResults(r.raw, state.lastRun);
    toast('Selesai (' + state.lastRun.ms + ' ms)', 'ok');
  } catch (e) {
    toast('Gagal: ' + (e.message || e), 'err');
  } finally {
    btn.disabled = false;
    autoSave();
  }
}
$('#btnRun').onclick = runEditor;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runEditor(); }
});

/* ---------- result parsing ---------- */
function parseEntries(sectionText) {
  const lines = (sectionText || '').split('\n');
  const entries = []; let cur = null;
  const locRe = /^\s*\[([^\[\]]+)\]\s*$/;
  const labelRe = /^(sebelum|sesudah|alasan|teks|masalah|saran)\s*:\s*(.*)$/i;
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
  const i2 = s.search(/BAGIAN\s*2/i);
  const i3 = s.search(/BAGIAN\s*3/i);
  const i1 = s.search(/BAGIAN\s*1/i);
  const startHasil = i1 >= 0 ? i1 : 0;
  const hasilSec = s.slice(startHasil, i2 >= 0 ? i2 : s.length);
  const perubSec = i2 >= 0 ? s.slice(i2, i3 >= 0 ? i3 : s.length) : '';
  const dicekSec = i3 >= 0 ? s.slice(i3) : '';
  let hasilText = '';
  const fence = hasilSec.match(/```[^\n]*\n?([\s\S]*?)```/);
  if (fence) hasilText = fence[1].replace(/\s+$/, '');
  else {
    hasilText = hasilSec.replace(/^.*?BAGIAN\s*1[^\n]*\n/i, '');
    hasilText = hasilText.replace(/^\s*\n/, '');
  }
  return { hasilText, perubSec, dicekSec };
}

function renderResults(raw, run) {
  const resultsCard = $('#resultsCard');
  if (resultsCard) resultsCard.classList.remove('hidden');
  const { hasilText, perubSec, dicekSec } = splitSections(raw);
  const hasChanges = !!hasilText;
  const pre = $('#resultHasil');
  pre.innerHTML = '<code' + (hasChanges ? '' : ' class="placeholder"') + '>' + (hasChanges ? highlightResult(hasilText) : escapeHtml(raw || '(kosong)')) + '</code>';
  $('#cntHasil').textContent = hasChanges ? hasilText.split('\n').length : 0;
  $('#hasilNote').textContent = hasChanges ? '' : 'Tiga bagian tidak dikenali. Lihat tab Raw.';
  const resActions = $('#resActions');
  if (resActions) resActions.classList.remove('hidden');
  let perub = parseEntries(perubSec).filter(e => e.loc);
  const perubEmpty = /tidak ada perubahan/i.test(perubSec);
  renderCards($('#resultPerubahan'), perub, perubEmpty, 'perubahan');
  $('#cntPerubahan').textContent = perubEmpty ? 0 : perub.length;
  let dicek = parseEntries(dicekSec).filter(e => e.loc);
  const dicekEmpty = /tidak ada/i.test(dicekSec.trim()) && dicekSec.trim().length < 40;
  renderCards($('#resultDicek'), dicek, dicekEmpty, 'dicek');
  $('#cntDicek').textContent = dicekEmpty ? 0 : dicek.length;
  $('#resultRaw').textContent = raw || '';
  $('#cntRaw').textContent = raw ? raw.split('\n').length : '—';
  const m = $('#runMeta'); m.innerHTML = '';
  window._hasilText = hasilText; window._rawAll = raw;
}
function mkTag(t) { return el('span', { class: 'tag' }, t); }

function renderCards(container, entries, isEmpty, kind) {
  container.innerHTML = '';
  if (isEmpty) { container.append(el('div', { class: 'empty' }, kind === 'dicek' ? 'Tidak ada bagian yang perlu dicek.' : 'Tidak ada perubahan.')); return; }
  if (!entries.length) { container.append(el('div', { class: 'empty' }, 'Format bagian tidak dikenali — lihat tab Raw.')); return; }
  entries.forEach(e => {
    if (kind === 'perubahan') {
      container.append(el('div', { class: 'ccard' },
        el('div', { class: 'loc' }, '[' + e.loc + ']'),
        e.before ? el('div', {}, el('div', { class: 'lbl' }, 'Sebelum'), el('div', { class: 'before' }, e.before)) : null,
        e.after ? el('div', {}, el('div', { class: 'lbl' }, 'Sesudah'), el('div', { class: 'after' }, e.after)) : null,
        e.reason ? el('div', { class: 'reason' }, 'Alasan: ' + e.reason) : null,
      ));
    } else {
      container.append(el('div', { class: 'ccard warn' },
        el('div', { class: 'loc' }, '[' + e.loc + ']'),
        e.teks ? el('div', {}, el('div', { class: 'lbl' }, 'Teks'), el('div', { class: 'body-text' }, e.teks)) : null,
        e.masalah ? el('div', {}, el('div', { class: 'lbl' }, 'Masalah'), el('div', { class: 'reason' }, e.masalah)) : null,
        e.saran ? el('div', {}, el('div', { class: 'lbl' }, 'Saran'), el('div', { class: 'reason' }, e.saran)) : null,
      ));
    }
  });
}
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function highlightResult(text) {
  const show = $('#diffMode').checked;
  const src = $('#txtPaste').value.split('\n');
  const lines = text.split('\n');
  let html = '';
  lines.forEach((ln, i) => {
    const changed = show && (i >= src.length || src[i] !== ln);
    html += '<span class="ln' + (changed ? ' changed' : '') + '">' + (escapeHtml(ln) || ' ') + '</span>';
  });
  return html;
}

/* ---------- copy / download ---------- */
$('#btnCopyResult').onclick = async () => {
  const txt = window._hasilText || state.lastResult;
  if (!txt) return toast('Belum ada hasil', 'err');
  try { await navigator.clipboard.writeText(txt); toast('Hasil disalin', 'ok'); }
  catch { window.prompt('Salin manual:', txt); }
};
function download(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#btnDownloadResult').onclick = () => { if (window._hasilText) download('hasil-terjemahan.txt', window._hasilText); else toast('Belum ada hasil', 'err'); };

/* result sub-tabs */
$$('.res-tab').forEach(b => b.onclick = () => showResTab(b.dataset.res));
function showResTab(name) {
  $$('.res-tab').forEach(x => x.classList.toggle('active', x.dataset.res === name));
  $$('.res-pane').forEach(x => x.classList.toggle('hidden', x.dataset.res !== name));
}
$('#diffMode').onchange = () => { if (window._hasilText) renderResults(state.lastResult, state.lastRun); };

/* ---------- security ---------- */
function updateSecChecklist() {
  const items = [
    ['HTTPS-only', /https:/.test(location.protocol)],
    ['Key multi per-provider', true],
    ['Vault terenkripsi (AES-GCM + PBKDF2)', state.storageMode === 'device' ? state.unlocked : false],
    ['Plaintext hanya di memori', true],
    ['[ai] binding Worker (Cloudflare)', false],
  ];
  const ul = $('#secChecklist'); ul.innerHTML = '';
  items.forEach(([label, ok]) => ul.append(el('li', {}, (ok ? '\u2713 ' : '\u25cb ') + label)));
  $('#vaultState').textContent = state.storageMode === 'device' ? (state.unlocked ? 'dibuka' : 'terkunci') : 'hanya sesi';
}
$('#btnLock').onclick = () => {
  _aesKey = null;
  for (const p of PROVIDER_IDS) state.keys[p].forEach(k => { k.value = ''; k.shown = false; });
  sessionStorage.removeItem('tl.session');
  state.unlocked = false;
  renderKeys(); updateSecChecklist();
  toast('Key dikunci dari memori');
};
$('#btnWipeVault').onclick = () => {
  if (!confirm('Hapus SEMUA API key dan vault?')) return;
  localStorage.removeItem('tl.vault.data'); localStorage.removeItem('tl.vault.meta');
  sessionStorage.removeItem('tl.session');
  for (const p of PROVIDER_IDS) state.keys[p] = [];
  _aesKey = null; state.unlocked = false;
  renderKeys(); updateSecChecklist(); toast('Semua key dihapus');
};
$$('#storageMode [data-mode]').forEach(b => b.onclick = () => {
  $$('#storageMode [data-mode]').forEach(x => x.classList.remove('active')); b.classList.add('active');
  state.storageMode = b.dataset.mode;
  if (state.storageMode === 'session') {
    sessionStorage.setItem('tl.session', JSON.stringify(collectVaultPayload()));
    localStorage.removeItem('tl.vault.data'); localStorage.removeItem('tl.vault.meta');
    _aesKey = null;
  }
  updateSecChecklist();
});
$('#btnUnlock').onclick = async () => {
  try { await unlockVault($('#unlockPass').value); renderKeys(); updateSecChecklist(); toast('Vault dibuka', 'ok'); $('#unlockPass').value = ''; }
  catch (e) { toast('Passphrase salah / vault rusak: ' + e.message, 'err'); }
};

/* ---------- first-use passphrase ---------- */
async function maybePromptPass() {
  if (state.unlocked) return;
  if (state.storageMode === 'session' && sessionStorage.getItem('tl.session')) return;
  const useSession = confirm('Simpan API key di perangkat ini?\n\nOK = terenkripsi (AES-GCM, passphrase, localStorage)\nBatal = hanya sesi ini (jangan simpan ke browser)');
  if (useSession) {
    state.storageMode = 'session'; state.unlocked = true;
    sessionStorage.setItem('tl.session', JSON.stringify(collectVaultPayload()));
    return;
  }
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
  switchView('sunting');
  updateSecChecklist();
  checkWorkerStatus();

  const meta = localStorage.getItem('tl.vault.meta');
  if (meta) {
    state.storageMode = 'device';
    $$('#storageMode [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === 'device'));
    $('#unlockPass').focus();
  } else {
    const sess = sessionStorage.getItem('tl.session');
    if (sess) {
      state.storageMode = 'session'; state.unlocked = true;
      applyVaultPayload(JSON.parse(sess));
      $$('#storageMode [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === 'session'));
      renderKeys(); renderModelSelect(); syncProviderUI(); applyParams();
    }
  }
  loadDefaultPrompt();
})();
})();
