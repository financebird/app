// FinanceBird Service Worker v2
// Share-Target-Handler + Offline-Cache Shell
// Fängt Share-Target-POSTs ab und cached die App-Shell für Offline

const CACHE_NAME   = 'financebird-v2.5d-20260327';
const APP_SHELL    = [
  './financebird_v2.html',
  // Fonts werden von Google geladen — kein Cache nötig (Fallback: System-Font)
];

/* ── Install: App-Shell cachen ── */
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => {
      // Offline-Cache optional — kein harter Fail
    })
  );
});

/* ── Activate: Alte Caches löschen ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

/* ── Fetch: Share-Target abfangen, sonst Network-First ── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Share-Target: POST auf die App-URL
  const isShareTarget = event.request.method === 'POST'
    && (url.pathname.endsWith('financebird_v2.html') || url.pathname.endsWith('/'));

  if (isShareTarget) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // App-Shell: Cache-First für die Haupt-HTML
  if (event.request.method === 'GET' && url.pathname.endsWith('financebird_v2.html')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Alles andere: Netzwerk (SW macht nichts)
});

/* ── Share-Target Handler ── */
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file     = formData.get('beleg');

    if (file && file instanceof File) {
      const arrayBuffer = await file.arrayBuffer();
      const base64      = arrayBufferToBase64(arrayBuffer);
      const isPDF       = file.type === 'application/pdf';
      const dataUrl     = `data:${file.type};base64,${base64}`;

      // App-Message im Format das financebird_v2.html erwartet:
      // { type: 'SHARED_BELEG', dataUrl, filename, isPDF }
      const message = {
        type:     'SHARED_BELEG',
        dataUrl,
        filename: file.name,
        isPDF,
      };

      const allClients = await clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      });

      if (allClients.length > 0) {
        // App ist offen — direkt senden
        allClients[0].postMessage(message);
        try { allClients[0].focus(); } catch (_) {}
      } else {
        // App ist geschlossen — im Cache parken
        const cache = await caches.open(CACHE_NAME);
        await cache.put('/__shared_beleg__', new Response(JSON.stringify(message), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
    }
  } catch (e) {
    console.warn('[SW] Share handler error:', e);
  }

  // Redirect zurück zur App (GitHub Pages Pfad)
  return Response.redirect('./financebird_v2.html?shared=1', 303);
}

/* ── Pending Share beim App-Start abliefern ── */
self.addEventListener('message', async event => {
  if (event.data?.type === 'CHECK_SHARED_BELEG') {
    const cache    = await caches.open(CACHE_NAME);
    const response = await cache.match('/__shared_beleg__');
    if (response) {
      const message = await response.json();
      await cache.delete('/__shared_beleg__');
      event.source.postMessage(message);
    }
  }
});

/* ── Hilfsfunktion ── */
function arrayBufferToBase64(buffer) {
  let binary      = '';
  const bytes     = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
