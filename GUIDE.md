# TL Editor — Panduan (Guide)

Editor terjemahan komik / manhua / light-novel **EN → ID** berbasis web.
Frontend statis di-host di **Cloudflare Pages**, backend-nya **Cloudflare
Worker** (API-only) yang mem-proxy AI (Gemini, Sumopod, Agnes AI, Cloudflare
Workers AI, dan endpoint OpenAI/Gemini kompatibel buatanmu). Worker dijangkau
melalui **Pages Service Binding** (`TL_WORKER`) yang diteruskan **Pages
Functions** — pola yang sama dengan Ocrku.

> Frontend memanggil `/api/...` dengan path relatif. Cloudflare Pages
> (Functions di `functions/`) meneruskannya ke Worker via binding `TL_WORKER`.
> Nggak ada URL publik Worker, dan nggak ada CORS karena sama domain Pages.

---

## Arsitektur

```
┌──────────────────────────────┐
│  Browser (end-user)          │
│  • tempel/unggah .txt        │
│  • simpan API key (vault)    │
│  • pilih provider + model    │
└──────────────┬───────────────┘
               │ HTTPS (TLS, key tidak pernah di-log)
               ▼
┌──────────────────────────────────────────────────────────┐
│  Cloudflare Pages   (domain *.pages.dev)                │
│  • frontend/  → situs statis (index.html, app.js, ...)  │
│  • functions/api/[[path]].js  → proxy /api/* ke Worker  │
│    via Service Binding TL_WORKER ──────────────┐        │
└────────────────────────────────────────────────┼────────┘
                                                 │
                 ┌───────────────────────────────┘
                 ▼
┌──────────────────────────────────────────────────────────┐
│  Cloudflare Worker  (API-only, tanpa URL publik)          │
│  • /api/health  /api/models  /api/ping  /api/edit        │
│  • multi-key load-balancing, fail-over per status        │
│  • guard: HTTPS-only, anti-SSRF, rate-limit, gw-secret   │
└───────┬──────────┬──────────┬──────────┬──────────┬──────┘
        ▼          ▼          ▼          ▼          ▼
    Gemini     Sumopod    Agnes AI   Cloudflare   Custom
   (v1beta)  (ai.sumo..) (apihub..)  (Workers AI) (OpenAI/Gemini)
```

### Struktur repo

```
tl-editor/
├─ frontend/                      # situs statis (Cloudflare Pages build output)
│  ├─ index.html                  # SPA shell
│  ├─ styles.css                  # tema Obsidian Slate (hand-rolled, tanpa CDN)
│  ├─ app.js                      # logika: vault, provider, multi-key, load model, run
│  └─ prompts/
│     ├─ INDONESIAN_TRANSLATION_EDITOR.md   # system prompt bawaan (di-fetch saat start)
│     └─ SAMPLE_CH121.txt                   # contoh naskah (tombol "Contoh Naskah")
├─ functions/
│  └─ api/[[path]].js             # Pages Function: proxy /api/* ke binding TL_WORKER
├─ worker/                        # Cloudflare Worker (API-only, tanpa URL publik)
│  ├─ index.js                    # router + provider proxy + keamanan
│  ├─ wrangler.toml               # nama, [vars], [ai] — HANYA deploy Worker
│  ├─ package.json                # scripts: dev / tail / test
│  └─ test/smoke.mjs              # smoke test router offline (tanpa key)
└─ GUIDE.md                       # file ini
```

---

## Prasyarat

- **Node.js** 18+ (untuk `wrangler` & test).
- Akun **Cloudflare** (gratis memadai).
- API key dari provider yang mau dipakai (Gemini / Sumopod / Agnes / Cloudflare /
  endpoint OpenAI-compatible milikmu).
- (Opsional) satu domain yang terpasang ke Cloudflare bila ingin pin custom domain.

---

## 1. Uji lokal dulu (no keys, offline)

Semua dari folder `worker/`:

```bash
cd worker
npm install
npm test          # smoke test: menjalankan router tanpa jaringan. Harap "ALL PASSED".
```

Smoke test meng-`import` `index.js` dan men-stub `fetch` global, jadi **tidak
perlu API key** dan tidak ada panggilan keluar.

## 2. Dev Worker lokal (API-only)

```bash
cd worker
npm install
npm run dev       # wrangler dev
```

`/api/*` jalan di `http://localhost:8787/...`. Worker kini **API-only**
(statis-nya ada di Pages, bukan di sini). Tes cepat:
`curl http://localhost:8787/api/health` → `{"ok":true,...}`.
Untuk `/api/edit` sungguhan, isi API key di UI (panggilan keluar ke provider).

> Proxy Pages-Function (`functions/`) tak bisa digabung ke `wrangler dev`; itu
> cuma relevan setelah deploy. Jadi untuk dev lokal cukup cek `/api` langsung.

---

## 3. Deploy (dashboard Cloudflare, pola Ocrku) — semua bisa dari HP

Urutan penting: **Worker dulu, baru Pages, terakhir Service Binding**.

### 3.1 Push repo
Push folder ini ke satu repo GitHub. (Opsional: jalankan `npm test` dulu di
`worker/` — smoke test offline.)

### 3.2 Deploy Worker (API-only)
1. Dashboard → *Workers & Pages* → *Create* → **Workers** → **Import a repository**.
2. **Root directory: `worker`** (Build command kosong).
3. **Nama Worker** harus `tl-editor-worker` (sama dengan `name` di `worker/wrangler.toml`).
   Kalau Worker lamamu bernama lain, ubah `name` di `wrangler.toml` untuk menyangkut.
4. Deploy. Setelah itu: *Settings → Variables and Secrets* → tambahkan secret
   `GATEWAY_SECRET` bila mau nyalakan gerbang (opsional).

### 3.3 Deploy Pages (frontend statis)
1. *Workers & Pages* → *Create* → **Pages** → **Connect to Git** (repo sama).
2. **Root directory: kosong** (jangan diisi!).
3. **Build command: kosongkan**. **Build output directory: `frontend`**.
4. Cloudflare auto-detect folder `functions/` di root repo. Kalau Function belum
   aktif, **Retry deployment** lalu cek menu *Functions* (harus ada `/api`).

### 3.4 Pasang Service Binding (penghubung)
1. Pages → *Settings* → **Bindings** → **Add** → **Service binding**.
2. **Variable name: `TL_WORKER`** → **Service: `tl-editor-worker`**.
3. **Retry deployment** Pages agar binding aktif.

### 3.5 Cek
Buka `https://<site>.pages.dev`. Tes cepat: `https://<site>.pages.dev/api/health`.
- Kalau keluar `{"ok":true,...}` → **semua nyala** (Function + binding benar).
- Kalau keluar **HTML situs** → Pages Functions belum aktif → pastikan `functions/`
  ada di root, Build output directory = `frontend` (bukan `/`), lalu Retry deployment.

> `worker/wrangler.toml` memakai `workers_dev = false`, jadi Worker **tidak
> punya URL publik** — hanya bisa dijangkau via binding `TL_WORKER`.

### `wrangler.toml` (sudah terisi)

```toml
name = "tl-editor-worker"
main = "index.js"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false          # tanpa URL publik; hanya via binding TL_WORKER

[vars]
MAX_TEXT_BYTES = "400000"
RATE_LIMIT_EDIT = "30"
RATE_LIMIT_OTHER = "60"
# GATEWAY_SECRET: set sebagai Cloudflare Secret (bukan di sini)

# Cloudflare Workers AI via binding (tanpa Account ID / token)
[ai]
binding = "AI"
```

---

## 4. Proteksi kuota & akses

Situs Pages-nya **publik** (siapa pun yang buka bisa call `/api/*`). Provider
BYOK (Gemini/Sumopod/Agnes/Custom) aman — penyalah harus bawa key dia sendiri.
**Tapi jalur Cloudflare `[ai]` binding memakai kuota akunmu**, jadi kunci:

- **GATEWAY_SECRET** (seksi 5): paksa header `X-TL-Gateway`.
- **Cloudflare Access** (gratis) pada domain Pages: minta login Cloudflare /
  email tertentu sebelum boleh buka situs (rekomendasi pola Ocrku).
- **Rate-limiting per-IP** di dashboard (lebih kuat dari limiter in-memory Worker).

### Custom domain (opsional)

Untuk domain sendiri, pasang di **Pages** (*Custom domains*), bukan Worker.
Karena Worker tak punya URL publik, semua traffic masuk lewat
Pages → Functions → binding `TL_WORKER`.

---

## 5. Gerbang rahasia (GATEWAY_SECRET) — *kencangkan ini di produksi*

Tanpa `GATEWAY_SECRET`, `/api/*` terbuka bagi siapa pun yang tahu URL-nya
(tetap ada HTTPS-only, anti-SSRF, dan rate-limit). Untuk produksi:

```bash
# CLI (setelah wrangler login):
cd worker
npx wrangler secret put GATEWAY_SECRET
# atau dashboard: Worker → Settings → Variables and Secrets → Add → Secret.
```

- Worker kini **menolak** request `/api/*` yang tidak menyertakan header
  `X-TL-Gateway` yang sama (perbandingan constant-time).
- Di frontend: **⚙ Pengaturan** → *Gateway Secret* → isi nilai yang sama → Simpan.
- Frontend otomatis mengirim `X-TL-Gateway` pada tiap panggilan API.

---

## 6. Rujukan environment & API

### Env (Worker)

| Var | Default | Fungsi |
|---|---|---|
| `GATEWAY_SECRET` | unset (off) | Set sebagai **secret** Worker; bila ada, `/api/*` wajib header `X-TL-Gateway` yang cocok. |
| `MAX_TEXT_BYTES` | `400000` | Batas ukuran teks sumber/hasil (karakter) per request. |
| `RATE_LIMIT_EDIT` | `30` | Maks `/api/edit` per IP per 60 dtk. |
| `RATE_LIMIT_OTHER` | `60` | Maks endpoint `/api/*` lain per IP per 60 dtk. |
| `TL_WORKER` | — | **Service binding** (Pages → Worker) yang dipakai `functions/api/[[path]].js` |
| `AI` | — | Binding Cloudflare Workers AI (dari `[ai]` di `wrangler.toml`) |
| `CORS_ALLOWED_ORIGINS` | `""` | Daftar origin koma (jarang butuh karena same-origin Pages). |

> Rate-limiter di-*in-memory* per isolate (ephemeral) — best-effort, bukan
> pengganti limit keras. Untuk pembatasan lebih kuat gunakan Cloudflare
> per-IP rate-limiting di dashboard.

### Endpoint

| Method | Path | Body / Query | Return |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, providers, gatewayProtected }` |
| GET | `/api/models?provider=&keys=&cf=&cust=` | `keys`=JSON array; `cf`=account id; `cust`=JSON `{baseUrl,format}` | `{ ok, provider, models:[{id,displayName}] }` |
| POST | `/api/ping` | `{ provider, model?, keys:[] }` (+`cloudflare`/`custom` bila perlu) | `{ ok, results:[{index, ok, code?, detail?}] }` |
| POST | `/api/edit` | `{ provider, model, keys:[], text, sourceText?, systemPrompt?, temperature, maxOutputTokens, strategy, cloudflare?, custom? }` | `{ ok, provider, model, keyUsed, keyCount, raw, usage }` |

Header opsional: `X-TL-Gateway` (bila `GATEWAY_SECRET` aktif).

**Multi-key / load-balancing:** `keys` berisi banyak key. Default
`strategy:"sequential"` — coba key #0, bila status retryable (401/403/429/5xx)
putar ke key berikutnya; `404` (model tak ada) atau 4xx lain langsung berhenti.
`strategy:"round-robin"` memulai dari indeks acak. `keyUsed` mengindikasikan
key mana yang berhasil.

---

## 7. Alur pemakaian akhir (end-user)

1. **Passphrase sekali-pakai** — saat pertama kali menambah key, pilih:
   - **Simpan di perangkat** → kunci vault AES-GCM + PBKDF2 (localStorage),
     passphrase tak bisa dipulihkan; **atau**
   - **Hanya sesi** → tak disimpan ke browser (hilang saat tab ditutup).
2. **Pilih provider**, tambahkan 1…n API key (multi-key = load balancing).
   Klik **Ping All** untuk memvalidasi tiap key.
3. **Load Models** menarik daftar model live dari provider (katalog dinamis),
   atau ketik model manual.
4. **Tempel / unggah** file `.txt` hasil terjemahan (opsional: sumber Inggris
   di tab *Sumber ID*). Gunakan **🧹 Normalisasi** bila perlu.
5. Set **temperature** & **max output tokens**, lalu **▶ Proses Editor**.
6. Hasil terbuka di tab **Hasil / Perubahan / Perlu Dicek ⚠️ / Raw**:
   - *Hasil* = naskah tersunting (bisa ditonjolkan beda lewat diff).
   - *Perubahan* = kartu sebelum → sesudah + alasan.
   - *Perlu Dicek* = item ambigu untuk review manual.
   Salin / unduh `.txt`.

> Catatan model: **Gemini memakai jalur terkini** (`gemini-3.8-flash` dsb.);
> UI *tidak* menyarankan model Gemini 2 / 2.5-flash yang sudah
> discontinued.

---

## 8. Keamanan

- **Vault**: API key terenkripsi **AES-256-GCM**, kunci diturunkan dari
  passphrase via **PBKDF2 (SHA-256, 310k iterasi)**. Plaintext hanya di
  memori selama sesi. Tersimpan di `localStorage` (mode perangkat) atau
  `sessionStorage` (mode sesi).
- **Tidak ada log key**: Worker tidak pernah mencatat key / response.
- **HTTPS-only + anti-SSRF**: semua host provider dipin (pinned); endpoint
  custom wajib `https://`, port 443, tanpa kredensial di URL, dan menolak
  host loopback / RFC1918 / metadata-cloud / CGNAT.
- **Gateway secret**: constant-time compare, opsional.
- **Rate-limit** per IP+path; header keamanan ketat (CSP, nosniff, X-Frame-Options,
  Referrer-Policy, CORP, COOP) di semua respons statis & API.
- **Kunci Vault dapat dihapus** dari panel *Keamanan* → *Hapus Semua Key*.

### Batasan / catatan (by design)

- Vault bersifat **per-browser / per-perangkat** (localStorage). Migrasi antar
  perangkat = input ulang key (atau salin terenkripsi manual — jangan).
- Tidak ada **persistence server** untuk key: key hanya in-flight di request.
- Rate-limit in-memory bersifat best-effort (isolate efemeral).
- **CORS**: default memantulkan origin yang sama host. Untuk setup Pages +
  Worker beda domain, set `CORS_ALLOWED_ORIGINS` (Worker) dan isi *URL Worker*
  di frontend.

---

## 9. Troubleshooting

| Gejala | Solusi |
|---|---|
| Chip status "Worker belum tercapai" | Cek `https://<site>/api/health` → harus `{"ok":true,...}`. Kalau HTML → Pages Functions belum aktif (Retry deployment). |
| `NO_BINDING` (502 dari Function) | Service binding `TL_WORKER` belum/berbeda. Pages → Bindings → Service binding `TL_WORKER` → `tl-editor-worker`, lalu Retry. |
| `UNAUTHORIZED` | `GATEWAY_SECRET` aktif; isi *Gateway Secret* di frontend dengan nilai yang sama. |
| `RATE_LIMITED` | Tunggu 1 menit; atau naikkan `RATE_LIMIT_*` / pakai rate-limiting dashboard. |
| `PROVIDER_FAILED` | Cek validitas key (Ping All), nama model, kuota/limit provider. |
| `SSRF_BLOCKED` / `HTTPS_ONLY` | Endpoint custom harus `https://` publik, port 443, tanpa IP privat. |
| `TEXT_TOO_LONG` | Bagi file; atau naikkan `MAX_TEXT_BYTES`. |
| Frontend blank / 404 | Pages: Build output directory harus `frontend` (bukan `/`), lalu Retry deployment. |

---

## 10. Perintah ringkas

```bash
cd worker
npm install
npm test           # smoke test offline (27 check)
npm run dev        # dev lokal /api di http://localhost:8787
# Deploy utama lewat dashboard (seksi 3): Worker "Import a repository"
# (root: worker), Pages "Connect to Git" (output: frontend), lalu Service
# binding TL_WORKER → tl-editor-worker, Retry Pages.
npx wrangler secret put GATEWAY_SECRET   # (opsional) gerbang rahasia
```
