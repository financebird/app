/**
 * FinanceBird · Cloudflare Worker
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploy via: https://deploy.workers.cloudflare.com
 *
 * Endpoints:
 *   GET/POST /v1/*           → Notion API CORS-Proxy
 *   GET  /oauth/start        → Notion OAuth initiieren
 *   GET  /oauth/callback     → Notion OAuth abschliessen
 *   POST /feedback           → Feedback an Osis Notion weiterleiten
 *   GET  /health             → Status-Check
 *
 * Environment Variables (in Cloudflare Dashboard setzen):
 *   NOTION_TOKEN          Dein Notion Integration Token (ntn_…)
 *   NOTION_CLIENT_ID      Notion OAuth App Client ID
 *   NOTION_CLIENT_SECRET  Notion OAuth App Client Secret
 *   OAUTH_REDIRECT_URI    z.B. https://dein-worker.workers.dev/oauth/callback
 *   APP_URL               z.B. https://financebird.github.io/app/financebird_v2.html
 *   FEEDBACK_DB_ID        Notion DB ID für Feedback (optional)
 *   FEEDBACK_TOKEN        Separater Token für Feedback-DB (optional, sonst NOTION_TOKEN)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

/* ── CORS Header ── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Notion-Version',
  'Access-Control-Max-Age':       '86400',
};

/* ═══════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════ */
export default {
  async fetch(request, env) {
    const url     = new URL(request.url);
    const path    = url.pathname;
    const method  = request.method;

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // ── Routes ──
      if (path === '/health' || path === '/') {
        return jsonResponse({ ok: true, version: '2', service: 'FinanceBird Worker' });
      }

      if (path === '/oauth/start') {
        return handleOAuthStart(url, env);
      }

      if (path === '/oauth/callback') {
        return handleOAuthCallback(url, env);
      }

      if (path === '/feedback' && method === 'POST') {
        return handleFeedback(request, env);
      }

      if (path.startsWith('/v1/')) {
        return handleNotionProxy(request, url, path, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (e) {
      console.error('[Worker] Unhandled error:', e);
      return jsonResponse({ error: 'Internal server error', detail: e.message }, 500);
    }
  }
};

/* ═══════════════════════════════════════════════════════
   NOTION API PROXY
   Leitet alle Anfragen an die Notion API weiter.
   Token aus env.NOTION_TOKEN ODER aus Authorization-Header.
   ═══════════════════════════════════════════════════════ */
async function handleNotionProxy(request, url, path, env) {
  // Notion API Pfad: /v1/databases/... → /databases/...
  const notionPath = path.replace(/^\/v1/, '');
  const notionUrl  = NOTION_API + notionPath + url.search;

  // Token: bevorzuge env-Variable, fallback auf Authorization-Header
  const clientAuth = request.headers.get('Authorization') || '';
  const token      = (env.NOTION_TOKEN && env.NOTION_TOKEN.trim())
    ? `Bearer ${env.NOTION_TOKEN}`
    : clientAuth;

  if (!token) {
    return jsonResponse({ error: 'No Notion token configured' }, 401);
  }

  // Body weiterleiten
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();

  const notionResp = await fetch(notionUrl, {
    method:  request.method,
    headers: {
      'Authorization':  token,
      'Notion-Version': NOTION_VER,
      'Content-Type':   'application/json',
    },
    body,
  });

  const respBody = await notionResp.text();

  return new Response(respBody, {
    status:  notionResp.status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
    },
  });
}

/* ═══════════════════════════════════════════════════════
   OAUTH — START
   Redirectet den Browser zur Notion OAuth-Seite.
   ═══════════════════════════════════════════════════════ */
function handleOAuthStart(url, env) {
  const clientId    = env.NOTION_CLIENT_ID;
  const redirectUri = env.OAUTH_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return jsonResponse({
      error: 'OAuth not configured',
      hint:  'Set NOTION_CLIENT_ID and OAUTH_REDIRECT_URI in Worker environment'
    }, 503);
  }

  // State aus URL übernehmen (CSRF-Schutz, kommt von der App)
  const state = url.searchParams.get('state') || crypto.randomUUID();

  const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('owner',         'user');
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('state',         state);

  return Response.redirect(authUrl.toString(), 302);
}

/* ═══════════════════════════════════════════════════════
   OAUTH — CALLBACK
   Tauscht Code gegen Token, gibt Token an App zurück.
   ═══════════════════════════════════════════════════════ */
async function handleOAuthCallback(url, env) {
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  const appUrl = env.APP_URL || 'https://financebird.github.io/app/financebird_v2.html';

  if (error || !code) {
    return Response.redirect(`${appUrl}?oauth_error=${error || 'no_code'}`, 302);
  }

  const clientId     = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;
  const redirectUri  = env.OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return Response.redirect(`${appUrl}?oauth_error=worker_not_configured`, 302);
  }

  // Code gegen Token tauschen
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const tokenResp   = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization':  `Basic ${credentials}`,
      'Content-Type':   'application/json',
      'Notion-Version': NOTION_VER,
    },
    body: JSON.stringify({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error('[OAuth] Token exchange failed:', err);
    return Response.redirect(`${appUrl}?oauth_error=token_exchange_failed`, 302);
  }

  const tokenData = await tokenResp.json();

  // Token sicher an App übergeben: als URL-Fragment (#) — landet nicht im Server-Log
  const fragment = encodeURIComponent(JSON.stringify({
    access_token:       tokenData.access_token,
    workspace_name:     tokenData.workspace_name,
    workspace_id:       tokenData.workspace_id,
    bot_id:             tokenData.bot_id,
  }));

  return Response.redirect(`${appUrl}?oauth_success=1#token=${fragment}`, 302);
}

/* ═══════════════════════════════════════════════════════
   FEEDBACK
   Speichert Feedback in Osis Notion-DB.
   Niemals mit Nutzerdaten vermischt.
   ═══════════════════════════════════════════════════════ */
async function handleFeedback(request, env) {
  const dbId = env.FEEDBACK_DB_ID;
  if (!dbId) {
    // Feedback-DB nicht konfiguriert — still ignorieren (kein Fail für Nutzer)
    return jsonResponse({ ok: true, stored: false });
  }

  const token = env.FEEDBACK_TOKEN || env.NOTION_TOKEN;
  if (!token) {
    return jsonResponse({ ok: false, error: 'No token for feedback' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { text = '', email = '', version = '', diagnostics = '' } = body;

  // Notion-Page in Feedback-DB erstellen
  const page = {
    parent: { database_id: dbId },
    properties: {
      'Name':    { title:      [{ text: { content: text.slice(0, 100) || '(kein Text)' } }] },
      'Email':   { email:      email || null },
      'Version': { rich_text:  [{ text: { content: version } }] },
      'Datum':   { date:       { start: new Date().toISOString().split('T')[0] } },
    },
  };

  // Diagnose-Daten als Body-Block anhängen wenn vorhanden
  const children = diagnostics
    ? [{
        object: 'block',
        type:   'code',
        code:   {
          rich_text: [{ type: 'text', text: { content: diagnostics.slice(0, 2000) } }],
          language:  'json',
        },
      }]
    : undefined;

  if (children) page.children = children;

  const resp = await fetch(`${NOTION_API}/pages`, {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Notion-Version': NOTION_VER,
      'Content-Type':   'application/json',
    },
    body: JSON.stringify(page),
  });

  if (!resp.ok) {
    console.error('[Feedback] Notion error:', await resp.text());
    return jsonResponse({ ok: false, error: 'Notion write failed' }, 502);
  }

  return jsonResponse({ ok: true, stored: true });
}

/* ── Hilfsfunktionen ── */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
