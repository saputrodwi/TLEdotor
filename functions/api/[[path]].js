// Cloudflare Pages Function — forwards /api/* to the bound Worker.
//
// Deploy structure (mirrors Ocrku):
//   - This file lives in functions/ at the REPO ROOT; Pages auto-detects it.
//   - A Service Binding named TL_WORKER points at the API-only Worker
//     (create it in Pages → Settings → Bindings → Add → Service binding).
//   - Everything NOT under /api/* is served as static from the Pages build
//     output (frontend/), so no _routes.json whitelist is needed.
//
// The frontend calls /api/... with a relative path; this function proxies it
// to the Worker, which then proxies to the chosen AI provider.

export function onRequest(context) {
  const { request, env, next } = context;

  // If the binding is missing (e.g. Pages deployed before the service binding
  // was added / retry-deploy not run), surface a clear error instead of a 500.
  if (!env.TL_WORKER) {
    const body = JSON.stringify({
      ok: false,
      code: 'NO_BINDING',
      message:
        'Service binding TL_WORKER belum aktif. Pastikan Worker ter-deploy, ' +
        'lalu di Pages → Settings → Bindings tambahkan Service binding ' +
        'TL_WORKER → ocr.../tl-editor-worker, dan Retry deployment.',
    });
    return new Response(body, {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // Pass the request through to the Worker's fetch(req, env, ctx).
  // The Worker routes on the pathname (/api/*) and reads cf-connecting-ip for
  // rate limiting, so forwarding the original request is correct.
  return env.TL_WORKER.fetch(request);
}
