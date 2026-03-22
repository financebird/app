/**
 * FinanceBird — Worker A: financebird-proxy
 * Blind CORS-Proxy zu api.notion.com
 * Prüft X-FB-Key (Shared Secret) + X-FB-License (Lizenz-Key per KV)
 * Kein Logging, kein Datenzugriff, sieht keine Finanzdaten.
 *
 * KV-Binding: LICENSE_KV (= selber Namespace wie Worker B OAUTH_KV, read-only)
 * Env: FB_SHARED_SECRET
 *
 * Audit-Fix 2026-03-22:
 *   - KV-Lookup nutzt jetzt 'license:' Prefix (konsistent mit Worker B)
 *   - Lizenz-Key wird uppercase-normalisiert (konsistent mit Worker B)
 *
 * Deploy: https://financebird-proxy.[subdomain].workers.dev/v1
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // 1. Shared Secret prüfen (Spam-Filter)
    const fbKey = request.headers.get('X-FB-Key');
    if (!fbKey || fbKey !== env.FB_SHARED_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // 2. Lizenz-Key prüfen (KV-Lookup mit 'license:' Prefix)
    const licenseKey = (request.headers.get('X-FB-License') || '').toUpperCase().trim();
    if (!licenseKey) {
      return json({ error: 'License key required' }, 403);
    }

    const entry = await env.LICENSE_KV.get('license:' + licenseKey, { type: 'json' }).catch(() => null);
    if (!entry || entry.active === false) {
      return json({ error: 'Invalid or expired license' }, 403);
    }

    // Optional: Ablaufdatum prüfen
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      return json({ error: 'License expired' }, 403);
    }

    // lastUsed Tracking — non-blocking (Audit-Fix: Nutzungsstatistik)
    // Schreibt nur Timestamp, keine personenbezogenen Daten
    const now = new Date().toISOString();
    if (!entry.lastUsed || entry.lastUsed.slice(0, 13) !== now.slice(0, 13)) {
      // Max 1x pro Stunde updaten (reduziert KV-Writes)
      entry.lastUsed = now;
      env.LICENSE_KV.put('license:' + licenseKey, JSON.stringify(entry)).catch(() => {});
    }

    // 3. Request an Notion weiterleiten (blind — kein Logging)
    const url = new URL(request.url);
    // Pfad: /v1/... → https://api.notion.com/v1/...
    const notionPath = url.pathname.replace(/^\/v1/, '') || '/';
    const notionUrl  = 'https://api.notion.com/v1' + notionPath + url.search;

    // Headers durchleiten — eigene Worker-Header entfernen
    const headers = new Headers(request.headers);
    headers.delete('X-FB-Key');
    headers.delete('X-FB-License');
    headers.set('Host', 'api.notion.com');

    const notionResp = await fetch(notionUrl, {
      method:  request.method,
      headers: headers,
      body:    ['GET', 'HEAD'].includes(request.method) ? null : request.body,
    });

    // Notion-Response mit CORS-Headern zurückgeben
    const respHeaders = new Headers(notionResp.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => respHeaders.set(k, v));

    return new Response(notionResp.body, {
      status:  notionResp.status,
      headers: respHeaders,
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version, X-FB-Key, X-FB-License',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
