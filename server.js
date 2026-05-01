/**
 * FormaFlow UI Server
 * Serves the web UI and exposes REST + SSE endpoints that back every tab.
 *
 * Start:  npm start          (production)
 *         npm run dev        (auto-restart on change)
 * Open:   http://localhost:3000
 */

import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;

/** Broadcasts log entries to all connected SSE clients */
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(resolve(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// .env helpers
// ─────────────────────────────────────────────────────────────────────────────

// Canonical keys FormaFlow uses
const ENV_KEYS = [
  'APS_CLIENT_ID', 'APS_CLIENT_SECRET',
  'ACC_ACCOUNT_ID', 'ACC_PROJECT_ID',
  'MC_CONTAINER_ID', 'MC_MODEL_SET_ID', 'TARGET_FOLDER_URN',
  'LOG_LEVEL', 'DRY_RUN',
];

// process.env aliases → canonical key (applied when canonical is absent)
const ENV_ALIASES = { APS_HUB_ID: 'ACC_ACCOUNT_ID' };

function readEnv() {
  // Read the .env file first (explicit file values win over injected env)
  const filePath = resolve(__dirname, '.env');
  const fileValues = {};
  if (existsSync(filePath)) {
    for (const raw of readFileSync(filePath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      fileValues[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }

  // Merge: .env file value → process.env value → empty string
  const out = {};
  for (const key of ENV_KEYS) {
    out[key] = fileValues[key] ?? process.env[key] ?? '';
  }

  // Apply aliases: if canonical key is still empty, check the alias name
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    if (!out[canonical] && process.env[alias]?.trim()) {
      out[canonical] = process.env[alias].trim();
    }
  }

  return out;
}

function writeEnv(updates) {
  const current = readEnv();
  const merged = { ...current, ...updates };
  const examplePath = resolve(__dirname, '.env.example');
  let lines = [];

  if (existsSync(examplePath)) {
    const written = new Set();
    for (const raw of readFileSync(examplePath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) { lines.push(raw); continue; }
      const eq = line.indexOf('=');
      if (eq < 0) { lines.push(raw); continue; }
      const key = line.slice(0, eq).trim();
      written.add(key);
      lines.push(`${key}=${merged[key] ?? ''}`);
    }
    for (const [k, v] of Object.entries(merged)) {
      if (!written.has(k)) lines.push(`${k}=${v}`);
    }
  } else {
    lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  }

  writeFileSync(resolve(__dirname, '.env'), lines.join('\n'), 'utf8');
  // Sync into current process.env immediately
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON config helpers
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_DIR = resolve(__dirname, 'config');

function readConfig(name) {
  return JSON.parse(readFileSync(resolve(CONFIG_DIR, name), 'utf8'));
}

function writeConfig(name, data) {
  writeFileSync(resolve(CONFIG_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3-legged OAuth — token store
// ─────────────────────────────────────────────────────────────────────────────

const TOKENS_PATH = resolve(__dirname, 'config', 'auth-tokens.json');

// The callback URL must be registered in the APS application's Callback URLs list.
// Set APS_CALLBACK_URL in .env to match your deployed URL; defaults to localhost.
function getCallbackUrl() {
  return process.env.APS_CALLBACK_URL
    || `http://localhost:${PORT}/api/auth/callback`;
}

function readTokens() {
  try { return JSON.parse(readFileSync(TOKENS_PATH, 'utf8')); }
  catch { return null; }
}

function writeTokensFile(data) {
  mkdirSync(resolve(__dirname, 'config'), { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2));
}

async function refreshStoredToken() {
  const stored = readTokens();
  if (!stored?.refresh_token) return null;
  try {
    const res = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: stored.refresh_token,
        client_id:     process.env.APS_CLIENT_ID,
        client_secret: process.env.APS_CLIENT_SECRET,
      }),
    });
    if (!res.ok) { console.warn('[FormaFlow] Token refresh failed:', res.status); return null; }
    const data = await res.json();
    writeTokensFile({
      ...stored,
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? stored.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    });
    return data.access_token;
  } catch (err) {
    console.warn('[FormaFlow] Token refresh error:', err.message);
    return null;
  }
}

// Returns a valid 3-legged access token, refreshing if needed. Returns null if
// no service-account session has been established yet.
async function getThreeLeggedToken() {
  const stored = readTokens();
  if (!stored) return null;
  if (Date.now() < stored.expires_at - 60_000) return stored.access_token;
  return refreshStoredToken();
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes — 3-legged OAuth
// ─────────────────────────────────────────────────────────────────────────────

/** Step 1: Redirect browser to Autodesk OAuth consent screen */
app.get('/api/auth/login', (req, res) => {
  const clientId = process.env.APS_CLIENT_ID;
  if (!clientId) return res.status(500).send('APS_CLIENT_ID not set');
  const url = new URL('https://developer.api.autodesk.com/authentication/v2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', getCallbackUrl());
  url.searchParams.set('scope', 'data:read data:write data:create account:read account:write viewables:read openid');
  res.redirect(url.toString());
});

/** Step 2: Exchange authorization code for tokens */
app.get('/api/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?auth=error&msg=missing_code');
  try {
    const tokenRes = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        client_id:    process.env.APS_CLIENT_ID,
        client_secret: process.env.APS_CLIENT_SECRET,
        redirect_uri: getCallbackUrl(),
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    // Fetch user profile so the UI can show who is logged in
    let email = '', name = '';
    try {
      const profileRes = await fetch('https://developer.api.autodesk.com/authentication/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (profileRes.ok) {
        const p = await profileRes.json();
        email = p.email ?? '';
        name  = p.name ?? p.preferred_username ?? '';
      }
    } catch { /* profile fetch is best-effort */ }

    writeTokensFile({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + tokens.expires_in * 1000,
      email, name,
      saved_at: new Date().toISOString(),
    });
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[FormaFlow] OAuth callback error:', err.message);
    res.redirect(`/?auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

/** Returns login status + email of the stored service account */
app.get('/api/auth/status', (_req, res) => {
  const stored = readTokens();
  if (!stored) return res.json({ loggedIn: false });
  const expired = Date.now() >= stored.expires_at - 60_000;
  res.json({
    loggedIn:  true,
    email:     stored.email,
    name:      stored.name,
    expiresAt: stored.expires_at,
    expired,
    savedAt:   stored.saved_at,
  });
});

/** Clear stored service account session */
app.post('/api/auth/logout', (_req, res) => {
  try { unlinkSync(TOKENS_PATH); } catch { /* already gone */ }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility — safely extract an array from an unknown APS API response.
// APS endpoints are inconsistent: some return {data:[...]}, some {results:[...]},
// some {modelSets:[...]}, and some return the array directly.
// This prevents "X is not iterable" crashes when a new/empty resource returns {}.
// ─────────────────────────────────────────────────────────────────────────────

function toArray(raw, ...extraKeys) {
  if (Array.isArray(raw)) return raw;
  const keys = ['data', 'results', 'items', 'sets', ...extraKeys];
  for (const k of keys) {
    if (Array.isArray(raw?.[k])) return raw[k];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// APS client factory — prefers 3-legged service-account token, falls back to 2-legged
// ─────────────────────────────────────────────────────────────────────────────

async function makeAPSClient(overrides = {}) {
  const { APSClient } = await import('./src/api/aps-client.js');
  const client = new APSClient(
    overrides.clientId ?? process.env.APS_CLIENT_ID,
    overrides.clientSecret ?? process.env.APS_CLIENT_SECRET
  );

  // If we have a stored service-account (3-legged) token, use it — this gives
  // access to all MC endpoints that require a user identity. If the token is
  // expired it is refreshed automatically. Falls back to 2-legged silently.
  if (!overrides.forceTwoLegged) {
    const threeLeggedToken = await getThreeLeggedToken();
    if (threeLeggedToken) {
      const _prototype_getToken = APSClient.prototype.getToken.bind(client);
      client.getToken = async () => {
        const fresh = await getThreeLeggedToken();
        return fresh ?? _prototype_getToken();
      };
    }
  }

  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup diagnostic — log the resolved MC URLs so stale env overrides are
// immediately visible in Railway/etc. logs.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rawMs   = process.env.MC_MODELSET_API_BASE || '(default)';
  const fixedMs = (process.env.MC_MODELSET_API_BASE
    ?? 'https://developer.api.autodesk.com/bim360/modelset/v3')
    .replace('/bim360/modelcoordination/', '/bim360/');
  const rawCl   = process.env.MC_CLASH_API_BASE || '(default)';
  const fixedCl = (process.env.MC_CLASH_API_BASE
    ?? 'https://developer.api.autodesk.com/bim360/clash/v3')
    .replace('/bim360/modelcoordination/', '/bim360/');
  console.log('[FormaFlow] MC_MODELSET_API_BASE: %s → %s', rawMs, fixedMs);
  console.log('[FormaFlow] MC_CLASH_API_BASE:    %s → %s', rawCl, fixedCl);
  if (rawMs.includes('modelcoordination/') || rawCl.includes('modelcoordination/')) {
    console.warn('[FormaFlow] ⚠ Stale .env override detected — auto-correcting at runtime.');
    console.warn('[FormaFlow]   Recommended: remove MC_MODELSET_API_BASE / MC_CLASH_API_BASE from .env');
  }
}

/**
 * Diagnostic: full auth + env summary.
 * Reports which credentials are set, whether a 3-legged token is stored,
 * and the effective MC API URLs — useful for debugging access issues.
 */
app.get('/api/debug/auth-status', async (_req, res) => {
  const env = readEnv();
  const stored = readTokens();
  const threeLeggedToken = await getThreeLeggedToken();
  res.json({
    twoLegged: {
      clientIdSet:     !!env.APS_CLIENT_ID,
      clientSecretSet: !!env.APS_CLIENT_SECRET,
      scopes: 'data:read data:write data:create account:read account:write viewables:read',
    },
    threeLeggedSession: stored ? {
      loggedIn:   true,
      email:      stored.email,
      name:       stored.name,
      expired:    !threeLeggedToken,
      expiresAt:  stored.expires_at,
      savedAt:    stored.saved_at,
    } : { loggedIn: false },
    mcApiAccess: {
      note: 'MC API (modelset v3, clash v3) requires 3-legged OAuth. 2-legged S2S tokens return 403.',
      recommendation: threeLeggedToken
        ? 'Three-legged token present — MC API calls should work if the app is provisioned in ACC.'
        : 'No 3-legged token stored. Use Service Account Login (Connect tab) or add a Web App APS credential with a callback URL.',
    },
    projectContext: {
      accountId:   env.ACC_ACCOUNT_ID  || null,
      projectId:   env.ACC_PROJECT_ID  || null,
      containerId: env.MC_CONTAINER_ID || null,
      modelSetId:  env.MC_MODEL_SET_ID || null,
    },
  });
});

/** Diagnostic: returns the actual URLs the server will use for MC calls */
app.get('/api/debug/mc-config', (_req, res) => {
  const ms = (process.env.MC_MODELSET_API_BASE
    ?? 'https://developer.api.autodesk.com/bim360/modelset/v3')
    .replace('/bim360/modelcoordination/', '/bim360/');
  const cl = (process.env.MC_CLASH_API_BASE
    ?? 'https://developer.api.autodesk.com/bim360/clash/v3')
    .replace('/bim360/modelcoordination/', '/bim360/');
  res.json({
    rawEnv: {
      MC_MODELSET_API_BASE: process.env.MC_MODELSET_API_BASE || null,
      MC_CLASH_API_BASE:    process.env.MC_CLASH_API_BASE    || null,
    },
    resolved: { MC_MODELSET_BASE: ms, MC_CLASH_BASE: cl },
    container:        process.env.MC_CONTAINER_ID || null,
    activeModelSetId: process.env.MC_MODEL_SET_ID || null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Return all config (env vars redacted + all JSON configs) */
app.get('/api/config', (_req, res) => {
  const env = readEnv();
  res.json({
    env: {
      APS_CLIENT_ID:    env.APS_CLIENT_ID    ?? '',
      APS_CLIENT_SECRET: env.APS_CLIENT_SECRET ? '••••••••••••••' : '',
      ACC_ACCOUNT_ID:   env.ACC_ACCOUNT_ID   ?? '',
      ACC_PROJECT_ID:   env.ACC_PROJECT_ID   ?? '',
      MC_CONTAINER_ID:  env.MC_CONTAINER_ID  ?? '',
      MC_MODEL_SET_ID:  env.MC_MODEL_SET_ID  ?? '',
      TARGET_FOLDER_URN: env.TARGET_FOLDER_URN ?? '',
      LOG_LEVEL: env.LOG_LEVEL ?? 'info',
      DRY_RUN:   env.DRY_RUN   ?? 'false',
    },
    hasSecret:   !!env.APS_CLIENT_SECRET,
    searchSets:  readConfig('search-set-library.json'),
    clashTests:  readConfig('clash-test-templates.json'),
    workflow:    readConfig('workflow-config.json'),
    naming:      readConfig('naming-conventions.json'),
    disciplines: readConfig('discipline-rules.json'),
  });
});

/** Save env vars */
app.post('/api/config/env', (req, res) => {
  try {
    const ALLOWED = [
      'APS_CLIENT_ID', 'APS_CLIENT_SECRET',
      'ACC_ACCOUNT_ID', 'ACC_PROJECT_ID',
      'MC_CONTAINER_ID', 'MC_MODEL_SET_ID', 'TARGET_FOLDER_URN',
      'LOG_LEVEL', 'DRY_RUN',
    ];
    const toSave = {};
    for (const k of ALLOWED) {
      const v = req.body[k];
      if (v !== undefined && v !== '••••••••••••••') toSave[k] = v;
    }
    writeEnv(toSave);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Return a full capability analysis based on current environment */
app.get('/api/capabilities', async (_req, res) => {
  try {
    const { detectCapabilities } = await import('./src/utils/capability-detector.js');
    const result = detectCapabilities();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — APS Viewer
// ─────────────────────────────────────────────────────────────────────────────

/** Short-lived 2-legged token for the APS Viewer SDK */
app.get('/api/viewer/token', async (_req, res) => {
  try {
    const client = await makeAPSClient();
    const token = await client.getToken();
    res.json({ access_token: token, expires_in: 3600 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resolve the APS Viewer-ready URN for an ACC item.
 * ACC items are already translated by Revit on publish — no OSS upload needed.
 * Returns a base64url-encoded URN suitable for Autodesk.Viewing.Document.load().
 */
app.get('/api/models/viewer-urn', async (req, res) => {
  try {
    const { projectId, itemId } = req.query;
    if (!projectId || !itemId) return res.status(400).json({ error: 'projectId and itemId required' });
    const client = await makeAPSClient();
    const projId = projectId.startsWith('b.') ? projectId : `b.${projectId}`;
    const versionsData = await client.get(
      `https://developer.api.autodesk.com/data/v1/projects/${projId}/items/${itemId}/versions`
    );
    const version = versionsData.data?.[0];
    if (!version) return res.status(404).json({ error: 'No versions found for this item' });

    const itemUrn = version.id; // e.g. urn:adsk.wipprod:fs.file:vf.XXX?version=N
    // base64url-encode (URL-safe, no padding) — required by the Viewer SDK
    const viewerUrn = Buffer.from(itemUrn).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    res.json({
      urn: viewerUrn,
      itemUrn,
      fileName:     version.attributes?.name ?? version.attributes?.displayName,
      version:      version.attributes?.versionNumber ?? 1,
      lastModified: version.attributes?.lastModifiedTime,
      storageSize:  version.attributes?.storageSize ?? null,
    });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Hub / multi-project
// ─────────────────────────────────────────────────────────────────────────────

/** List all projects in the connected ACC hub */
app.get('/api/hub/projects', async (req, res) => {
  try {
    const rawHubId = req.query.hubId || process.env.ACC_ACCOUNT_ID || '';
    const hubId = rawHubId.replace(/^b\./, '');
    if (!hubId) return res.status(400).json({ error: 'hubId required (or set ACC_ACCOUNT_ID)' });
    const client = await makeAPSClient();
    const data = await client.get(
      `https://developer.api.autodesk.com/project/v1/hubs/b.${hubId}/projects?pageNumber=0&pageLimit=100`
    );
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Clash results
// ─────────────────────────────────────────────────────────────────────────────

/** Serve the most recent clash-results JSON produced by the workflow */
app.get('/api/clash/results', (_req, res) => {
  try {
    const resultsDir = resolve(__dirname, 'output', 'clash-results');
    if (!existsSync(resultsDir)) return res.json({ groups: [], summary: null });
    const files = readdirSync(resultsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, full: resolve(resultsDir, f), mtime: statSync(resolve(resultsDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return res.json({ groups: [], summary: null });
    res.json(JSON.parse(readFileSync(files[0].full, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config/search-sets', (req, res) => {
  try { writeConfig('search-set-library.json', req.body); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Search Set extras (Navisworks import)
// ─────────────────────────────────────────────────────────────────────────────

// Accept raw XML text up to 10 MB
const textXml = express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '10mb' });

/** Parse a Navisworks XML export into FormaFlow search-set objects. */
app.post('/api/search-sets/import-navisworks', textXml, async (req, res) => {
  try {
    const xml = typeof req.body === 'string' ? req.body : '';
    if (!xml.trim()) return res.status(400).json({ error: 'Empty XML body — POST the file contents as text/xml.' });
    const { parseNavisworksXml } = await import('./src/search-sets/navisworks-importer.js');
    const discipline = req.query.discipline ? String(req.query.discipline) : 'UNKNOWN';
    const result = parseNavisworksXml(xml, { defaultDiscipline: discipline });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/config/clash-tests', (req, res) => {
  try { writeConfig('clash-test-templates.json', req.body); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/config/workflow', (req, res) => {
  try { writeConfig('workflow-config.json', req.body); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// Routes — ACC Admin (project access management)
// ─────────────────────────────────────────────────────────────────────────────

const ACC_ADMIN_BASE = 'https://developer.api.autodesk.com/construction/admin/v1';

/**
 * List account admins — used to let the user pick which admin identity to
 * impersonate via the User-Id header for write operations.
 * Works with 2-legged + account:read (read-only, no User-Id needed).
 */
app.get('/api/admin/account-admins', async (req, res) => {
  try {
    const accountId = (req.query.accountId ?? process.env.ACC_ACCOUNT_ID ?? '').replace(/^b\./, '');
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const client = await makeAPSClient();
    const token  = await client.getToken();

    const r = await fetch(
      `${ACC_ADMIN_BASE}/accounts/${accountId}/users?limit=50&sort=name&filterTextMatch=contains&filter[roleIds]=account_admin`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: `ACC Admin API ${r.status}`, details: body });
    }
    const data = await r.json();
    const users = (data.results ?? data.users ?? data ?? []).map(u => ({
      id:          u.id          ?? u.userId,
      autodeskId:  u.autodeskId  ?? u.uid,
      name:        u.name        ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
      email:       u.email,
      roleId:      u.roleId,
    }));
    res.json({ users });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * Check whether the current APS app can reach the MC API for the given project.
 * Returns { ok, status, message }.
 */
app.get('/api/admin/check-mc-access', async (req, res) => {
  try {
    const modelSetId  = req.query.modelSetId  ?? process.env.MC_MODEL_SET_ID;
    const containerId = req.query.containerId ?? process.env.MC_CONTAINER_ID;
    if (!modelSetId || !containerId) {
      return res.json({ ok: false, status: 'missing_config', message: 'Set Coordination Space and Container ID first' });
    }
    const mc = await buildMcClient(req);
    await mc.listModelSets();
    res.json({ ok: true, status: 'ok', message: 'MC API accessible — model sets returned successfully.' });
  } catch (err) {
    const status = err.status ?? 500;
    const hints = {
      403: 'The APS app is not provisioned for this ACC account. An Account Admin must add it as a Custom Integration: ACC Admin → Apps & Integrations → Add Integration → paste Client ID. ' +
           'Note: Model Coordination API also requires a 3-legged (user) OAuth token — 2-legged S2S tokens return 403 even after provisioning. ' +
           'Use the Service Account Login card on the Connect tab to establish a 3-legged session, OR ask Autodesk to enable SSA for your app.',
      401: 'Token is invalid or expired. Check APS_CLIENT_ID / APS_CLIENT_SECRET and retry.',
      404: 'Coordination space not found. Verify MC_CONTAINER_ID matches your ACC Project ID and that Model Coordination is enabled under project Settings → Products & Services.',
    };
    res.json({
      ok:      false,
      status:  status === 403 ? 'forbidden' : status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'error',
      message: err.message,
      hint:    hints[status] ?? 'Unexpected error — check server logs for details.',
      code:    status,
    });
  }
});

/**
 * Attempt to add the APS app as a project service account (project admin).
 *
 * Strategy (in order):
 *  1. POST /projects/{id}/service-accounts  with clientId  (newest — no User-Id needed)
 *  2. POST /projects/{id}/users             with app email  (requires User-Id header)
 *
 * Body params (JSON):
 *   { projectId, accountId, adminUserId? }
 */
app.post('/api/admin/grant-project-access', async (req, res) => {
  try {
    const projectId = (req.body.projectId ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const accountId = (req.body.accountId ?? process.env.ACC_ACCOUNT_ID ?? '').replace(/^b\./, '');
    const adminUserId = req.body.adminUserId ?? '';  // ACC user id of an account admin

    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const client = await makeAPSClient({ forceTwoLegged: true });
    const token  = await client.getToken();
    const clientId = process.env.APS_CLIENT_ID;

    const products = [
      { key: 'projectAdministration', access: 'administrator' },
      { key: 'modelCoordination',     access: 'administrator' },
      { key: 'docs',                  access: 'administrator' },
    ];

    const results = [];

    // ── Strategy 1: /service-accounts (S2S native — no User-Id required) ──
    try {
      const saRes = await fetch(`${ACC_ADMIN_BASE}/projects/${projectId}/service-accounts`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, products }),
      });
      const saBody = await saRes.text();
      results.push({ strategy: 'service-accounts', status: saRes.status, body: saBody });

      if (saRes.ok || saRes.status === 409 /* already exists */) {
        return res.json({
          ok: true,
          strategy: 'service-accounts',
          status: saRes.status,
          message: saRes.status === 409
            ? 'App already has project access'
            : 'App granted project access via service-accounts endpoint',
          raw: saBody,
        });
      }
    } catch (e) {
      results.push({ strategy: 'service-accounts', error: e.message });
    }

    // ── Strategy 2: /users (requires User-Id header) ──
    if (!adminUserId) {
      return res.status(403).json({
        ok: false,
        message: 'Service-accounts endpoint failed. Provide an Account Admin User ID to retry via /users endpoint.',
        tried: results,
      });
    }

    const appEmail = `${clientId}@aps.autodesk.com`;
    const usersRes = await fetch(`${ACC_ADMIN_BASE}/projects/${projectId}/users`, {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Id': adminUserId,
      },
      body: JSON.stringify({ email: appEmail, products }),
    });
    const usersBody = await usersRes.text();
    results.push({ strategy: 'users', status: usersRes.status, body: usersBody });

    if (usersRes.ok || usersRes.status === 409) {
      return res.json({
        ok: true,
        strategy: 'users',
        status: usersRes.status,
        message: usersRes.status === 409
          ? 'App already has project access'
          : 'App granted project access via users endpoint',
        raw: usersBody,
      });
    }

    res.status(usersRes.status).json({
      ok: false,
      message: `All strategies failed (${usersRes.status})`,
      tried: results,
    });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Authentication
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/test', async (req, res) => {
  try {
    const client = await makeAPSClient({
      clientId:     req.body.clientId,
      clientSecret: req.body.clientSecret !== '••••••••••••••' ? req.body.clientSecret : undefined,
    });
    const token = await client.getToken();
    res.json({ ok: true, tokenLength: token.length });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — ACC Project Discovery
// ─────────────────────────────────────────────────────────────────────────────

/** List top-level folders for a given project */
// Folder names that are ACC system/module folders — not useful for coordination
const SYSTEM_FOLDER_PREFIXES = [
  'submittals-', 'quantification_', 'issue_', 'correspondence-project-',
  'meetings-project-', 'checklists-project-', 'rfis-project-', 'photos_',
  'b0', 'b1',
];
const SYSTEM_FOLDER_EXACT = new Set([
  'VIRTUAL_ROOT_FOLDER', 'Photos', 'ProjectTb',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classifyFolder(name = '') {
  if (SYSTEM_FOLDER_EXACT.has(name)) return 'system';
  if (UUID_RE.test(name))            return 'system';
  if (SYSTEM_FOLDER_PREFIXES.some(p => name.startsWith(p))) return 'system';
  return 'user';
}

app.get('/api/project/folders', async (req, res) => {
  try {
    const { accountId, projectId } = req.query;
    if (!accountId || !projectId) return res.status(400).json({ error: 'accountId and projectId required' });
    const client = await makeAPSClient();
    const hubId  = accountId.startsWith('b.') ? accountId : `b.${accountId}`;
    const projId = projectId.startsWith('b.')  ? projectId : `b.${projectId}`;
    const data = await client.get(
      `https://developer.api.autodesk.com/project/v1/hubs/${hubId}/projects/${projId}/topFolders`
    );
    // Annotate each folder with a category so the UI can group them
    const folders = (data?.data ?? []).map(f => ({
      ...f,
      _category: classifyFolder(f.attributes?.name ?? f.id),
    }));
    res.json({ ...data, data: folders });
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.body });
  }
});

/**
 * "Detect Container" — Resolves the Model Coordination container ID for a project.
 *
 * Strategy (tried in order):
 *  1. ACC / BIM360 v3 — containerId = projectId (most common for ACC projects)
 *  2. BIM360 legacy   — containerId fetched from the HQ admin API
 *
 * A 403 from Autodesk means the APS app is not provisioned in this account.
 * A 404 means Model Coordination is not enabled for the project, or the project
 * is a legacy BIM360 project whose container ID differs from the project ID.
 */
app.get('/api/project/containers', async (req, res) => {
  try {
    const { accountId, projectId: rawProjectId } = req.query;
    const projectId = (rawProjectId || process.env.ACC_PROJECT_ID || '').replace(/^b\./, '');
    if (!projectId) return res.status(400).json({ error: 'projectId required — paste your ACC Project ID on the Connect tab first' });
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const client = await makeAPSClient();
    // Same path-normalization as in src/api/model-coordination.js — survives stale .env files.
    const MC_MODELSET_BASE = (process.env.MC_MODELSET_API_BASE
      ?? 'https://developer.api.autodesk.com/bim360/modelset/v3')
      .replace('/bim360/modelcoordination/', '/bim360/');

    // ── Strategy 0: HQ Admin API — works independently of MC provisioning ────
    // Pull the container ID from the BIM360/ACC project record. This succeeds
    // even when the APS app hasn't been added as a Custom Integration yet.
    let hqContainerId = null;
    try {
      const accountIdClean = accountId.replace(/^b\./, '');
      const hqProject = await client.get(
        `https://developer.api.autodesk.com/hq/v1/accounts/${accountIdClean}/projects/${projectId}`
      );
      hqContainerId = hqProject?.data?.relationships?.docs?.data?.id
        ?? hqProject?.relationships?.docs?.data?.id
        ?? null;
    } catch (_) { /* HQ API unavailable — continue */ }

    // ── Strategy 1: ACC v3 — containerId = projectId ──────────────────────
    let mcStatus1 = null;
    let mcBody1   = null;
    try {
      await client.get(`${MC_MODELSET_BASE}/containers/${projectId}/modelsets`);
      // Verified: MC API accepts projectId as containerId
      return res.json({ data: [{ id: projectId }] });
    } catch (e1) {
      mcStatus1 = e1.status || 0;
      mcBody1   = e1.body ?? null;
      if (mcStatus1 !== 403 && mcStatus1 !== 404) throw e1;
    }

    // ── Strategy 2: verify HQ-derived containerId against MC API ──────────
    if (hqContainerId && hqContainerId !== projectId) {
      try {
        await client.get(`${MC_MODELSET_BASE}/containers/${hqContainerId}/modelsets`);
        return res.json({ data: [{ id: hqContainerId }] });
      } catch (_) { /* fall through */ }
    }

    // ── Fallback: return best-guess containerId with a warning ────────────
    // For ACC v3, containerId always equals projectId even when the MC API
    // returns 403 (app not yet provisioned). Return it unverified so the UI
    // can pre-fill the field — the user can save and proceed once provisioned.
    const inferredId = hqContainerId ?? projectId;

    if (mcStatus1 === 403) {
      return res.json({
        data: [{ id: inferredId }],
        warning: 'MC API returned 403 — container ID is inferred (not verified). To verify, an ACC Account Admin must add this app as a Custom Integration: acc.autodesk.com → Account Admin → Custom Integrations → Add Integration → paste Client ID → enable Model Coordination.',
        apsBody: mcBody1,
      });
    }

    // 404 from MC API after exhausting all strategies
    if (inferredId) {
      return res.json({
        data: [{ id: inferredId }],
        warning: 'Model Coordination could not be verified for this project (404). Container ID is inferred. Confirm MC is active in ACC → Settings → Products & Services.',
      });
    }

    return res.status(404).json({
      error: 'Could not determine a Model Coordination container ID.',
      hint: 'In ACC, confirm Model Coordination is active under project Settings → Products & Services.',
      accountId,
      projectId,
    });

  } catch (err) {
    res.status(500).json({ error: err.message, details: err.body });
  }
});

/** List items (subfolders + models) inside a Docs folder */
app.get('/api/project/folder-contents', async (req, res) => {
  try {
    const { projectId, folderUrn } = req.query;
    if (!projectId || !folderUrn) return res.status(400).json({ error: 'projectId and folderUrn required' });
    const client = await makeAPSClient();
    const projId = projectId.startsWith('b.') ? projectId : `b.${projectId}`;
    const data = await client.get(
      `https://developer.api.autodesk.com/data/v1/projects/${projId}/folders/${encodeURIComponent(folderUrn)}/contents`
    );
    const items = (data?.data ?? []).map(it => {
      const tipUrn = it.relationships?.tip?.data?.id ?? null;
      // Pre-compute viewer URN so the client can load directly without an extra API call
      const viewerUrn = tipUrn
        ? Buffer.from(tipUrn).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
        : null;
      return {
        id:           it.id,
        type:         it.type,   // 'folders' | 'items'
        name:         it.attributes?.displayName ?? it.attributes?.name ?? it.id,
        extension:    it.attributes?.extension?.type ?? null,
        derivativeUrn: tipUrn,
        viewerUrn,               // ready for Autodesk.Viewing.Document.load(`urn:${viewerUrn}`)
        discipline:   null,      // populated client-side after classification
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.body });
  }
});

/**
 * Recursively walk a folder tree and return ALL item-type files (not folders).
 * Each item includes a `folderPath` string showing its location in the tree.
 * Depth is capped at maxDepth (default 4, max 6) to prevent runaway calls.
 */
app.get('/api/project/folder-contents-recursive', async (req, res) => {
  try {
    const { projectId, folderUrn } = req.query;
    const maxDepth = Math.min(parseInt(req.query.maxDepth ?? '4', 10), 6);
    if (!projectId || !folderUrn) return res.status(400).json({ error: 'projectId and folderUrn required' });

    const client = await makeAPSClient();
    const projId = projectId.startsWith('b.') ? projectId : `b.${projectId}`;
    const allItems = [];

    async function fetchFolder(folderId, pathLabel, depth) {
      if (depth > maxDepth) return;
      const data = await client.get(
        `https://developer.api.autodesk.com/data/v1/projects/${projId}/folders/${encodeURIComponent(folderId)}/contents`
      );
      const entries = data?.data ?? [];
      const subfolders = [];

      for (const it of entries) {
        const name = it.attributes?.displayName ?? it.attributes?.name ?? it.id;
        if (it.type === 'folders') {
          subfolders.push({ id: it.id, name });
        } else if (it.type === 'items') {
          const tipUrn = it.relationships?.tip?.data?.id ?? null;
          const viewerUrn = tipUrn
            ? Buffer.from(tipUrn).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
            : null;
          allItems.push({
            id:           it.id,
            type:         'items',
            name,
            extension:    it.attributes?.extension?.type ?? null,
            derivativeUrn: tipUrn,
            viewerUrn,
            folderPath:   pathLabel || '(root)',
            discipline:   null,
          });
        }
      }

      // Sequential subfolder recursion — avoids rate-limit bursts
      for (const sf of subfolders) {
        const childPath = pathLabel ? `${pathLabel} › ${sf.name}` : sf.name;
        await fetchFolder(sf.id, childPath, depth + 1);
      }
    }

    await fetchFolder(folderUrn, '', 0);
    res.json({ items: allItems, total: allItems.length });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/**
 * Extract available properties (names + distinct sample values) from a model.
 * Used by the Search Set editor to offer autocompletion against live model data.
 */
app.get('/api/models/properties', async (req, res) => {
  try {
    const { projectId, itemId, urn } = req.query;
    if (!urn && !(projectId && itemId)) {
      return res.status(400).json({ error: 'Provide urn OR projectId + itemId' });
    }
    const client = await makeAPSClient();

    // Resolve a base64-encoded derivative URN if we were given a DM item id
    let derivUrn = urn ? String(urn) : null;
    if (!derivUrn) {
      const projId = projectId.startsWith('b.') ? projectId : `b.${projectId}`;
      const versions = await client.get(
        `https://developer.api.autodesk.com/data/v1/projects/${projId}/items/${encodeURIComponent(itemId)}/versions`
      );
      const tip = versions?.data?.[0];
      const rawUrn = tip?.relationships?.derivatives?.data?.id ?? tip?.id;
      if (!rawUrn) return res.status(404).json({ error: 'No derivative found on tip version' });
      derivUrn = Buffer.from(rawUrn).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    }

    const { ModelDerivativeClient } = await import('./src/api/model-derivative.js');
    const md = new ModelDerivativeClient(client);
    const token = await client.getToken();
    const views = await md._derivative.getModelViews(derivUrn, { accessToken: token });
    const guid = views?.data?.metadata?.[0]?.guid;
    if (!guid) return res.status(404).json({ error: 'No viewable GUID — model may still be translating' });

    const raw = await md._derivative.getAllProperties(derivUrn, guid, { accessToken: token });
    const collection = raw?.data?.collection ?? [];

    // Collect unique property names + up to N distinct values per property
    const MAX_VALUES = 50;
    const props = new Map();   // name → { group, values: Set }
    for (const obj of collection) {
      const groups = obj.properties ?? {};
      for (const [groupName, bag] of Object.entries(groups)) {
        if (!bag || typeof bag !== 'object') continue;
        for (const [pName, pValue] of Object.entries(bag)) {
          const key = pName.trim();
          if (!key) continue;
          if (!props.has(key)) props.set(key, { group: groupName, values: new Set() });
          const slot = props.get(key);
          if (slot.values.size < MAX_VALUES && pValue !== undefined && pValue !== null && pValue !== '') {
            slot.values.add(String(pValue));
          }
        }
      }
    }

    const properties = [...props.entries()]
      .map(([name, { group, values }]) => ({ name, group, values: [...values].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ properties, totalObjects: collection.length });
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.body });
  }
});

/** List model sets in a container */
app.get('/api/project/modelsets', async (req, res) => {
  try {
    const containerId = req.query.containerId ?? process.env.MC_CONTAINER_ID;
    if (!containerId) return res.status(400).json({ error: 'containerId required' });
    const { ModelCoordinationClient } = await import('./src/api/model-coordination.js');
    const client = await makeAPSClient();
    const mc = new ModelCoordinationClient(client, containerId);
    const raw = await mc.listModelSets();
    // Normalize: MC API may return {data:[...]}, {results:[...]}, {modelsets:[...]}, or []
    const items = raw?.data ?? raw?.results ?? raw?.modelsets ?? raw?.modelSets ?? raw?.sets ?? null;
    const data  = Array.isArray(items) ? items : Array.isArray(raw) ? raw : [];
    res.json({ data });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Model Coordination (active coordination space)
// ─────────────────────────────────────────────────────────────────────────────

function buildMcClient(req) {
  const containerId = req.query.containerId ?? process.env.MC_CONTAINER_ID;
  if (!containerId) throw Object.assign(new Error('containerId required'), { status: 400 });
  return import('./src/api/model-coordination.js').then(async ({ ModelCoordinationClient }) => {
    const client = await makeAPSClient();
    return new ModelCoordinationClient(client, containerId);
  });
}

/** List documents (models) inside a coordination space's latest version */
app.get('/api/mc/space-documents', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);

    const versResp = await mc.getModelSetVersions(modelSetId);
    const versions = toArray(versResp, 'versions');
    const latest   = versions[versions.length - 1] ?? null;
    const versionIndex = latest?.versionIndex ?? null;

    if (!latest) return res.json({ versionIndex: null, documents: [] });

    // The versions-list endpoint often returns lightweight objects without documents[].
    // Fall back to the individual version endpoint to get the full manifest.
    let versionObj = latest;
    if (!versionObj.documents?.length && versionIndex != null) {
      try {
        const fullVer = await mc.getModelSetVersion(modelSetId, versionIndex);
        // Try multiple response shapes: direct, data-wrapped, version-wrapped
        versionObj = fullVer?.data ?? fullVer?.version ?? fullVer ?? versionObj;
      } catch (_) { /* keep latest if full fetch fails */ }
    }

    const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

    const docs = (versionObj.documents ?? []).map(d => {
    const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

    const docs = (latest.documents ?? []).map(d => {
      // derivativeUrn is the viewable derivative URN (base64url of this gives the viewer urn).
      // urn is the version lineage URN. Prefer derivativeUrn for the viewer; expose both so
      // the client can match MC view modelIds (which are document-level IDs, not URNs).
      const derivativeUrn = d.derivativeUrn ?? null;
      const versionUrn    = d.urn ?? null;
      // For the viewer we prefer the derivative URN; fall back to version URN.
      const viewableRaw   = derivativeUrn ?? versionUrn;
      const viewerUrn     = viewableRaw ? b64url(viewableRaw) : null;
      const name = d.name ?? d.fileName ?? d.displayName ?? viewableRaw ?? 'Unknown';
      return {
        id:           d.id ?? versionUrn,    // document UUID from MC — matches view.modelIds
        name,
        rawUrn:       versionUrn,
        derivativeUrn,
        viewerUrn,
        size:         d.size ?? null,
        lastModified: d.lastModifiedTime ?? d.modifiedAt ?? null,
      };
    });

    res.json({ versionIndex, documentCount: docs.length, documents: docs });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** List clash tests for the latest version of a coordination space */
app.get('/api/mc/clash-tests', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);

    const versResp = await mc.getModelSetVersions(modelSetId);
    const versions = toArray(versResp, 'versions');
    const latest   = versions[versions.length - 1];
    if (!latest) return res.json({ versionIndex: null, tests: [] });

    const versionIndex = latest.versionIndex ?? 1;
    const data = await mc.listClashTests(modelSetId, versionIndex);
    res.json({ versionIndex, tests: toArray(data, 'tests', 'clashTests') });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get clash groups for a specific test */
app.get('/api/mc/clash-groups', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    const versionIndex = req.query.versionIndex;
    const testId = req.query.testId;
    if (!modelSetId || !versionIndex || !testId) {
      return res.status(400).json({ error: 'modelSetId, versionIndex, testId required' });
    }
    const mc = await buildMcClient(req);
    const data = await mc.getGroupedClashes(modelSetId, parseInt(versionIndex, 10), testId);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** List existing search sets for a coordination space */
app.get('/api/mc/search-sets', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);
    const data = await mc.listSearchSets(modelSetId);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Issues (ACC Construction Issues v1)
// ─────────────────────────────────────────────────────────────────────────────

async function buildIssuesClient(req) {
  const projectId = req.query.projectId ?? process.env.ACC_PROJECT_ID;
  if (!projectId) throw Object.assign(new Error('projectId required (set ACC_PROJECT_ID or pass ?projectId=)'), { status: 400 });
  const { IssuesClient } = await import('./src/api/issues-client.js');
  const apsClient = await makeAPSClient();
  return new IssuesClient(apsClient, projectId);
}

app.get('/api/issues', async (req, res) => {
  try {
    const issues = await (await buildIssuesClient(req)).list({
      status:       req.query.status ? String(req.query.status).split(',') : undefined,
      assignedTo:   req.query.assignedTo,
      issueTypeId:  req.query.typeId ? String(req.query.typeId).split(',') : undefined,
      limit:        req.query.limit ? parseInt(req.query.limit, 10) : 200,
      offset:       req.query.offset,
    });
    res.json(issues);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/**
 * Return issues that have a 3D pushpin location, optionally filtered to a set
 * of model URNs (viewer URNs or rawUrns). This powers the in-viewer issue
 * markers overlay.
 *
 * Each returned item includes:
 *   { id, title, identifier, status, location: {x,y,z}, linkedDocumentId,
 *     objectId, viewerStateId }
 */
app.get('/api/issues/with-location', async (req, res) => {
  try {
    const client = await buildIssuesClient(req);
    const raw = await client.list({
      status: req.query.status ? String(req.query.status).split(',') : undefined,
      limit:  500,
    });
    const all = raw?.results ?? raw?.data ?? (Array.isArray(raw) ? raw : []);

    // Filter to issues that carry pushpin position data
    const withLocation = [];
    for (const issue of all) {
      const attrs = issue.attributes ?? issue;
      const pushpin = attrs.pushpinAttributes ?? attrs.pushpin_attributes ?? null;
      const loc = pushpin?.location ?? pushpin?.position ?? null;
      if (!loc || (loc.x === undefined && loc.y === undefined)) continue;

      withLocation.push({
        id:               issue.id,
        title:            attrs.title ?? attrs.name ?? 'Untitled',
        identifier:       attrs.identifier ?? attrs.displayId ?? '',
        status:           attrs.status ?? 'open',
        assignedTo:       attrs.assignedTo ?? null,
        location:         { x: loc.x ?? 0, y: loc.y ?? 0, z: loc.z ?? 0 },
        linkedDocumentId: pushpin.linkedDocumentId ?? pushpin.document_urn ?? null,
        objectId:         pushpin.objectId ?? pushpin.object_id ?? null,
        viewerStateId:    pushpin.viewerStateId ?? pushpin.viewer_state_id ?? null,
      });
    }

    // Optionally filter by model URN(s): ?urns=urn1,urn2,...
    const urnFilter = req.query.urns ? String(req.query.urns).split(',').map(s => s.trim()) : null;
    const result = urnFilter
      ? withLocation.filter(i => !i.linkedDocumentId || urnFilter.some(u => i.linkedDocumentId.includes(u)))
      : withLocation;

    res.json({ count: result.length, issues: result });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

app.get('/api/issues/types', async (req, res) => {
  try {
    const data = await (await buildIssuesClient(req)).listTypes();
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

app.get('/api/issues/:id', async (req, res) => {
  try {
    const data = await (await buildIssuesClient(req)).get(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

app.post('/api/issues', async (req, res) => {
  try {
    const data = await (await buildIssuesClient(req)).create(req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

app.patch('/api/issues/:id', async (req, res) => {
  try {
    const data = await (await buildIssuesClient(req)).update(req.params.id, req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

app.get('/api/issues/:id/comments', async (req, res) => {
  try {
    const data = await (await buildIssuesClient(req)).listComments(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

app.post('/api/issues/:id/comments', async (req, res) => {
  try {
    const body = req.body?.body ?? '';
    if (!body.trim()) return res.status(400).json({ error: 'comment body required' });
    const data = await (await buildIssuesClient(req)).addComment(req.params.id, body);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Coordination Assignments (discipline mapping, clash includes, alignments)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/coordination/assignments', (_req, res) => {
  try { res.json(readConfig('coordination-assignments.json')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Saved Views (FormaFlow local + ACC Model Coordination merged)
// ─────────────────────────────────────────────────────────────────────────────

function readViews() {
  try { return readConfig('saved-views.json'); }
  catch { return { views: [] }; }
}

/**
 * Merged views listing — local FormaFlow views + MC views (if API supported).
 * Filters local views by ?modelSetId so you only see views for the active space.
 */
app.get('/api/views', async (req, res) => {
  try {
    const modelSetId  = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID ?? '';
    const containerId = req.query.containerId ?? process.env.MC_CONTAINER_ID ?? '';
    const local = readViews().views ?? [];

    const localFiltered = modelSetId
      ? local.filter(v => !v.modelSetId || v.modelSetId === modelSetId)
      : local;

    let mc = [];
    let mcSupported = false;
    let mcReason = null;

    if (modelSetId && containerId) {
      try {
        const client = await makeAPSClient();
        const url = `https://developer.api.autodesk.com/bim360/modelset/v3/containers/${containerId}/modelsets/${modelSetId}/views`;
        try {
          const data = await client.get(url);
          mc = toArray(data, 'views').map(v => ({
            id:          `mc:${v.id ?? v.viewId}`,
            name:        v.name ?? v.title ?? `MC View ${v.id ?? ''}`,
            source:      'mc',
            modelSetId,
            modelIds:    v.modelIds ?? v.documentIds ?? [],
            clashTestId: v.clashTestId ?? null,
            createdAt:   v.createdAt ?? v.created ?? null,
            raw:         v,
          }));
          mcSupported = true;
        } catch (e) {
          if (e.status === 404 || e.status === 403) {
            mcSupported = false;
            mcReason = e.status === 404
              ? 'MC Views API not available for this container'
              : 'MC Views API not authorized for this app — add as Custom Integration';
          } else {
            throw e;
          }
        }
      } catch (err) {
        mcReason = err.message;
      }
    }

    const combined = [...mc, ...localFiltered];
    res.json({ mcSupported, mcReason, views: combined, localCount: localFiltered.length, mcCount: mc.length });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

/** Save a new local view */
app.post('/api/views', (req, res) => {
  try {
    const incoming = req.body ?? {};
    if (!incoming.name) return res.status(400).json({ error: 'name required' });
    const all = readViews();
    const view = {
      id:           `local:${Date.now()}`,
      name:         String(incoming.name).slice(0, 80),
      source:       'local',
      modelSetId:   incoming.modelSetId ?? '',
      modelIds:     Array.isArray(incoming.modelIds) ? incoming.modelIds : [],
      camera:       incoming.camera ?? null,
      clashTestId:  incoming.clashTestId ?? null,
      searchSetIds: Array.isArray(incoming.searchSetIds) ? incoming.searchSetIds : [],
      notes:        incoming.notes ?? '',
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
    };
    all.views.unshift(view);
    writeConfig('saved-views.json', all);
    res.json(view);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Update an existing local view (rename / re-camera) */
app.patch('/api/views/:id', (req, res) => {
  try {
    const all = readViews();
    const idx = all.views.findIndex(v => v.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'view not found' });
    if (all.views[idx].source !== 'local') return res.status(400).json({ error: 'only local views are editable' });
    const merged = { ...all.views[idx], ...req.body, updatedAt: new Date().toISOString(), id: all.views[idx].id, source: 'local' };
    all.views[idx] = merged;
    writeConfig('saved-views.json', all);
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Delete a local view */
app.delete('/api/views/:id', (req, res) => {
  try {
    const all = readViews();
    const idx = all.views.findIndex(v => v.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'view not found' });
    if (all.views[idx].source !== 'local') return res.status(400).json({ error: 'only local views are deletable' });
    all.views.splice(idx, 1);
    writeConfig('saved-views.json', all);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/coordination/assignments', (req, res) => {
  try {
    const incoming = req.body ?? {};
    const merged = {
      modelSetId:       incoming.modelSetId ?? '',
      assignments:      incoming.assignments ?? {},
      clashIncludes:    Array.isArray(incoming.clashIncludes) ? incoming.clashIncludes : [],
      alignments:       incoming.alignments ?? {},
      alignSnap:        typeof incoming.alignSnap === 'number' ? incoming.alignSnap : 1.0,
      modelDisciplines: incoming.modelDisciplines ?? {},
      lastSavedAt:      new Date().toISOString(),
    };
    writeConfig('coordination-assignments.json', merged);
    res.json({ ok: true, lastSavedAt: merged.lastSavedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List MC views for a coordination space.
 * The MC v3 Views endpoint surfaces saved viewer states. If the endpoint
 * returns 404 we report that gracefully so the client can fall back to
 * local "FormaFlow Views" without surfacing a noisy error.
 */
app.get('/api/mc/views', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    const containerId = req.query.containerId ?? process.env.MC_CONTAINER_ID;
    if (!modelSetId || !containerId) {
      return res.status(400).json({ error: 'modelSetId and containerId required' });
    }
    const client = await makeAPSClient();
    const url = `https://developer.api.autodesk.com/bim360/modelset/v3/containers/${containerId}/modelsets/${modelSetId}/views`;
    try {
      const data = await client.get(url);
      res.json({ supported: true, views: toArray(data, 'views') });
    } catch (e) {
      if (e.status === 404) {
        // Endpoint not enabled for this container — return supported:false
        return res.json({ supported: false, views: [], reason: 'MC Views API not available for this container' });
      }
      throw e;
    }
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Workflow (SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────

/** SSE endpoint — client connects before starting a run */
app.get('/api/workflow/stream', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ type: 'connected', sessionId });

  const handler = (entry) => {
    if (entry.sessionId === sessionId) send(entry);
  };

  logEmitter.on('log', handler);
  req.on('close', () => logEmitter.off('log', handler));
});

/** Start the workflow — responds immediately with sessionId, then streams logs */
app.post('/api/workflow/run', async (req, res) => {
  // Use the client-provided sessionId so SSE subscriber and emitter share the same channel.
  // Falls back to a generated one only if the client didn't supply it.
  const sessionId = req.body?.sessionId || `run-${Date.now()}`;
  res.json({ sessionId });

  const emit = (level, message, label = 'Workflow') =>
    logEmitter.emit('log', { sessionId, type: 'log', level, message, label, ts: new Date().toISOString() });

  const done = (success, extra = {}) =>
    logEmitter.emit('log', { sessionId, type: 'done', success, ...extra });

  try {
    const config      = readConfig('workflow-config.json');
    const ssLibrary   = readConfig('search-set-library.json');
    const clashConfig = readConfig('clash-test-templates.json');
    const dryRun      = req.body.dryRun ?? config.workflow.dryRun;

    if (dryRun) emit('warn', '⚠ DRY RUN — no write API calls will be made');

    // ── Step 1 — Auth ───────────────────────────────────────────────────
    emit('info', '── Step 1 / 6  Authenticating with APS');
    const { ModelCoordinationClient } = await import('./src/api/model-coordination.js');
    const { ModelDerivativeClient }   = await import('./src/api/model-derivative.js');
    const { DisciplineClassifier }    = await import('./src/model-identification/discipline-classifier.js');
    const { SearchSetGenerator }      = await import('./src/search-sets/search-set-generator.js');
    const { ClashTestConfigurator }   = await import('./src/clash-tests/clash-test-configurator.js');
    const { ClashResultsProcessor }   = await import('./src/results/clash-results-processor.js');

    // Use makeAPSClient so the workflow uses a stored 3-legged token when
    // available — MC API requires 3-legged and will 403 with 2-legged only.
    const apsClient = await makeAPSClient();
    await apsClient.getToken();
    const usingThreeLeg = !!(await getThreeLeggedToken());
    if (!usingThreeLeg) {
      emit('warn', '⚠ No 3-legged service account token found — MC API calls may fail (403). Log in via the Service Account card on the Connect tab.');
    }
    emit('info', `✓ APS authentication successful (${usingThreeLeg ? '3-legged' : '2-legged'})`);

    // ── Step 2 — Model Set ──────────────────────────────────────────────
    emit('info', '── Step 2 / 6  Fetching model set');
    const mcClient = new ModelCoordinationClient(apsClient);
    const setsResp = await mcClient.listModelSets();
    const modelSets = toArray(setsResp, 'modelsets', 'modelSets');
    if (!modelSets.length) { emit('error', '✗ No model sets found — check MC_CONTAINER_ID and ensure a Coordination Space exists in ACC'); return done(false); }

    // Prefer the user-selected coordination space; fall back to first if none chosen.
    const selectedId = process.env.MC_MODEL_SET_ID;
    let ms = selectedId
      ? modelSets.find(s => (s.id ?? s.modelSetId) === selectedId)
      : null;
    if (!ms && selectedId) {
      emit('warn', `⚠ Selected coordination space not found (${selectedId}); falling back to first available`);
    }
    ms ??= modelSets[0];
    const modelSetId = ms.id ?? ms.modelSetId;
    emit('info', `✓ Coordination space: ${ms.name ?? modelSetId}`);

    const versResp = await mcClient.getModelSetVersions(modelSetId);
    const versions = toArray(versResp, 'versions');
    const latest   = versions[versions.length - 1];
    const versionIndex = latest?.versionIndex ?? 1;
    // The versions-list endpoint returns lightweight objects — documents[] is often absent.
    // Fall back to the individual version endpoint to get the full manifest.
    let versionObj = latest ?? {};
    if (!versionObj.documents?.length) {
      try {
        emit('info', `  Fetching full version manifest for version ${versionIndex}…`);
        const fullVer = await mcClient.getModelSetVersion(modelSetId, versionIndex);
        // Try multiple response shapes: direct, data-wrapped, version-wrapped
        const candidate = fullVer?.data ?? fullVer?.version ?? fullVer ?? {};
        if (candidate.documents?.length) {
          emit('info', `  ✓ Full manifest returned ${candidate.documents.length} document(s)`);
          versionObj = candidate;
        } else {
          const allKeys = [fullVer, fullVer?.data, fullVer?.version].filter(Boolean)
            .map(o => Object.keys(o).join(', ')).join(' | ');
          emit('warn', `  ⚠ Full manifest also returned 0 documents. Response keys: [${allKeys}]`);
        }
      } catch (err) {
        emit('warn', `  ⚠ Could not fetch full version manifest: ${err.message}`);
      }
    }
    const allDocs = versionObj.documents ?? [];

    // Apply user clash-include filter and discipline overrides from coordination-assignments.json
    let coord;
    try { coord = readConfig('coordination-assignments.json'); } catch { coord = null; }
    let docs = allDocs;
    if (coord?.clashIncludes?.length) {
      const includeSet = new Set(coord.clashIncludes);
      const filtered = allDocs.filter(d =>
        includeSet.has(d.id) || includeSet.has(d.urn) || includeSet.has(d.derivativeUrn)
      );
      if (filtered.length) {
        docs = filtered;
        emit('info', `✓ Applying coordination filter: ${filtered.length} of ${allDocs.length} model(s) included in clash detection`);
      } else {
        emit('warn', `⚠ Coordination clash include list did not match any documents — using all ${allDocs.length}`);
      }
    }
    emit('info', `✓ Version ${versionIndex} — ${docs.length} document(s)`);

    // ── Step 3 — Extract + Classify ─────────────────────────────────────
    emit('info', '── Step 3 / 6  Identifying disciplines');
    const mdClient = new ModelDerivativeClient(apsClient);
    // Prefer derivativeUrn for Model Derivative API — it expects the
    // base64-encoded version URN. d.urn is often the lineage URN which
    // returns 404 from the MD API, leaving descriptors empty (UNKNOWN).
    const descriptors = await Promise.all(
      docs.map(d => mdClient.extractModelDescriptor(
        d.derivativeUrn ?? d.urn,
        d.name ?? d.fileName ?? 'Unknown'
      ))
    );
    const propsExtracted = descriptors.filter(d => d.categories.length || d.systemClassifications.length).length;
    if (propsExtracted < descriptors.length) {
      emit('warn', `⚠ Property extraction succeeded for ${propsExtracted}/${descriptors.length} models. Models with no extracted properties will be classified by filename only.`);
    }

    const classifier = new DisciplineClassifier();
    const classifications = classifier.classifyAll(descriptors);

    // Apply per-model discipline overrides from coord.modelDisciplines
    // (added in PR #13). Keys can be itemId, viewerUrn, derivativeUrn, or name.
    const docByKey = new Map();
    for (const d of docs) {
      if (d.id) docByKey.set(d.id, d);
      if (d.urn) docByKey.set(d.urn, d);
      if (d.derivativeUrn) docByKey.set(d.derivativeUrn, d);
      if (d.name) docByKey.set(d.name, d);
      if (d.fileName) docByKey.set(d.fileName, d);
    }
    let perModelOverrides = 0;
    if (coord?.modelDisciplines) {
      for (const [key, disc] of Object.entries(coord.modelDisciplines)) {
        const matched = docByKey.get(key);
        if (matched && classifications.has(matched.derivativeUrn ?? matched.urn)) {
          const existingKey = matched.derivativeUrn ?? matched.urn;
          const existing = classifications.get(existingKey);
          if (existing.discipline !== disc) {
            emit('info', `  ↻ Per-model override: ${matched.name ?? matched.fileName} → ${disc} (was ${existing.discipline})`);
          }
          classifications.set(existingKey, { ...existing, discipline: disc, confidence: 1.0, requiresManualReview: false });
          perModelOverrides++;
        }
      }
    }

    // Legacy assignments[DISC] = itemId — kept for backward compatibility
    if (coord?.assignments && Object.keys(coord.assignments).length) {
      for (const [disc, itemId] of Object.entries(coord.assignments)) {
        const target = descriptors.find(d => d.id === itemId || d.urn === itemId);
        if (target && classifications.has(target.id)) {
          const existing = classifications.get(target.id);
          if (existing.discipline !== disc) {
            emit('info', `  ↻ Discipline assignment: ${target.fileName} → ${disc} (was ${existing.discipline})`);
          }
          classifications.set(target.id, { ...existing, discipline: disc, confidence: 1.0, requiresManualReview: false });
        }
      }
    }
    if (perModelOverrides) emit('info', `  Applied ${perModelOverrides} per-model discipline override(s)`);

    const disciplineSet = new Set();
    for (const [id, result] of classifications) {
      const model = descriptors.find(d => d.id === id);
      emit('info', `  ${model?.fileName ?? id}  →  ${result.discipline}  (${(result.confidence * 100).toFixed(1)}%)`);
      if (result.discipline !== 'UNKNOWN') disciplineSet.add(result.discipline);
    }
    const disciplines = [...disciplineSet];
    emit('info', `✓ Disciplines detected: ${disciplines.join(', ') || 'none — assign disciplines on the Coordination tab'}`);

    // ── Step 4 — Search Sets ────────────────────────────────────────────
    emit('info', '── Step 4 / 6  Creating Search Sets');
    const ssGen = new SearchSetGenerator(mcClient, {
      overwriteExisting: config.searchSets.overwriteExisting,
      createSystemBased: config.searchSets.createSystemBasedSets,
      createFallback:    config.searchSets.createFallbackCategorySets,
      dryRun,
    });
    const ssResults = await ssGen.generateForDisciplines(modelSetId, disciplines);
    if (ssGen.listExistingError) {
      emit('warn', `⚠ Could not list existing Search Sets — ${ssGen.listExistingError} (proceeding without conflict check)`);
    }
    const ssCreated  = ssResults.filter(r => r.created || r.dryRun).length;
    const ssSkipped  = ssResults.filter(r => r.skipped).length;
    const ssFailed   = ssResults.filter(r => r.error).length;
    emit('info', `✓ Search Sets — ${ssCreated} created, ${ssSkipped} reused, ${ssFailed} failed`);
    for (const r of ssResults) {
      if (r.error)        emit('warn', `  ✗ ${r.name}: ${r.error}`);
      else if (r.skipped) emit('info', `  ↻ ${r.name} (reused, remote id: ${r.remoteId ?? '—'})`);
      else if (r.created) emit('info', `  ＋ ${r.name} (remote id: ${r.remoteId ?? '—'})`);
      else if (r.dryRun)  emit('info', `  • ${r.name} (dry run)`);
    }

    // KEY FIX: clash-test templates reference search sets by library ID
    // (e.g. "ss-arch-walls"), not by name. Building the map by r.id ensures
    // resolveSearchSetIds() actually finds them. Previously the map was keyed
    // by r.name, so every clash test was silently skipped.
    const ssIdToRemoteId = new Map(
      ssResults.filter(r => r.remoteId).map(r => [r.id, r.remoteId])
    );
    emit('info', `  ${ssIdToRemoteId.size} Search Set(s) available for clash test references`);
    if (!ssIdToRemoteId.size && disciplines.length) {
      emit('warn', '⚠ No Search Sets resolved — clash tests will be skipped. Possible causes:');
      emit('warn', '   • App lacks 3-legged token / write permission for MC API');
      emit('warn', '   • V2 coordination spaces do not support Search Sets API');
      emit('warn', '   • Existing sets list could not be fetched and create calls failed');
      emit('warn', '   • Create calls returned no remote id (response shape mismatch)');
    }

    // ── Step 5 — Clash Tests ────────────────────────────────────────────
    emit('info', '── Step 5 / 6  Configuring clash tests');
    if (disciplines.length < 2) {
      emit('warn', `⚠ Only ${disciplines.length} discipline(s) detected — at least 2 are required for any clash pair (e.g. ARCH + STRUCT). Assign disciplines manually on the Coordination tab if auto-detection is incomplete.`);
    }
    const testConfigurator = new ClashTestConfigurator(mcClient, {
      subTestsEnabled: config.clashTests.subTestsEnabled,
      dryRun,
      disabledTestIds: config.clashTests.disabledTestIds,
    });
    const testResults = await testConfigurator.configureForDisciplines(
      modelSetId, versionIndex, disciplines, ssIdToRemoteId
    );
    const testsCreated = testResults.filter(r => r.created || r.dryRun).length;
    const testsSkipped = testResults.filter(r => !r.created && !r.dryRun && !r.error).length;
    const testsFailed  = testResults.filter(r => r.error).length;
    emit('info', `✓ Clash tests — ${testsCreated} created, ${testsSkipped} skipped (unresolved sets), ${testsFailed} failed`);
    for (const r of testResults) {
      const sides = r.resolved
        ? ` [A: ${r.resolved.sideAKeys.join('+') || '—'} | B: ${r.resolved.sideBKeys.join('+') || '—'}]`
        : '';
      if (r.error)        emit('warn', `  ✗ ${r.name}${sides}: ${r.error}`);
      else if (r.created) emit('info', `  ＋ ${r.name}${sides} (remote id: ${r.remoteId ?? '—'})`);
      else if (r.dryRun)  emit('info', `  • ${r.name}${sides} (dry run)`);
    }
    if (!testsCreated && !testsFailed && disciplines.length >= 2) {
      emit('warn', '⚠ No clash tests created. Most common cause: the search-set IDs referenced by the clash-test templates do not match any successfully-created Search Sets above. Check the per-test side resolution logs for missing IDs.');
    }

    // ── Step 6 — Results ────────────────────────────────────────────────
    let report = { totalGroups: 0, totalClashes: 0, groups: [] };

    // Build the list of tests to poll: prefer newly-created ones; when none
    // were created (API unavailable or all sets unresolved) fall back to
    // existing clash tests already in ACC — those created via the web UI still
    // have results we can read and export.
    let testsForResults = testResults.filter(r => r.created && r.remoteId);

    if (!dryRun && !testsForResults.length) {
      emit('info', '── Step 6 / 6  Falling back to existing clash tests in ACC…');
      try {
        const existingData = await mcClient.listClashTests(modelSetId, versionIndex);
        const existing = toArray(existingData, 'tests', 'clashTests');
        const completed = existing.filter(t => {
          const s = String(t.status ?? '').toUpperCase();
          return s === 'COMPLETE' || s === 'COMPLETED' || s === 'SUCCESS';
        });
        if (completed.length) {
          emit('info', `  Found ${completed.length} completed clash test(s) in ACC`);
          testsForResults = completed.map(t => ({
            name:     t.name ?? t.id,
            created:  true,
            remoteId: t.id ?? t.testId,
          }));
        } else if (existing.length) {
          emit('warn', `  ${existing.length} clash test(s) found in ACC but none are COMPLETE (statuses: ${[...new Set(existing.map(t => t.status))].join(', ')})`);
        } else {
          emit('warn', '  No existing clash tests found in ACC — create tests via the ACC web UI or ensure Search Sets are resolvable.');
        }
      } catch (e) {
        emit('warn', `  Could not read existing ACC clash tests: ${e.message}`);
      }
    }

    if (!dryRun && testsForResults.length) {
      emit('info', '── Step 6 / 6  Waiting for results');

      // Only wait on tests that aren't already COMPLETE
      const newlyCreated = testsForResults.filter(t => testResults.find(r => r.remoteId === t.remoteId));
      for (const t of newlyCreated) {
        try {
          await mcClient.waitForClashTest(
            modelSetId,
            versionIndex,
            t.remoteId,
            5000,
            config.workflow.clashTestTimeoutMs ?? 300_000,
            (status, attempt) => emit('info', `  … ${t.name} — ${status} (attempt ${attempt})`),
          );
          emit('info', `  ✓ ${t.name} complete`);
        } catch (e) {
          emit('warn', `  ✗ ${t.name}: ${e.message}`);
        }
      }

      const processor = new ClashResultsProcessor(mcClient, {
        groupByLevel:  config.results.groupByLevel,
        groupBySystem: config.results.groupBySystemClassification,
        outputPath:    config.results.exportPath,
        dryRun,
      });
      report = await processor.processAll(modelSetId, versionIndex, testsForResults);
      for (const t of testsForResults) {
        const groupsForTest = report.groups.filter(g => g.testId === t.remoteId);
        const clashCount = groupsForTest.reduce((n, g) => n + g.clashCount, 0);
        emit('info', `  ▸ ${t.name}: ${groupsForTest.length} group(s), ${clashCount} clash(es)`);
      }
    } else {
      emit('info', dryRun ? '── Step 6 / 6  Skipped (dry run)' : '── Step 6 / 6  No completed tests to process');
    }

    emit('info', '');
    emit('info', '══════════ Workflow Complete ══════════');
    emit('info', `  Disciplines  : ${disciplines.join(', ') || '—'}`);
    emit('info', `  Search Sets  : ${ssCreated} created`);
    emit('info', `  Clash Tests  : ${testsCreated} created`);
    emit('info', `  Clash Groups : ${report.totalGroups}`);
    emit('info', `  Total Clashes: ${report.totalClashes}`);

    done(true, { disciplines, ssCreated, testsCreated, report });

  } catch (err) {
    emit('error', `Workflow failed: ${err.message}`);
    done(false, { error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA catch-all
// ─────────────────────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  FormaFlow UI  →  http://localhost:${PORT}\n`);
});
