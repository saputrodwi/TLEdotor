/* ============================================================
   TL Editor — frontend logic (Lentera, 2-tab input-first)
   Sunting tab: input + run bar + results (inline)
   Pengaturan tab: provider, keys, model, prompt, tampilan
   Cloudflare Pages (static) -> Pages Function -> Worker
   Storage: plaintext localStorage (tanpa vault).
   HTTPS-only. Key tidak pernah masuk log server.
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
    label: 'Default', icon: 'D', tag: 'Server key',
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
  temperature: 0.5,
  maxTokens: 8192,
  custom: { baseUrl: '', format: 'openai' },
  theme: 'system',
  systemPrompt: '',
  lastResult: null,
  lastRun: null,
};

/* ---------- storage (plaintext, tanpa vault) ---------- */
const LS_SETTINGS = 'tl.settings.v2';
const LS_KEYS = 'tl.keys.v2';
const LS_THEME = 'tl.theme';

function saveSettings() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify({
      provider: state.provider,
      models: state.models,
      temperature: state.temperature,
      maxTokens: state.maxTokens,
      custom: state.custom,
      systemPrompt: state.systemPrompt,
    }));
  } catch { /* quota */ }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (!s) return;
    state.provider = s.provider || 'default';
    state.models = s.models || state.models;
    state.temperature = s.temperature ?? 0.5;
    state.maxTokens = s.maxTokens ?? 8192;
    state.custom = Object.assign(state.custom, s.custom || {});
    if (typeof s.systemPrompt === 'string' && s.systemPrompt) state.systemPrompt = s.systemPrompt;
  } catch { /* corrupt -> defaults */ }
}
function saveKeys() {
  try {
    const o = {};
    for (const p of PROVIDER_IDS) o[p] = state.keys[p].map(k => k.value).filter(Boolean);
    localStorage.setItem(LS_KEYS, JSON.stringify(o));
  } catch { /* quota */ }
}
function loadKeys() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEYS) || 'null');
    if (!o) return;
    for (const p of PROVIDER_IDS) {
      const arr = Array.isArray(o[p]) ? o[p] : [];
      state.keys[p] = arr.map(v => ({ id: 'k' + Math.random().toString(36).slice(2, 9), value: String(v), shown: false }));
    }
  } catch { /* corrupt -> empty */ }
}
function autoSave() { saveSettings(); saveKeys(); }

/* ---------- theme (Lentera: sistem / terang / gelap) ---------- */
const THEME_ICONS = {
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="16" height="16"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 21h6M12 17v4"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="16" height="16"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="16" height="16"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
};
function resolveTheme(pref) {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(state.theme);
  document.querySelector('meta[name="theme-color"]').setAttribute('content',
    document.documentElement.dataset.theme === 'dark' ? '#0e0f13' : '#f6f5f2');
  $('#themeIcon').outerHTML = '<span id="themeIcon">' + THEME_ICONS[state.theme] + '</span>';
  $$('#themeSeg .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.tseg === state.theme));
  try { localStorage.setItem(LS_THEME, state.theme); } catch { /* ignore */ }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') applyTheme(); });
$('#themeToggle').onclick = () => {
  state.theme = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system';
  applyTheme();
  toast('Tampilan: ' + ({ system: 'ikuti sistem', light: 'terang', dark: 'gelap' })[state.theme]);
};
$$('#themeSeg .seg-tab').forEach(b => b.onclick = () => { state.theme = b.dataset.tseg; applyTheme(); });
try { state.theme = localStorage.getItem(LS_THEME) || 'system'; } catch { /* default */ }
applyTheme();

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
  renderKeyCard();
  renderModelSelect();
  autoSave();
}
function syncProviderUI() {
  const p = PROVIDERS[state.provider];
  const cw = $('#customWrap');
  if (cw) cw.classList.toggle('hidden', state.provider !== 'custom');
  const cu = $('#customBaseUrl');
  if (cu) cu.value = state.custom.baseUrl;
  $$('#customFormatTabs [data-cf]').forEach(b => b.classList.toggle('active', b.dataset.cf === state.custom.format));
  $('#runProviderLabel').textContent = p.label;
}

/* ---------- model select ---------- */
function setTrigger(label) {
  const trigger = $('#modelTrigger');
  trigger.textContent = '';
  trigger.append(document.createTextNode(label), el('span', { class: 'chev' }, '▾'));
}
function renderModelSelect() {
  const p = PROVIDERS[state.provider];
  const popup = $('#modelPopup'); popup.innerHTML = '';
  (p.models || []).forEach(m => {
    const label = (p.modelLabels && p.modelLabels[m]) || m;
    const opt = el('button', { class: 'mopt' + (state.models[state.provider] === m ? ' sel' : ''), role: 'option' }, label);
    opt.onclick = (e) => {
      e.stopPropagation();
      state.models[state.provider] = m;
      setTrigger(label);
      $$('#modelPopup .mopt').forEach(x => x.classList.remove('sel'));
      opt.classList.add('sel');
      popup.classList.add('hidden');
      autoSave();
    };
    popup.append(opt);
  });
  if (!state.models[state.provider]) state.models[state.provider] = p.models[0] || '';
  const cur = p.modelLabels && p.modelLabels[state.models[state.provider]] ? p.modelLabels[state.models[state.provider]] : state.models[state.provider];
  setTrigger(cur || '— pilih model —');
}
$('#modelTrigger').onclick = (e) => {
  e.stopPropagation();
  $('#modelPopup').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  const popup = $('#modelPopup');
  if (popup && !popup.classList.contains('hidden') && !e.target.closest('.rb-model')) popup.classList.add('hidden');
});

/* ---------- keys UI (ringkas, plaintext) ---------- */
function currentKeyValues(p) { return state.keys[p].map(k => k.value).filter(Boolean); }
function renderKeyCard() {
  const box = $('#keyCardBody'); box.innerHTML = '';
  const p = PROVIDERS[state.provider];
  const keys = currentKeyValues(state.provider);
  $('#keyCount').textContent = (p.serverKey ? 'server key' : keys.length + ' kunci');

  const foot = el('div', { class: 'key-foot' });
  foot.append(el('button', { class: 'ghost-btn', id: 'btnPingAll' }, 'Tes koneksi'));

  if (p.serverKey) {
    box.append(el('div', { class: 'field-label' }, 'API key — ' + p.label));
    box.append(el('div', { class: 'key-state ok' }, el('span', { class: 'dot' }), 'Kunci di server (Worker) — tanpa input apa pun.'));
    box.append(foot);
  } else {
    box.append(el('div', { class: 'field-label' }, 'API key — ' + p.label + (p.multiKey ? ' (pisahkan dengan koma untuk rotasi)' : '')));
    const inp = el('input', {
      class: 'input', id: 'keyInput', type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: p.keyHint || 'masukkan api key…',
      value: state.keys[state.provider].map(k => k.value).join(', '),
    });
    inp.addEventListener('input', () => {
      const parts = inp.value.split(',').map(s => s.trim()).filter(Boolean);
      state.keys[state.provider] = parts.map((v, i) => ({ id: 'k' + i + '-' + Math.random().toString(36).slice(2, 6), value: v, shown: false }));
      $('#keyCount').textContent = parts.length + ' kunci';
      autoSave();
    });
    box.append(inp);
    if (keys.length) foot.append(el('span', { class: 'key-state' }, el('span', { class: 'dot' }), keys.length + ' tersimpan di browser'));
    box.append(foot);
  }

  if (state.provider === 'custom') {
    const wrap = el('div', { id: 'customWrap' });
    wrap.append(el('label', { class: 'field-label' }, 'Base URL (OpenAI-compatible, HTTPS)'));
    const url = el('input', { id: 'customBaseUrl', class: 'input', placeholder: 'https://host.example.com/v1', autocomplete: 'off', spellcheck: 'false', value: state.custom.baseUrl });
    url.addEventListener('input', () => { state.custom.baseUrl = url.value.trim(); autoSave(); });
    wrap.append(url);
    const seg = el('div', { class: 'seg-tabs custom-format-tabs', id: 'customFormatTabs' });
    ['openai', 'gemini'].forEach(cf => seg.append(el('button', { class: 'seg-tab' + (state.custom.format === cf ? ' active' : ''), 'data-cf': cf }, cf === 'openai' ? 'OpenAI' : 'Gemini')));
    wrap.append(seg);
    $$('#customFormatTabs .seg-tab').forEach(b => b.onclick = () => {
      state.custom.format = b.dataset.cf;
      syncProviderUI(); autoSave();
    });
    box.append(wrap);
  }

  $('#btnPingAll').onclick = pingAll;
}

/* ---------- ping ---------- */
async function pingAll() {
  const p = state.provider;
  const keys = currentKeyValues(p);
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
      box.append(el('div', { class: 'ping-row ' + (r.ok ? 'ok' : 'bad') }, el('span', {}, 'Server key'), el('span', {}, r.ok ? 'OK' : 'Gagal — ' + (r.message || ''))));
    } else if (r.results) {
      r.results.forEach(row => {
        box.append(el('div', { class: 'ping-row ' + (row.ok ? 'ok' : 'bad') },
          el('span', {}, 'Kunci ' + (row.index + 1)), el('span', {}, row.ok ? 'OK' : 'Gagal — ' + (row.detail || row.code))));
      });
    }
  } catch (e) { box.innerHTML = ''; box.append(el('div', { class: 'ping-row bad' }, 'Gagal: ' + e.message)); }
}

/* ---------- API (same-origin) ---------- */
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

/* ---------- source file handling ---------- */
function updateSourceStats() {
  const t = $('#txtPaste').value;
  const lines = t ? t.split('\n').filter(x => x.length).length : 0;
  const pages = (t.match(/^\s*P\d+/gm) || []).length;
  $('#srcBadge').textContent = lines + ' baris';
  $('#statPages').textContent = pages + ' halaman';
  $('#statChars').textContent = t.length.toLocaleString('en-US') + ' karakter';
  $('#statTokens').textContent = '~' + Math.round(t.length / 3.5).toLocaleString('en-US') + ' token';
  updateLineNumbers();
}
function updateLineNumbers() {
  const g = $('#lineGutter');
  const n = $('#txtPaste').value.split('\n').length;
  let s = ''; for (let i = 1; i <= n; i++) s += String(i).padStart(2, '0') + '\n';
  g.textContent = s.trimEnd();
}
$('#txtPaste').addEventListener('input', updateSourceStats);
$('#txtPaste').addEventListener('scroll', () => { $('#lineGutter').scrollTop = $('#txtPaste').scrollTop; });

function normalizeText(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+(\n)/g, '$1');
}
$('#btnNormalize').onclick = () => { const t = normalizeText($('#txtPaste').value); $('#txtPaste').value = t; updateSourceStats(); toast('Dinormalisasi', 'ok'); };
$('#btnClearSource').onclick = () => { $('#txtPaste').value = ''; updateSourceStats(); };
$('#btnSample').onclick = async () => {
  try { const r = await apiCall('/api/sample', null, 'GET'); $('#txtPaste').value = r.sample; updateSourceStats(); toast('Contoh naskah dimuat', 'ok'); }
  catch { toast('Gagal memuat contoh', 'err'); }
};

/* file button always visible */
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
  const keys = currentKeyValues(p);
  const serverKey = PROVIDERS[p].serverKey;
  const panel = $('#modelList');
  if (!serverKey && keys.length === 0) return toast('Isi minimal 1 kunci untuk load model ' + PROVIDERS[p].label, 'err');
  panel.innerHTML = '';
  panel.append(el('div', { class: 'model-opt model-note' }, el('span', { class: 'muted' }, 'Memuat daftar ' + PROVIDERS[p].label + '…')));
  try {
    const body = { provider: p, keys };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/models', body, 'POST');
    const models = r.models || [];
    panel.innerHTML = '';
    if (!models.length) { panel.append(el('div', { class: 'model-opt model-note' }, el('span', { class: 'muted' }, serverKey ? 'Pakai daftar di dropdown.' : '0 model via API.'))); return; }
    models.slice(0, 100).forEach(m => {
      const label = (PROVIDERS[p].modelLabels && PROVIDERS[p].modelLabels[m.id]) || m.id;
      const exists = $$('#modelPopup .mopt').some(x => x.dataset.mid === m.id);
      if (!exists) {
        const opt = el('button', { class: 'mopt' + (state.models[p] === m.id ? ' sel' : ''), 'data-mid': m.id }, label);
        opt.onclick = (e) => {
          e.stopPropagation();
          state.models[p] = m.id;
          setTrigger(label);
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

/* ---------- params ---------- */
$('#temperature').oninput = () => { state.temperature = +$('#temperature').value; $('#tempVal').textContent = state.temperature.toFixed(2); autoSave(); };
$('#maxTokens').oninput = () => { state.maxTokens = +$('#maxTokens').value; autoSave(); };

function applyParams() {
  $('#temperature').value = state.temperature;
  $('#tempVal').textContent = state.temperature.toFixed(2);
  $('#maxTokens').value = state.maxTokens;
}

/* ---------- system prompt ---------- */
async function loadDefaultPrompt() {
  try { const r = await fetch('/api/prompt'); state.systemPrompt = (await r.json()).prompt; $('#systemPrompt').value = state.systemPrompt; updatePromptMeta(); }
  catch { /* leave empty -> worker fallback */ }
}
function updatePromptMeta() { $('#promptChars').textContent = $('#systemPrompt').value.length.toLocaleString() + ' karakter'; }
$('#systemPrompt').oninput = () => { state.systemPrompt = $('#systemPrompt').value; updatePromptMeta(); autoSave(); };
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
  const keys = currentKeyValues(p);
  const text = $('#txtPaste').value;
  if (!model) return toast('Pilih model', 'err');
  const serverKey = PROVIDERS[p].serverKey;
  if (!serverKey && keys.length === 0) return toast('Tambahkan minimal 1 ' + PROVIDERS[p].keyLabel, 'err');
  if (p === 'custom' && !state.custom.baseUrl) return toast('Isi Base URL custom', 'err');
  if (!text.trim()) return toast('File terjemahan kosong', 'err');

  const btn = $('#btnRun');
  if (btn.disabled) return;
  btn.disabled = true;
  setRunLoading(true);
  const t0 = performance.now();
  const tick = setInterval(() => {
    $('#runStatusTxt').textContent = 'Menyunting… ' + Math.max(1, Math.round((performance.now() - t0) / 1000)) + ' dtk';
  }, 400);
  try {
    const body = {
      provider: p, model, keys,
      text,
      systemPrompt: $('#systemPrompt').value,
      temperature: state.temperature, maxOutputTokens: state.maxTokens,
      strategy: 'round-robin',
    };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/edit', body);
    state.lastResult = r.raw;
    state.lastRun = { provider: p, model, ms: Math.round(performance.now() - t0), usage: r.usage, keyUsed: r.keyUsed, keyCount: r.keyCount };
    const c = renderResults(r.raw, state.lastRun);
    setRunStatus('ok', 'Selesai (' + state.lastRun.ms + ' ms) · ' + c.chg + ' perubahan · ' + c.rev + ' perlu dicek');
  } catch (e) {
    setRunStatus('error', 'Gagal: ' + (e.message || e));
  } finally {
    clearInterval(tick);
    setRunLoading(false);
    btn.disabled = false;
    autoSave();
  }
}
function setRunLoading(on) {
  $('#runBtnLabel').textContent = on ? 'Menyunting…' : 'Jalankan';
  $('#runProgress').classList.toggle('on', on);
  $('#runSpinner').classList.toggle('hidden', !on);
  if (on) {
    $('#runStatus').classList.remove('hidden', 'ok', 'error');
    $('#runStatusTxt').textContent = 'Menyunting…';
  }
}
function setRunStatus(kind, txt) {
  const s = $('#runStatus');
  s.classList.remove('hidden');
  s.classList.toggle('ok', kind === 'ok');
  s.classList.toggle('error', kind === 'error');
  $('#runStatusTxt').textContent = txt;
}
$('#btnRun').onclick = runEditor;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runEditor(); }
});

/* ---------- result parsing ---------- */
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

function parseDiffEntries(sec) {
  const s = String(sec || '').replace(/\r\n/g, '\n').trim();
  if (!s) return [];
  const cleaned = s.replace(/^BAGIAN\s*\d[^\n]*\n*/i, '').trim();
  if (!cleaned || /^tidak ada\./i.test(cleaned) || /^tidak ada perubahan\./i.test(cleaned)) return [];
  const blocks = cleaned.split(/\n+(?=\[[^\]\n]+\]\s*(?:\n|$))/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => {
    const e = {};
    const m = b.match(/^\[([^\]\n]+)\]/);
    e.loc = m ? m[1].trim() : '';
    const body = m ? b.slice(m[0].length) : b;
    let cur = null;
    body.split('\n').forEach(line => {
      const lm = line.match(/^(Sebelum|Sesudah|Alasan|Teks|Masalah|Saran)\s*:\s*(.*)$/i);
      if (lm) { cur = lm[1].toLowerCase(); e[cur] = lm[2].trim(); }
      else if (cur) { const t = line.trim(); if (t) e[cur] += '\n' + t; }
    });
    for (const k of ['sebelum','sesudah','alasan','teks','masalah','saran']) if (e[k] != null) e[k] = e[k].trim();
    return e;
  });
}

function renderDiffList(container, entries, kind) {
  container.innerHTML = '';
  if (!entries.length) {
    container.append(el('div', { class: 'empty-note' }, kind === 'perubahan' ? 'Tidak ada perubahan.' : 'Tidak ada.'));
    return;
  }
  entries.forEach(e => {
    const d = el('div', { class: 'diff' });
    if (e.loc) d.append(el('div', { class: 'loc' }, '[' + e.loc + ']'));
    if (kind === 'perubahan') {
      if (e.sebelum) d.append(el('div', { class: 'lbl' }, 'Sebelum'), el('div', { class: 'tx before' }, e.sebelum));
      if (e.sesudah) d.append(el('div', { class: 'lbl' }, 'Sesudah'), el('div', { class: 'tx after' }, e.sesudah));
      if (e.alasan) d.append(el('div', { class: 'why' }, e.alasan));
    } else {
      if (e.teks) d.append(el('div', { class: 'lbl' }, 'Teks'), el('div', { class: 'tx' }, e.teks));
      if (e.masalah) d.append(el('div', { class: 'why' }, 'Masalah: ' + e.masalah));
      if (e.saran) d.append(el('div', { class: 'why' }, 'Saran: ' + e.saran));
    }
    container.append(d);
  });
}

function renderResults(raw, run) {
  const resultsCard = $('#resultsCard');
  if (resultsCard) resultsCard.classList.remove('hidden');
  const { hasilText, perubSec, dicekSec } = splitSections(raw);
  const pre = $('#resultHasil');
  pre.innerHTML = '<code>' + highlightResult(hasilText) + '</code>';
  window._hasilText = hasilText;
  const chg = parseDiffEntries(perubSec);
  const rev = parseDiffEntries(dicekSec);
  $('#chgBadge').textContent = String(chg.length);
  $('#revBadge').textContent = String(rev.length);
  renderDiffList($('#resultChanges'), chg, 'perubahan');
  renderDiffList($('#resultReview'), rev, 'perlu');
  return { chg: chg.length, rev: rev.length };
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
$('#diffMode').onchange = () => { if (window._hasilText) renderResults(state.lastResult, state.lastRun); };

/* ---------- init ---------- */
(async function init() {
  // bersihkan sisa vault lama (versi enkripsi AES-GCM sudah dihapus)
  try {
    localStorage.removeItem('tl.vault.data');
    localStorage.removeItem('tl.vault.meta');
    sessionStorage.removeItem('tl.session');
  } catch { /* ignore */ }
  loadSettings();
  loadKeys();
  renderProviderTiles();
  syncProviderUI();
  renderKeyCard();
  renderModelSelect();
  applyParams();
  updateSourceStats();
  switchView('sunting');
  if (state.systemPrompt) { $('#systemPrompt').value = state.systemPrompt; updatePromptMeta(); }
  else loadDefaultPrompt();
})();
})();
