// FinanceBird Service Worker — Web Share Target Handler
// Fängt geteilte Dateien (Bilder/PDFs) ab und leitet sie an die App weiter

const CACHE_NAME = 'financebird-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Web Share Target: POST-Request mit geteilter Datei abfangen
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nur Share-Target-Requests (POST auf die App-URL)
  if (event.request.method !== 'POST') return;
  if (!url.pathname.includes('financebird_v1.html')) return;

  event.respondWith((async () => {
    const formData = await event.request.formData();
    const file = formData.get('beleg');

    if (file && file instanceof File) {
      // Datei als ArrayBuffer lesen und im Cache zwischenspeichern
      const arrayBuffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      const sharedData = {
        name: file.name,
        type: file.type,
        data: `data:${file.type};base64,${base64}`,
        timestamp: Date.now()
      };

      // An alle offenen App-Fenster schicken
      const allClients = await clients.matchAll({ includeUncontrolled: true, type: 'window' });
      if (allClients.length > 0) {
        // App ist bereits offen — direkt posten
        allClients[0].postMessage({ type: 'SHARED_BELEG', payload: sharedData });
        allClients[0].focus();
      } else {
        // App ist zu — in Cache speichern, App öffnen
        const cache = await caches.open(CACHE_NAME);
        await cache.put('/__shared_beleg__', new Response(JSON.stringify(sharedData), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // App-URL öffnen (redirect zurück zur App)
    return Response.redirect('/budget-app/financebird_v1.html?shared=1', 303);
  })());
});

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
