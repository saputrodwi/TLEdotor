/* TL Editor — total frontend logic.
   UI: Sunting utama, Pengaturan panel sekunder.
   Rules: nomor baris selalu tampil, diff selalu aktif, tanpa Contoh/Rapi.
*/
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const child of kids.flat()) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}
function toast(msg, kind = '') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

const PROVIDERS = {
  gemini: {
    label: 'Gemini', tag: 'Gemini Flash', multiKey: true,
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-live', 'gemini-3.8-flash-lite-tts'],
    modelLabels: { 'gemini-3.5-flash-lite': 'Flash Lite', 'gemini-3.8-flash': 'Flash', 'gemini-3.8-live': 'Live', 'gemini-3.8-flash-lite-tts': 'Flash Lite TTS' },
    keyHint: 'Mulai dengan AIza…'
  },
  default: {
    label: 'Default', tag: 'Agnes AI', multiKey: true,
    models: ['agnes-2.5-flash', 'agnes-2.0-flash', 'agnes-3.0-flash'],
    modelLabels: { 'agnes-2.5-flash': 'Model B', 'agnes-2.0-flash': 'Model A', 'agnes-3.0-flash': 'Model C' },
    keyHint: 'Kunci Agnes AI-mu sendiri. Kosongkan kalau mau pakai kunci server.',
    // Allow user-provided keys; server key used as fallback when empty
    allowUserKeys: true,
    baseUrl: 'https://apihub.agnes-ai.com/v1'
  },
  sumopod: {
    label: 'Sumopod', tag: 'ai.sumopod.com', multiKey: true,
    models: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat'],
    keyHint: 'Base https://ai.sumopod.com/v1'
  },
  custom: {
    label: 'Custom', tag: 'OpenAI / Gemini', multiKey: true, needsUrl: true,
    models: [],
    keyHint: 'Isi base URL + model di panel Pengaturan.'
  }
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

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
  lastRun: null
};

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
      systemPrompt: state.systemPrompt
    }));
  } catch {}
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
  } catch {}
}
function saveKeys() {
  try {
    const o = {};
    for (const p of PROVIDER_IDS) o[p] = (state.keys[p] || []).map(k => k.value).filter(Boolean);
    localStorage.setItem(LS_KEYS, JSON.stringify(o));
  } catch {}
}
function loadKeys() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEYS) || 'null');
    if (!o) return;
    for (const p of PROVIDER_IDS) {
      const arr = Array.isArray(o[p]) ? o[p] : [];
      state.keys[p] = arr.map((v, i) => ({ id: 'k' + i + '-' + Math.random().toString(36).slice(2, 7), value: String(v), shown: false }));
    }
  } catch {}
}
function autoSave() { saveSettings(); saveKeys(); }
function currentKeys(provider = state.provider) {
  return (state.keys[provider] || []).map(k => k.value).filter(Boolean);
}

/* Theme */
const THEME_ICONS = {
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 21h6M12 17v4"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
};
function applyTheme() {
  const resolved = state.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : state.theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', resolved === 'dark' ? '#191817' : '#FCF9F2');
  const icon = $('#themeIcon');
  if (icon) icon.innerHTML = THEME_ICONS[state.theme];
  $$('#themeOptions .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === state.theme));
  try { localStorage.setItem(LS_THEME, state.theme); } catch {}
}
try { state.theme = localStorage.getItem(LS_THEME) || 'light'; } catch {}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') applyTheme(); });
$('#themeToggle').onclick = () => {
  state.theme = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system';
  applyTheme();
  toast('Tema: ' + state.theme, 'ok');
};
$$('#themeOptions .seg-btn').forEach(b => b.onclick = () => { state.theme = b.dataset.theme; applyTheme(); });

/* Settings overlay */
function openSettings() {
  $('#settingsOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSettings() {
  $('#settingsOverlay').classList.add('hidden');
  document.body.style.overflow = '';
}
$$('[data-open-settings]').forEach(b => b.onclick = openSettings);
$$('[data-close-settings]').forEach(b => b.onclick = closeSettings);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#settingsOverlay').classList.contains('hidden')) closeSettings(); });

/* Source */
function updateSourceStats() {
  const t = $('#txtPaste').value;
  const lines = t ? t.split('\n').filter(Boolean).length : 0;
  const pages = (t.match(/^\s*P\d+/gm) || []).length;
  $('#srcMeta').textContent = `${lines} baris · ${pages} halaman · ${t.length.toLocaleString('en-US')} karakter`;
  updateLineNumbers();
}
function updateLineNumbers() {
  const g = $('#lineGutter');
  const n = $('#txtPaste').value.split('\n').length;
  let out = '';
  for (let i = 1; i <= n; i++) out += String(i).padStart(2, '0') + '\n';
  g.textContent = out.trimEnd();
}
$('#txtPaste').addEventListener('input', updateSourceStats);
$('#txtPaste').addEventListener('scroll', () => {
  $('#lineGutter').scrollTop = $('#txtPaste').scrollTop;
});
$('#btnChooseFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  $('#txtPaste').value = await f.text();
  updateSourceStats();
  toast(`File “${f.name}” dimuat`, 'ok');
  e.target.value = '';
};
$('#btnClearSource').onclick = () => {
  $('#txtPaste').value = '';
  updateSourceStats();
};
const editorArea = $('#editorArea');
['dragover', 'drop'].forEach(ev => editorArea.addEventListener(ev, e => e.preventDefault()));
editorArea.addEventListener('drop', async e => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.txt$|text\/plain/i.test(f.name)) return toast('Hanya file .txt', 'err');
  $('#txtPaste').value = await f.text();
  updateSourceStats();
  toast('Dimuat: ' + f.name, 'ok');
});

/* Provider tiles */
function renderProviderTiles() {
  const wrap = $('#providerList');
  wrap.innerHTML = '';
  PROVIDER_IDS.forEach(id => {
    const p = PROVIDERS[id];
    const b = el('button', {
      class: 'provider-tile' + (state.provider === id ? ' active' : ''),
      type: 'button'
    },
      el('b', {}, p.label),
      el('span', {}, p.tag)
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
  rebuildModelPopup();
  updateModelTrigger();
  autoSave();
}
function syncProviderUI() {
  const p = PROVIDERS[state.provider];
  $('#providerName').textContent = p.label;
  $('#customPanel').classList.toggle('hidden', state.provider !== 'custom');
  const url = $('#customBaseUrl');
  if (url) url.value = state.custom.baseUrl;
  $$('#customFormat .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.format === state.custom.format));
  const cm = $('#customModel');
  if (cm) cm.value = state.models.custom || '';
}
$('#customBaseUrl').addEventListener('input', e => { state.custom.baseUrl = e.target.value.trim(); autoSave(); });
$$('#customFormat .seg-btn').forEach(b => b.onclick = () => {
  state.custom.format = b.dataset.format;
  $$('#customFormat .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  autoSave();
});
$('#customModel').addEventListener('input', e => {
  state.models.custom = e.target.value.trim();
  updateModelTrigger();
  autoSave();
});

/* Keys */
function renderKeyCard() {
  const box = $('#keyCard');
  box.innerHTML = '';
  const p = PROVIDERS[state.provider];
  const keys = currentKeys();
  // Default provider with allowUserKeys: show input but also support empty (server key fallback)
  const isDefaultWithUserKeys = p.serverKey && p.allowUserKeys;
  $('#keyCount').textContent = (!keys.length && !isDefaultWithUserKeys) ? 'server key' : keys.length + ' kunci';

  if (p.serverKey && !isDefaultWithUserKeys) {
    box.append(el('p', { class: 'note' }, 'Provider Default memakai kunci di server. Tanpa input apa pun.'));
  } else {
    box.append(el('label', { class: 'field-label', for: 'keyInput' }, 'API key — ' + p.label + (p.multiKey ? ' · pisahkan dengan koma' : '')));
    const input = el('input', {
      id: 'keyInput',
      class: 'field',
      type: 'text',
      placeholder: p.keyHint || 'masukkan api key…',
      value: keys.join(', '),
      autocomplete: 'off',
      spellcheck: 'false'
    });
    input.addEventListener('input', () => {
      const parts = input.value.split(',').map(s => s.trim()).filter(Boolean);
      state.keys[state.provider] = parts.map((v, i) => ({ id: 'k' + i + '-' + Math.random().toString(36).slice(2, 6), value: v, shown: false }));
      $('#keyCount').textContent = parts.length + ' kunci';
      autoSave();
    });
    box.append(input);
  }

  const ping = el('button', { class: 'btn-quiet small', type: 'button' }, 'Tes koneksi');
  ping.onclick = pingAll;
  box.append(el('div', { class: 'key-actions' }, ping));
}

/* Ping */
async function pingAll() {
  const p = state.provider;
  const keys = currentKeys(p);
  const serverKey = PROVIDERS[p].serverKey;
  const allowUserKeys = PROVIDERS[p].allowUserKeys;
  // For default with allowUserKeys: proceed if either user has keys OR it's ok to use server key
  if (!allowUserKeys && !serverKey && !keys.length) return toast('Tambahkan key dulu.', 'err');
  const out = $('#pingOut');
  out.classList.remove('hidden');
  out.innerHTML = '';
  out.append(el('p', { class: 'muted' }, serverKey ? 'Menguji server key…' : `Menguji ${keys.length} key…`));
  try {
    const body = { provider: p, model: PROVIDERS[p].models[0] || '', keys };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/ping', body);
    out.innerHTML = '';
    if (serverKey) {
      out.append(el('div', { class: 'ping-row ' + (r.ok ? 'ok' : 'bad') }, el('span', {}, 'Server key'), el('span', {}, r.ok ? 'OK' : 'Gagal — ' + (r.message || ''))));
    } else if (Array.isArray(r.results)) {
      r.results.forEach(row => out.append(el('div', { class: 'ping-row ' + (row.ok ? 'ok' : 'bad') },
        el('span', {}, 'Kunci ' + (row.index + 1)),
        el('span', {}, row.ok ? 'OK' : 'Gagal — ' + (row.detail || row.code))
      )));
    }
  } catch (e) {
    out.innerHTML = '';
    out.append(el('div', { class: 'ping-row bad' }, 'Gagal: ' + e.message));
  }
}

/* Models */
function currentModelLabel() {
  const p = PROVIDERS[state.provider];
  const model = state.models[state.provider] || p.models[0] || '';
  return (p.modelLabels && p.modelLabels[model]) || model || (state.provider === 'custom' ? 'isi di Pengaturan' : 'pilih model');
}
function updateModelTrigger() {
  $('#modelTrigger').textContent = currentModelLabel();
}
function rebuildModelPopup() {
  const p = PROVIDERS[state.provider];
  const popup = $('#modelPopup');
  popup.innerHTML = '';
  (p.models || []).forEach(m => popup.append(modelOption(m)));
  if (!state.models[state.provider]) state.models[state.provider] = p.models[0] || '';
  updateModelTrigger();
}
function modelOption(id) {
  const p = PROVIDERS[state.provider];
  const label = (p.modelLabels && p.modelLabels[id]) || id;
  const b = el('button', { class: 'mopt' + (state.models[state.provider] === id ? ' active' : ''), type: 'button', role: 'option' }, label);
  b.onclick = e => {
    e.stopPropagation();
    state.models[state.provider] = id;
    rebuildModelPopup();
    $('#modelPopup').classList.add('hidden');
    autoSave();
    toast('Model: ' + label, 'ok');
  };
  return b;
}
$('#modelTrigger').onclick = e => {
  e.stopPropagation();
  const popup = $('#modelPopup');
  popup.classList.toggle('hidden');
  $('#modelTrigger').setAttribute('aria-expanded', String(!popup.classList.contains('hidden')));
};
document.addEventListener('click', e => {
  const popup = $('#modelPopup');
  if (popup && !popup.classList.contains('hidden') && !e.target.closest('.model-control')) popup.classList.add('hidden');
});
$('#btnLoadModels').onclick = async () => {
  const p = state.provider;
  const keys = currentKeys(p);
  const serverKey = PROVIDERS[p].serverKey;
  if (!serverKey && !keys.length) return toast('Isi minimal 1 kunci dulu.', 'err');
  if (p === 'custom' && !state.custom.baseUrl) return toast('Isi Base URL custom dulu.', 'err');
  const out = $('#modelPopup');
  out.classList.remove('hidden');
  out.innerHTML = '';
  out.append(el('div', { class: 'mopt' }, 'Memuat daftar model…'));
  try {
    const body = { provider: p, keys };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/models', body, 'POST');
    const known = PROVIDERS[p].models || [];
    const loaded = (r.models || []).map(m => m.id);
    const ids = [...new Set([...known, ...loaded])];
    out.innerHTML = '';
    if (!ids.length) out.append(el('div', { class: 'mopt' }, serverKey ? 'Pakai daftar bawaan.' : '0 model via API.'));
    ids.forEach(id => out.append(modelOption(id)));
    if (!state.models[p]) state.models[p] = known[0] || loaded[0] || '';
    updateModelTrigger();
    toast(ids.length ? 'Model dimuat' : 'Belum ada model', 'ok');
  } catch (e) {
    out.innerHTML = '';
    out.append(el('div', { class: 'mopt' }, 'Gagal muat model: ' + e.message));
  }
};

/* Params */
$('#temperature').oninput = () => { state.temperature = +$('#temperature').value; $('#tempVal').textContent = state.temperature.toFixed(2); autoSave(); };
$('#maxTokens').oninput = () => { state.maxTokens = +$('#maxTokens').value || 8192; autoSave(); };
function applyParams() {
  $('#temperature').value = state.temperature;
  $('#tempVal').textContent = Number(state.temperature).toFixed(2);
  $('#maxTokens').value = state.maxTokens;
}

/* Prompt */
async function loadDefaultPrompt() {
  try {
    const r = await fetch('/api/prompt');
    const data = await r.json();
    state.systemPrompt = data.prompt || '';
    $('#systemPrompt').value = state.systemPrompt;
    updatePromptMeta();
  } catch {}
}
function updatePromptMeta() {
  $('#promptChars').textContent = ($('#systemPrompt').value.length || 0).toLocaleString('en-US') + ' karakter';
}
$('#systemPrompt').addEventListener('input', () => {
  state.systemPrompt = $('#systemPrompt').value;
  updatePromptMeta();
  autoSave();
});
$('#btnTogglePrompt').onclick = () => {
  const open = $('#systemPrompt').classList.toggle('hidden');
  $('#btnTogglePrompt').textContent = open ? 'Perinci' : 'Tutup';
  $('#promptSummary').classList.toggle('hidden', !open);
};
$('#btnPromptDefault').onclick = loadDefaultPrompt;
$('#btnPromptReset').onclick = () => { loadDefaultPrompt(); toast('System prompt di-reset', 'ok'); };

/* Run */
async function runEditor() {
  const p = state.provider;
  const model = state.models[p] || '';
  const keys = currentKeys(p);
  const text = $('#txtPaste').value;
  if (!model) return toast('Pilih model dulu.', 'err');
  const serverKey = PROVIDERS[p].serverKey;
  const allowUserKeys = PROVIDERS[p].allowUserKeys;
  // For default with allowUserKeys: allow empty keys (will use server key fallback)
  if (!serverKey && !allowUserKeys && !keys.length) return toast('Tambahkan minimal 1 ' + PROVIDERS[p].label + ' key.', 'err');
  if (p === 'custom' && !state.custom.baseUrl) return toast('Isi Base URL custom.', 'err');
  if (!text.trim()) return toast('Sumber kosong.', 'err');

  const btn = $('#btnRun');
  if (btn.disabled) return;
  btn.disabled = true;
  setRunLoading(true);
  const t0 = performance.now();
  const tick = setInterval(() => {
    $('#runStatusText').textContent = 'Menyunting… ' + Math.max(1, Math.round((performance.now() - t0) / 1000)) + ' dtk';
  }, 400);
  try {
    const body = {
      provider: p,
      model,
      keys,
      text,
      systemPrompt: $('#systemPrompt').value,
      temperature: state.temperature,
      maxOutputTokens: state.maxTokens,
      strategy: 'round-robin'
    };
    if (p === 'custom') body.custom = { baseUrl: state.custom.baseUrl, format: state.custom.format };
    const r = await apiCall('/api/edit', body);
    state.lastResult = r.raw;
    state.lastRun = { provider: p, model, ms: Math.round(performance.now() - t0), usage: r.usage, keyUsed: r.keyUsed, keyCount: r.keyCount };
    const c = renderResults(r.raw);
    setRunStatus('ok', `Selesai (${state.lastRun.ms} ms) · ${c.chg} perubahan · ${c.rev} perlu dicek`);
  } catch (e) {
    setRunStatus('err', 'Gagal: ' + (e.message || e));
  } finally {
    clearInterval(tick);
    setRunLoading(false);
    btn.disabled = false;
    autoSave();
  }
}
function setRunLoading(on) {
  $('#runLabel').textContent = on ? 'Menyunting…' : 'Jalankan';
  $('#runProgress').classList.toggle('on', on);
  $('#spinner').classList.toggle('hidden', !on);
  const s = $('#runStatus');
  s.classList.remove('hidden', 'ok', 'err');
  if (on) $('#runStatusText').textContent = 'Menyunting…';
}
function setRunStatus(kind, text) {
  const s = $('#runStatus');
  s.classList.remove('hidden');
  s.classList.toggle('ok', kind === 'ok');
  s.classList.toggle('err', kind === 'err');
  $('#runStatusText').textContent = text;
}
$('#btnRun').onclick = runEditor;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runEditor(); }
});

/* Results */
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* Hasil akhir: kartu balon gaya Stitch (tag speaker + badan serif) */
function renderHasilCards(text) {
  const wrap = $('#hasilCards');
  const pre = $('#resultHasil');
  wrap.innerHTML = '';
  if (!text) { wrap.hidden = true; pre.innerHTML = '<code><span class="placeholder">Hasil kosong.</span></code>'; return; }
  const lines = text.split('\n');
  // Tampilkan highlight diff di <pre> SELALU (agar user lihat baris berubah)
  pre.innerHTML = '<code>' + highlightResult(text) + '</code>';
  // Kalau AI output pakai tag [BALON N], tampilkan juga versi kartu untuk kemudahan baca
  const hasAnyTag = lines.some(ln => /^\[([^\]]+)\]\s*/.test(ln));
  if (hasAnyTag && lines.length > 1) {
    pre.hidden = true;
    wrap.hidden = false;
  const tagRe = /^\[([^\]]+)\]\s*(.*)$/;
  const groups = [];
  let cur = null;
  lines.forEach(ln => {
    if (!ln.trim() || /^\s*-{4,}\s*$/.test(ln)) {
      if (cur) { groups.push(cur); cur = null; }
      return;
    }
    const m = ln.match(tagRe);
    if (m) {
      if (cur) groups.push(cur);
      const rest = m[2].trim();
      const sp = rest.match(/^([A-Z][\wÀ-ɏ'.& ]{0,28}?):\s+(.+)$/s);
      cur = { tag: '[' + m[1] + ']', extra: sp ? sp[1] : '', body: sp ? [sp[2]] : (rest ? [rest] : []) };
    } else if (cur) {
      cur.body.push(ln);
    } else {
      groups.push({ tag: '', extra: '', body: [ln], loose: true });
    }
  });
  if (cur) groups.push(cur);
  groups.forEach(g => {
    const card = el('div', { class: 'hasil-card' + (g.loose || !g.tag ? ' loose' : '') });
    if (g.tag) {
      const head = el('div', { class: 'hasil-card-head' },
        el('span', { class: 'hasil-tag' }, g.tag),
        el('span', { class: 'hasil-loc' }, g.extra || '')
      );
      card.append(head);
    }
    const body = el('div', { class: 'hasil-body' });
    g.body.filter(b => b.trim()).forEach(b => {
      const isCm = /^\s*\/\//.test(b);
      body.append(el('div', { class: 'hasil-line' + (isCm ? ' cm' : '') }, b));
    });
    card.append(body);
    wrap.append(card);
  });
  if (!groups.length) {
    const card = el('div', { class: 'hasil-card' }, el('div', { class: 'hasil-body' }, el('div', { class: 'hasil-line' }, text)));
    wrap.append(card);
  }
  } // end if hasAnyTag
}
function highlightResult(text) {
  const src = $('#txtPaste').value.split('\n');
  return text.split('\n').map((ln, i) => {
    const changed = i >= src.length || src[i] !== ln;
    return `<span class="line${changed ? ' changed' : ''}">${escapeHtml(ln) || '&nbsp;'}</span>`;
  }).join('\n');
}
function splitSections(raw) {
  const s = String(raw || '').replace(/\r\n/g, '\n');
  const i1 = s.search(/BAGIAN\s*1/i);
  const i2 = s.search(/BAGIAN\s*2/i);
  const i3 = s.search(/BAGIAN\s*3/i);
  const hasilSec = s.slice(i1 >= 0 ? i1 : 0, i2 >= 0 ? i2 : s.length);
  const perubSec = i2 >= 0 ? s.slice(i2, i3 >= 0 ? i3 : s.length) : '';
  const dicekSec = i3 >= 0 ? s.slice(i3) : '';
  let hasilText = '';
  const fence = hasilSec.match(/```[^\n]*\n?([\s\S]*?)```/);
  if (fence) hasilText = fence[1].replace(/\s+$/, '');
  else {
    hasilText = hasilSec.replace(/^.*?BAGIAN\s*1[^\n]*\n/i, '').replace(/^\s*\n/, '');
  }
  return { hasilText, perubSec, dicekSec };
}
function parseDiffEntries(sec) {
  const s = String(sec || '').replace(/\r\n/g, '\n').trim();
  if (!s) return [];
  const cleaned = s.replace(/^BAGIAN\s*\d[^\n]*\n*/i, '').trim();
  if (!cleaned || /^tidak ada(\s|\.|$)/i.test(cleaned)) return [];
  const blocks = cleaned.split(/\n+(?=\[[^\]\n]+\]\s*(?:\n|$))/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => {
    const e = {};
    const m = b.match(/^\[([^\]\n]+)\]/);
    e.loc = m ? m[1].trim() : '';
    const body = m ? b.slice(m[0].length) : b;
    let cur = null;
    body.split('\n').forEach(line => {
      const lm = line.match(/^(Sebelum|Sesudah|Alasan|Teks|Masalah|Saran)\s*:\s*(.*)$/i);
      if (lm) {
        cur = lm[1].toLowerCase();
        e[cur] = lm[2].trim();
      } else if (cur) {
        const t = line.trim();
        if (t) e[cur] += '\n' + t;
      }
    });
    for (const k of ['sebelum', 'sesudah', 'alasan', 'teks', 'masalah', 'saran']) if (e[k] != null) e[k] = e[k].trim();
    return e;
  });
}
function dcRow(label, text, cls) {
  return el('div', { class: 'dc-row' },
    el('span', { class: 'dc-lbl ' + (cls || '') }, label),
    el('span', { class: 'dc-text ' + (cls || '') }, text));
}
function renderDiffList(container, entries, kind) {
  container.innerHTML = '';
  if (!entries.length) {
    container.append(el('p', { class: 'empty' }, kind === 'perubahan' ? 'Tidak ada perubahan.' : 'Tidak ada.'));
    return;
  }
  entries.forEach((e, i) => {
    if (kind === 'perubahan') {
      const item = el('div', { class: 'diff-item edit-card' });
      const head = el('div', { class: 'dc-head' }, el('span', { class: 'dc-title' }, (i + 1) + '. Perbaikan leksikal'));
      if (e.loc) head.append(el('span', { class: 'dc-loc' }, '[' + e.loc + ']'));
      item.append(head);
      if (e.sebelum) item.append(dcRow('Draf awal', e.sebelum, 'del'));
      if (e.sesudah) item.append(dcRow('Revisi TL', e.sesudah, 'add'));
      if (e.alasan) item.append(el('p', { class: 'dc-note' }, 'Kaidah: ' + e.alasan));
      container.append(item);
    } else {
      const item = el('div', { class: 'diff-item flag-card' });
      const head = el('div', { class: 'dc-head' },
        el('span', { class: 'flag-kicker' }, e.loc ? '[' + e.loc.toUpperCase() + ']' : '[Perlu dicek]'));
      item.append(head);
      const h = e.masalah || e.teks || 'Catatan penerjemah';
      item.append(el('p', { class: 'flag-h' }, h));
      if (e.teks && e.masalah) item.append(dcRow('Teks', e.teks, ''));
      if (e.saran) item.append(dcRow('Saran', e.saran, 'add'));
      container.append(item);
    }
  });
}
function renderResults(raw) {
  const { hasilText, perubSec, dicekSec } = splitSections(raw);
  window._hasilText = hasilText;
  renderHasilCards(hasilText);
  const chg = parseDiffEntries(perubSec);
  const rev = parseDiffEntries(dicekSec);
  $('#badgeHasil').textContent = String(hasilText ? hasilText.split('\n').filter(Boolean).length : 0);
  $('#badgeChg').textContent = String(chg.length);
  $('#badgeChgTag').textContent = chg.length + ' penyesuaian leksikal';
  $('#badgeChgTag').classList.toggle('hidden', !chg.length);
  $('#badgeRev').textContent = String(rev.length);
  $('#badgeRevTag').textContent = rev.length + ' catatan manusia';
  $('#badgeRevTag').classList.toggle('hidden', !rev.length);
  $('#badgeReady').classList.toggle('hidden', !hasilText);
  renderDiffList($('#resultChanges'), chg, 'perubahan');
  renderDiffList($('#resultReview'), rev, 'perlu');
  return { chg: chg.length, rev: rev.length };
}

/* Copy/download */
$('#btnCopySource').onclick = async () => {
  const t = $('#txtPaste').value;
  if (!t.trim()) return toast('Sumber kosong.', 'err');
  try {
    await navigator.clipboard.writeText(t);
    toast('Naskah disalin', 'ok');
  } catch {
    window.prompt('Salin manual:', t);
  }
};
$('#btnCopy').onclick = async () => {
  const txt = window._hasilText || state.lastResult;
  if (!txt) return toast('Belum ada hasil', 'err');
  try {
    await navigator.clipboard.writeText(txt);
    toast('Hasil disalin', 'ok');
  } catch {
    window.prompt('Salin manual:', txt);
  }
};
$('#btnDownload').onclick = () => {
  const txt = window._hasilText || state.lastResult;
  if (!txt) return toast('Belum ada hasil', 'err');
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hasil-terjemahan.txt';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

/* API */
async function apiCall(path, body, method = 'POST') {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Tidak bisa menjangkau Worker. (' + e.message + ')');
  }
  let data;
  try { data = await res.json(); } catch { data = { ok: false, code: 'BAD_RESPONSE', message: 'Respon bukan JSON' }; }
  if (!res.ok) {
    const e = new Error(data.message || ('HTTP ' + res.status));
    e.code = data.code;
    e.status = res.status;
    throw e;
  }
  return data;
}

/* Init */
(async function init() {
  try {
    localStorage.removeItem('tl.vault.data');
    localStorage.removeItem('tl.vault.meta');
    sessionStorage.removeItem('tl.session');
  } catch {}
  loadSettings();
  loadKeys();
  renderProviderTiles();
  syncProviderUI();
  renderKeyCard();
  rebuildModelPopup();
  applyParams();
  updateSourceStats();
  if (state.systemPrompt) {
    $('#systemPrompt').value = state.systemPrompt;
    updatePromptMeta();
  } else {
    loadDefaultPrompt();
  }
  closeSettings();
})();
})();