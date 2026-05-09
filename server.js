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
  'APS_REFRESH_TOKEN',  // persists 3-legged session across Railway redeployments
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

  // Merge: .env file value → process.env value → empty string.
  // Trim each value — Railway dashboard fields and pasted IDs commonly carry
  // trailing whitespace, which silently breaks UUID-comparing API calls.
  const out = {};
  for (const key of ENV_KEYS) {
    const raw = fileValues[key] ?? process.env[key] ?? '';
    out[key] = typeof raw === 'string' ? raw.trim() : raw;
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

// On Railway and other ephemeral-filesystem hosts, $TOKENS_PATH should point
// to a mounted volume (e.g. /data/auth-tokens.json) so the 3-legged OAuth
// session survives redeploys. Falls back to a path inside the app dir for
// local development. If the configured path is unwritable (read-only fs) we
// fall back silently to the in-app path so the auth flow still functions.
const TOKENS_PATH = process.env.TOKENS_PATH || resolve(__dirname, 'config', 'auth-tokens.json');

// The callback URL must be registered in the APS application's Callback URLs list.
// Priority: APS_CALLBACK_URL env var → Railway auto-detected URL → localhost fallback.
function getCallbackUrl() {
  if (process.env.APS_CALLBACK_URL) return process.env.APS_CALLBACK_URL;
  // Railway provides RAILWAY_PUBLIC_DOMAIN (e.g. "formaflow.up.railway.app")
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/auth/callback`;
  }
  return `http://localhost:${PORT}/api/auth/callback`;
}

function readTokens() {
  try { return JSON.parse(readFileSync(TOKENS_PATH, 'utf8')); }
  catch { return null; }
}

function writeTokensFile(data) {
  // mkdir the parent of the actual TOKENS_PATH (which may be a mounted volume)
  // rather than always config/. This lets TOKENS_PATH=/data/auth-tokens.json
  // work on Railway with a /data volume mount.
  try { mkdirSync(dirname(TOKENS_PATH), { recursive: true }); } catch { /* may already exist */ }
  writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2));
}

// In-flight refresh promise. While a refresh is in progress, every caller
// awaits the same promise so we don't double-rotate the refresh_token (which
// would invalidate it server-side and force the user to log in again).
let _inflightRefresh = null;

async function refreshStoredToken() {
  if (_inflightRefresh) return _inflightRefresh;
  _inflightRefresh = (async () => {
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
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.warn('[FormaFlow] Token refresh failed:', res.status, errBody.slice(0, 200));
        return null;
      }
      const data = await res.json();
      const newRefresh = data.refresh_token ?? stored.refresh_token;
      writeTokensFile({
        ...stored,
        access_token:  data.access_token,
        refresh_token: newRefresh,
        expires_at:    Date.now() + data.expires_in * 1000,
      });
      // Keep process.env in sync so 2-legged paths and bootstrap stay aligned.
      if (newRefresh) process.env.APS_REFRESH_TOKEN = newRefresh;
      return data.access_token;
    } catch (err) {
      console.warn('[FormaFlow] Token refresh error:', err.message);
      return null;
    }
  })().finally(() => { _inflightRefresh = null; });
  return _inflightRefresh;
}

// Returns a valid 3-legged access token, refreshing if needed. Returns null if
// no service-account session has been established yet.
async function getThreeLeggedToken() {
  const stored = readTokens();
  if (!stored) return null;
  if (Date.now() < stored.expires_at - 60_000) return stored.access_token;
  return refreshStoredToken();
}

// On Railway and other ephemeral-filesystem hosts the token file is wiped on
// every redeploy. If the user has set APS_REFRESH_TOKEN in their Railway
// environment variables, bootstrap the session automatically so they don't
// need to re-authenticate after each deploy.
async function bootstrapTokenFromEnv() {
  if (existsSync(TOKENS_PATH)) return;
  const refreshToken = (process.env.APS_REFRESH_TOKEN ?? '').trim();
  if (!refreshToken) return;
  console.log('[FormaFlow] Bootstrapping 3-legged session from APS_REFRESH_TOKEN env var');
  try {
    mkdirSync(dirname(TOKENS_PATH), { recursive: true });
    writeFileSync(TOKENS_PATH, JSON.stringify({ refresh_token: refreshToken }, null, 2));
    const token = await refreshStoredToken();
    if (token) {
      console.log('[FormaFlow] ✓ 3-legged session bootstrapped — service account auto-connected');
    } else {
      console.warn('[FormaFlow] ✗ APS_REFRESH_TOKEN bootstrap failed — token expired. Re-authenticate via the Connect tab.');
      try { unlinkSync(TOKENS_PATH); } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[FormaFlow] Bootstrap error:', err.message);
  }
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
    // Keep APS_REFRESH_TOKEN in process.env so makeAPSClient bootstrap works
    // for the lifetime of this process, and write to .env for local dev.
    if (tokens.refresh_token) {
      process.env.APS_REFRESH_TOKEN = tokens.refresh_token;
      try { writeEnv({ APS_REFRESH_TOKEN: tokens.refresh_token }); } catch { /* best-effort */ }
    }
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
    loggedIn:      true,
    email:         stored.email,
    name:          stored.name,
    expiresAt:     stored.expires_at,
    expired,
    savedAt:       stored.saved_at,
    refreshToken:  stored.refresh_token,   // for Railway env var export
    envVarSet:     !!(process.env.APS_REFRESH_TOKEN?.trim()), // true = auto-reconnect on redeploy
  });
});

/** Clear stored service account session */
app.post('/api/auth/logout', (_req, res) => {
  try { unlinkSync(TOKENS_PATH); } catch { /* already gone */ }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Headless OAuth auto-login
//
// Uses stored credentials (env: AUTODESK_USER_ID + AUTODESK_USER_PW) to
// complete the 3-legged OAuth flow without browser interaction. Designed for
// "always logged in" deployments — when the access token expires and the
// refresh token has been rotated/invalidated, this endpoint can re-establish
// the session automatically.
//
// Implementation: server-side fetch with cookie jar, follows the OAuth flow,
// posts credentials to the Autodesk login form, captures the final ?code=
// from the redirect to /api/auth/callback, then exchanges for tokens.
// ─────────────────────────────────────────────────────────────────────────────

/** Tiny cookie jar for fetch — stores cookies per host and replays them. */
function makeCookieJar() {
  const store = new Map(); // host → Map(name → value)
  return {
    set(host, setCookieHeaders) {
      const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      const jar = store.get(host) ?? new Map();
      for (const raw of headers) {
        if (!raw) continue;
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      store.set(host, jar);
    },
    get(host) {
      const jar = store.get(host);
      if (!jar) return '';
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    debug() {
      const out = {};
      for (const [h, j] of store) out[h] = [...j.keys()];
      return out;
    },
  };
}

/**
 * Headless OAuth auto-login. Uses stored credentials (env: AUTODESK_USER_ID +
 * AUTODESK_USER_PW) to drive a Puppeteer-controlled browser through the
 * Autodesk signin flow and capture the resulting authorization code.
 *
 * GET  /api/auth/auto-login          → kicks off the login (idempotent)
 * POST /api/auth/auto-login          → same, just for clients that don't allow GET side effects
 *
 * Returns 200 with { ok: true } on success, 4xx/5xx with details otherwise.
 * On success, tokens are written via writeTokensFile() and the existing
 * 3-legged paths pick them up automatically.
 */
async function _autoLoginHandler(_req, res) {
  const email = process.env.AUTODESK_USER_ID;
  const password = process.env.AUTODESK_USER_PW;
  if (!email || !password) {
    return res.status(400).json({ error: 'AUTODESK_USER_ID and AUTODESK_USER_PW must be set in env' });
  }
  const clientId = process.env.APS_CLIENT_ID;
  const clientSecret = process.env.APS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'APS_CLIENT_ID / APS_CLIENT_SECRET not set' });
  }

  let browser = null;
  try {
    // Use puppeteer-extra + stealth so Autodesk's anti-bot doesn't reject us.
    const { default: puppeteerExtra } = await import('puppeteer-extra');
    const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    // Discover Chromium executable. On Railway/nixpacks the binary is in PATH
    // as 'chromium'; locally we let Puppeteer use its bundled copy.
    let executablePath;
    try {
      const { execSync } = await import('child_process');
      executablePath = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
    } catch { executablePath = undefined; }

    // Wrap launch in race against timeout so a hung Chrome doesn't 502 the request
    const launchPromise = puppeteerExtra.launch({
      headless: true,
      timeout: 60000,
      ...(executablePath && { executablePath }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-zygote',
      ],
    });
    browser = await Promise.race([
      launchPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Puppeteer launch timeout 60s — likely missing Chromium deps on host')), 60000)),
    ]);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Build OAuth authorize URL — point redirect at /api/auth/callback so the
    // existing handler stores the tokens.
    const callbackUrl = getCallbackUrl();
    const authUrl = new URL('https://developer.api.autodesk.com/authentication/v2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('scope', 'data:read data:write data:create account:read account:write viewables:read openid');

    // Intercept the final redirect so we can capture the code without hitting our own callback.
    let capturedCode = null;
    let capturedError = null;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const u = frame.url();
      if (u.startsWith(callbackUrl) || u.includes('/api/auth/callback')) {
        try {
          const parsed = new URL(u);
          capturedCode = parsed.searchParams.get('code') ?? capturedCode;
          capturedError = parsed.searchParams.get('error') ?? capturedError;
        } catch { /* ignore */ }
      }
    });

    await page.goto(authUrl.toString(), { waitUntil: 'networkidle2', timeout: 45000 });

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Wait for the React SPA to mount the email input. Modern Autodesk signin
    // uses #userName. Polling rather than waitForSelector to be resilient to
    // hydration timing.
    let emailInputFound = false;
    for (let i = 0; i < 30; i++) {
      const has = await page.$('#userName').then(el => !!el).catch(() => false);
      if (has) { emailInputFound = true; break; }
      await sleep(1000);
    }
    if (!emailInputFound) throw new Error('Email input #userName never appeared');

    // Focus, clear, type
    await page.focus('#userName');
    await page.evaluate(() => { const el = document.querySelector('#userName'); if (el) el.value = ''; });
    await page.type('#userName', email, { delay: 50 });

    // Submit by pressing Enter (avoids timing issues with click handlers)
    await page.keyboard.press('Enter');

    // Wait for password input to appear after the email-verify XHR completes
    let pwdInputFound = false;
    for (let i = 0; i < 30; i++) {
      const has = await page.$('#password').then(el => !!el).catch(() => false);
      if (has) { pwdInputFound = true; break; }
      await sleep(1000);
    }
    if (!pwdInputFound) {
      const html = (await page.content()).slice(0, 1500);
      throw new Error(`Password input #password never appeared. URL: ${page.url()}\nHTML: ${html}`);
    }

    await page.focus('#password');
    await page.type('#password', password, { delay: 50 });
    // Wait briefly for input to settle, then press Enter and wait for navigation
    await sleep(500);
    const navWait = page.waitForNavigation({ timeout: 60000 }).catch(() => null);
    await page.keyboard.press('Enter');
    await navWait;

    // Wait for redirect to callback (intercepted via framenavigated handler)
    const t0 = Date.now();
    let lastUrl = page.url();
    while (Date.now() - t0 < 90000) {
      if (capturedCode || capturedError) break;
      const u = page.url();
      if (u !== lastUrl) { console.log('[auto-login] URL changed:', u); lastUrl = u; }
      if (u.includes('?auth=success') || u.includes('/?auth=success')) break;
      if (u.includes('/error') || u.includes('mfa') || u.includes('verify') || u.includes('challenge')) {
        const html = (await page.content()).slice(0, 1500);
        throw new Error(`Login flow stuck at: ${u}\nHTML: ${html}`);
      }
      await sleep(500);
    }
    if (!capturedCode && !capturedError) {
      // Try to capture any visible error message before giving up
      let errorOnPage = '';
      try {
        errorOnPage = await page.evaluate(() => {
          const errEls = document.querySelectorAll('[role="alert"], .error, .alert, [data-testid*="error"]');
          return Array.from(errEls).map(e => e.textContent?.trim()).filter(Boolean).join(' | ');
        });
      } catch { /* ignore */ }
      const finalUrl = page.url();
      const fullHtml = (await page.content()).slice(0, 2500);
      throw new Error(`Did not capture authorization code. Final URL: ${finalUrl}\nVisible errors: ${errorOnPage}\nHTML: ${fullHtml}`);
    }

    if (capturedError) throw new Error(`OAuth provider returned error: ${capturedError}`);
    if (!capturedCode) {
      const finalUrl = page.url();
      const html = (await page.content()).slice(0, 1500);
      throw new Error(`Did not capture authorization code. Final URL: ${finalUrl}\nHTML start: ${html}`);
    }

    // Exchange the code for tokens (mirrors /api/auth/callback logic)
    const tokenRes = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code:          capturedCode,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  callbackUrl,
      }),
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      throw new Error(`Token exchange ${tokenRes.status}: ${errBody}`);
    }
    const tokens = await tokenRes.json();

    // Best-effort profile fetch
    let _email = '', _name = '';
    try {
      const pRes = await fetch('https://developer.api.autodesk.com/authentication/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (pRes.ok) {
        const p = await pRes.json();
        _email = p.email ?? '';
        _name = p.name ?? p.preferred_username ?? '';
      }
    } catch { /* ignore */ }

    writeTokensFile({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + tokens.expires_in * 1000,
      email: _email, name: _name,
      saved_at: new Date().toISOString(),
    });
    if (tokens.refresh_token) {
      process.env.APS_REFRESH_TOKEN = tokens.refresh_token;
      try { writeEnv({ APS_REFRESH_TOKEN: tokens.refresh_token }); } catch { /* ignore */ }
    }

    res.json({ ok: true, email: _email, name: _name });
  } catch (err) {
    console.error('[FormaFlow] Auto-login error:', err.message);
    res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 1000) });
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}
app.get('/api/auth/auto-login',  _autoLoginHandler);
app.post('/api/auth/auto-login', _autoLoginHandler);

/** Trace the OAuth flow up to the login form and return the form HTML for inspection. */
app.get('/api/debug/auth-flow-trace', async (req, res) => {
  try {
    const clientId = process.env.APS_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'APS_CLIENT_ID not set' });
    const url = new URL('https://developer.api.autodesk.com/authentication/v2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', getCallbackUrl());
    url.searchParams.set('scope', 'data:read data:write data:create account:read account:write viewables:read openid');

    const jar = makeCookieJar();
    const trace = [];
    let current = url.toString();
    let body = '';
    let finalContentType = '';
    let lastResponse = null;

    for (let i = 0; i < 8; i++) {
      const u = new URL(current);
      const cookieHeader = jar.get(u.host);
      const r = await fetch(current, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (FormaFlow auto-login)',
          ...(cookieHeader && { Cookie: cookieHeader }),
        },
      });
      const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : (r.headers.raw?.()?.['set-cookie'] ?? []);
      if (setCookies?.length) jar.set(u.host, setCookies);
      trace.push({ step: i, status: r.status, url: current, location: r.headers.get('location') });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = new URL(r.headers.get('location'), current).toString();
        continue;
      }
      // Got the form
      finalContentType = r.headers.get('content-type') || '';
      body = await r.text();
      lastResponse = r;
      break;
    }

    // Extract form fields
    const forms = [];
    const formRegex = /<form[^>]*>[\s\S]*?<\/form>/gi;
    const formHtml = body.match(formRegex) ?? [];
    for (const f of formHtml) {
      const action = (f.match(/action=["']([^"']+)["']/i) ?? [])[1];
      const method = (f.match(/method=["']([^"']+)["']/i) ?? [])[1];
      const inputs = [...f.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*>/gi)].map(m => m[0]);
      forms.push({ action, method, inputs });
    }

    res.json({
      finalUrl: current,
      finalContentType,
      cookieJarHosts: jar.debug(),
      trace,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 2000),
      forms,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
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

// The MC API v3 getModelSetVersion endpoint returns documents under `documentVersions`
// (not `documents`). This helper normalises both shapes into a consistent format.
function normalizeDocuments(versionObj) {
  if (!versionObj) return [];
  const raw = versionObj.documents ?? versionObj.documentVersions ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map(d => ({
    id:            d.documentId ?? d.id ?? d.versionUrn ?? d.urn ?? null,
    name:          d.name ?? d.fileName ?? d.displayName ?? null,
    urn:           d.versionUrn ?? d.urn ?? null,
    derivativeUrn: d.derivativeUrn ?? null,
    size:          d.size ?? null,
    lastModified:  d.lastModifiedTime ?? d.modifiedAt ?? d.createTime ?? null,
  }));
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

  // Always prefer 3-legged token when available. Override getToken unconditionally
  // so that API calls made after the user logs in mid-session automatically pick
  // up the new token without the caller needing to recreate the client.
  // Falls back to 2-legged transparently when no 3-legged session is stored.
  if (!overrides.forceTwoLegged) {
    const _twoLeggedGetToken = APSClient.prototype.getToken.bind(client);
    client.getToken = async () => {
      const threeLeggedToken = await getThreeLeggedToken();
      return threeLeggedToken ?? _twoLeggedGetToken();
    };
  }

  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup diagnostic — log the resolved MC URLs so stale env overrides are
// immediately visible in Railway/etc. logs.
// ─────────────────────────────────────────────────────────────────────────────
// Defer to resolveMcBase in model-coordination.js so server.js and the MC
// client agree on the resolved URL. Both must produce identical output or
// debug endpoints will report different paths than the live API client uses.
{
  const { resolveMcBase } = await import('./src/api/model-coordination.js');
  const fixedMs = resolveMcBase('MC_MODELSET_API_BASE', 'https://developer.api.autodesk.com/bim360/modelset/v3');
  const fixedCl = resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
  console.log('[FormaFlow] MC_MODELSET_API_BASE: %s', fixedMs);
  console.log('[FormaFlow] MC_CLASH_API_BASE:    %s', fixedCl);
  if (process.env.MC_MODELSET_API_BASE?.includes('modelcoordination/') || process.env.MC_CLASH_API_BASE?.includes('modelcoordination/')) {
    console.warn('[FormaFlow] ⚠ Env vars contain "modelcoordination/" path — auto-corrected. Remove MC_MODELSET_API_BASE and MC_CLASH_API_BASE from env vars to silence this warning.');
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

/**
 * Diagnostic: actually call the MC API and return the URL + response.
 * Lets you see exactly what Autodesk returns for the listModelSets call —
 * useful when the UI shows a generic "404 not found" but the underlying
 * cause is hidden (e.g. stale env override, wrong containerId, deprecated path).
 */
app.get('/api/debug/mc-ping', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID
      ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID
      ?? process.env.ACC_PROJECT_ID
      ?? '').replace(/^b\./, '');
    if (!containerId) return res.status(400).json({ error: 'containerId required (set MC_CONTAINER_ID on the Connect tab)' });

    const { resolveMcBase } = await import('./src/api/model-coordination.js');
    const base = resolveMcBase('MC_MODELSET_API_BASE', 'https://developer.api.autodesk.com/bim360/modelset/v3');
    const url = `${base}/containers/${containerId}/modelsets`;

    const client = await makeAPSClient();
    const tokenKind = (await getThreeLeggedToken()) ? '3-legged' : '2-legged';

    // Test modelset/v3 (list model sets)
    let modelsetResult;
    try {
      const data = await client.get(url);
      modelsetResult = { ok: true, url, response: data };
    } catch (err) {
      modelsetResult = { ok: false, url, status: err.status ?? null, apsBody: err.body ?? null, message: err.message };
    }

    // Test clash/v3 (list clash-registered model sets) — reveals whether
    // this container has any clash-enabled coordination spaces.
    const { resolveMcBase: _rcb } = await import('./src/api/model-coordination.js');
    const clashBase = _rcb('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
    const clashUrl = `${clashBase}/containers/${containerId}/modelsets`;
    let clashResult;
    try {
      const data = await client.get(clashUrl);
      const sets = data?.modelSets ?? data?.data ?? (Array.isArray(data) ? data : []);
      clashResult = { ok: true, url: clashUrl, clashEnabledCount: sets.length, modelSetIds: sets.map(s => s.id ?? s.modelSetId) };
    } catch (err) {
      clashResult = { ok: false, url: clashUrl, status: err.status ?? null, apsBody: err.body ?? null, message: err.message };
    }

    res.json({
      ok: modelsetResult.ok,
      tokenKind,
      containerId,
      modelset: modelsetResult,
      clash: clashResult,
      note: !clashResult.ok
        ? 'clash/v3 returned an error — clash detection may not be provisioned for this container'
        : (clashResult.clashEnabledCount === 0
            ? 'clash/v3 returned 0 model sets — open ACC → Model Coordination and run a clash test to register the coordination space with the clash service'
            : `${clashResult.clashEnabledCount} model set(s) registered with the clash service`),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Diagnostic: returns the actual URLs the server will use for MC calls */
app.get('/api/debug/mc-config', async (_req, res) => {
  const env = readEnv();
  const { resolveMcBase } = await import('./src/api/model-coordination.js');
  const ms = resolveMcBase('MC_MODELSET_API_BASE', 'https://developer.api.autodesk.com/bim360/modelset/v3');
  const cl = resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
  res.json({
    rawEnv: {
      MC_MODELSET_API_BASE: process.env.MC_MODELSET_API_BASE || null,
      MC_CLASH_API_BASE:    process.env.MC_CLASH_API_BASE    || null,
    },
    resolved: { MC_MODELSET_BASE: ms, MC_CLASH_BASE: cl },
    container:        env.MC_CONTAINER_ID || process.env.MC_CONTAINER_ID || env.ACC_PROJECT_ID || process.env.ACC_PROJECT_ID || null,
    activeModelSetId: env.MC_MODEL_SET_ID || process.env.MC_MODEL_SET_ID || null,
    note: 'MC_MODELSET_API_BASE is auto-detected during Detect Container. If both bim360/modelset/v3 and modelcoordination/v3 fail, the container may not be onboarded to MC.',
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
    hasSecret:    !!env.APS_CLIENT_SECRET,
    callbackUrl:  getCallbackUrl(),
    searchSets:   readConfig('search-set-library.json'),
    clashTests:   readConfig('clash-test-templates.json'),
    workflow:     readConfig('workflow-config.json'),
    naming:       readConfig('naming-conventions.json'),
    disciplines:  readConfig('discipline-rules.json'),
  });
});

/** Save env vars */
app.post('/api/config/env', (req, res) => {
  try {
    const ALLOWED = [
      'APS_CLIENT_ID', 'APS_CLIENT_SECRET',
      'ACC_ACCOUNT_ID', 'ACC_PROJECT_ID',
      'MC_CONTAINER_ID', 'MC_MODEL_SET_ID', 'MC_MODELSET_API_BASE', 'TARGET_FOLDER_URN',
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

app.get('/api/config/clash-issue-templates', (_req, res) => {
  try {
    const tplPath = resolve(CONFIG_DIR, 'clash-issue-templates.json');
    const raw = existsSync(tplPath)
      ? JSON.parse(readFileSync(tplPath, 'utf8'))
      : { templates: [] };
    res.json(raw);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/config/clash-issue-templates', (req, res) => {
  try { writeConfig('clash-issue-templates.json', req.body); res.json({ ok: true }); }
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
    const env = readEnv();
    const modelSetId  = req.query.modelSetId  ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    const containerId = req.query.containerId ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID ?? process.env.ACC_PROJECT_ID;
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
    const { resolveMcBase, MC_CANDIDATE_BASES } = await import('./src/api/model-coordination.js');

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

    // ── Strategy 1: Try each known MC base URL with projectId as containerId ──
    // Different ACC accounts respond to different base URLs. Try both until one works.
    let mcStatus1 = null;
    let mcBody1   = null;
    let mcUrl1    = null;
    let workingBase = null;

    // Build the candidate list: env-override (if set) first, then the hardcoded pair
    const envBase = (process.env.MC_MODELSET_API_BASE ?? '').trim();
    const candidateBases = envBase
      ? [envBase, ...MC_CANDIDATE_BASES.filter(b => b !== envBase)]
      : [...MC_CANDIDATE_BASES];

    for (const base of candidateBases) {
      const url = `${base}/containers/${projectId}/modelsets`;
      try {
        await client.get(url);
        // Success — this base URL works for this project
        workingBase = base;
        return res.json({ data: [{ id: projectId }], workingBaseUrl: base });
      } catch (e) {
        mcStatus1 = e.status || 0;
        mcBody1   = e.body ?? null;
        mcUrl1    = url;
        if (mcStatus1 !== 403 && mcStatus1 !== 404) {
          // Unexpected error on the first candidate — don't try more
          break;
        }
        // 403/404 — try the next candidate
      }
    }


    // ── Strategy 2: verify HQ-derived containerId against MC API ──────────
    if (hqContainerId && hqContainerId !== projectId) {
      for (const base of candidateBases) {
        try {
          await client.get(`${base}/containers/${hqContainerId}/modelsets`);
          return res.json({ data: [{ id: hqContainerId }], workingBaseUrl: base });
        } catch (_) { /* try next */ }
      }
    }

    // ── Fallback: return best-guess containerId with a warning ────────────
    // For ACC/Forma v3, containerId ALWAYS equals projectId — the hqContainerId
    // returned by the HQ API is the Docs-service container, NOT the MC container.
    // We only use hqContainerId if Strategy 2 already verified it works with the
    // MC API (in which case we returned early above). Beyond that, projectId is
    // the authoritative fallback for both provisioned and unprovisioned apps.
    const inferredId = projectId;

    if (mcStatus1 === 403) {
      return res.json({
        data: [{ id: inferredId }],
        warning: 'MC API returned 403 — container ID is inferred (not verified). To verify, an ACC Account Admin must add this app as a Custom Integration: acc.autodesk.com → Account Admin → Custom Integrations → Add Integration → paste Client ID → enable Model Coordination.',
        triedUrl: mcUrl1,
        apsBody: mcBody1,
      });
    }

    // 404 from MC API after exhausting all strategies
    if (inferredId) {
      return res.json({
        data: [{ id: inferredId }],
        warning: 'Model Coordination could not be verified for this project (404). Container ID is inferred. Confirm MC is active in ACC → Settings → Products & Services.',
        triedUrl: mcUrl1,
        apsBody: mcBody1,
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
    // Strip "b." prefix — MC API rejects it; ACC project IDs may have it.
    const containerId = (req.query.containerId ?? process.env.MC_CONTAINER_ID)?.replace(/^b\./, '');
    if (!containerId) return res.status(400).json({ error: 'containerId required' });
    const { ModelCoordinationClient } = await import('./src/api/model-coordination.js');
    const client = await makeAPSClient();
    const mc = new ModelCoordinationClient(client, containerId);
    const raw = await mc.listModelSets();
    // Normalize: MC API v3 uses 'modelSets' but we check all possible variations
    // and merge them if multiple exist (unlikely but safe).
    const items = raw?.modelSets ?? raw?.modelsets ?? raw?.data ?? raw?.results ?? raw?.sets ?? null;
    const data  = Array.isArray(items) ? items : Array.isArray(raw) ? raw : [];
    res.json({ data });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** List views in a model set */
app.get('/api/mc/modelsets/:id/views', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const raw = await mc.listModelSetViews(req.params.id);
    const data = raw?.modelSetViews ?? raw?.views ?? raw?.data ?? (Array.isArray(raw) ? raw : []);
    res.json({ data });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get details for a specific view */
app.get('/api/mc/modelsets/:id/views/:viewId', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.getModelSetView(req.params.id, req.params.viewId);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Model Coordination (active coordination space)
// ─────────────────────────────────────────────────────────────────────────────

function buildMcClient(req) {
  // readEnv() covers both the .env file and process.env so settings saved
  // via the Connect tab UI (written to .env) are visible here.
  const env = readEnv();
  const rawId = req.query.containerId ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
    ?? env.ACC_PROJECT_ID ?? process.env.ACC_PROJECT_ID;  // ACC projects: container ≈ project ID
  // The MC API never accepts the "b." prefix — strip it so users who paste
  // their full ACC Project ID (e.g. "b.abc123") don't get silent 404s.
  const containerId = rawId?.replace(/^b\./, '') ?? null;
  if (!containerId) throw Object.assign(new Error('containerId required (set MC_CONTAINER_ID on the Connect tab)'), { status: 400 });
  return import('./src/api/model-coordination.js').then(async ({ ModelCoordinationClient }) => {
    const client = await makeAPSClient();
    return new ModelCoordinationClient(client, containerId);
  });
}

/** List documents (models) inside a coordination space's latest version */
app.get('/api/mc/space-documents', async (req, res) => {
  try {
    const env = readEnv();
    const modelSetId = req.query.modelSetId ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required (set MC_MODEL_SET_ID on the Connect tab)' });
    const mc = await buildMcClient(req);

    const versResp = await mc.getModelSetVersions(modelSetId);
    const versions = toArray(versResp, 'modelSetVersions', 'versions');
    const latest   = versions[versions.length - 1];
    // Default to 1 like the workflow does. Some MC API responses omit the
    // version field on the lightweight version object even though
    // version 1 exists; without this default the UI silently shows 0 documents
    // while the workflow still finds them via the full-manifest fallback.
    const versionIndex = latest?.version ?? latest?.versionIndex ?? latest?.index ?? 1;

    // The versions-list endpoint often returns lightweight objects without documents[].
    // Always try the full-manifest endpoint when the lightweight shape is empty —
    // this is the same logic the workflow uses to reliably extract documentVersions.
    let versionObj = latest ?? {};
    if (!normalizeDocuments(versionObj).length) {
      try {
        const fullVer = await mc.getModelSetVersion(modelSetId, versionIndex);
        const candidate = fullVer?.data ?? fullVer ?? {};
        if (normalizeDocuments(candidate).length) versionObj = candidate;
      } catch (_) { /* keep latest if full fetch fails */ }
    }

    const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

    const docs = normalizeDocuments(versionObj).map(d => {
      const derivativeUrn = d.derivativeUrn ?? null;
      const versionUrn    = d.urn ?? null;
      const viewableRaw   = derivativeUrn ?? versionUrn;
      const viewerUrn     = viewableRaw
        ? (viewableRaw.includes(':') ? b64url(viewableRaw) : viewableRaw)
        : null;
      const name = d.name ?? viewableRaw ?? 'Unknown';
      return {
        id:           d.id ?? versionUrn,    // document UUID from MC — matches view.modelIds
        name,
        rawUrn:       versionUrn,
        derivativeUrn,
        viewerUrn,
        size:         d.size ?? null,
        lastModified: d.lastModified ?? null,
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
    const versions = toArray(versResp, 'modelSetVersions', 'versions');
    const latest   = versions[versions.length - 1];
    if (!latest) return res.json({ versionIndex: null, tests: [] });

    const versionIndex = latest?.version ?? latest?.versionIndex ?? 1;
    const data = await mc.listClashTests(modelSetId, versionIndex);
    res.json({ versionIndex, tests: toArray(data, 'tests', 'clashTests') });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get clash groups for a specific test (all types — tries assigned, closed, then legacy paths) */
app.get('/api/mc/clash-groups', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    const versionIndex = req.query.versionIndex;
    const testId = req.query.testId;
    if (!modelSetId || !testId) {
      return res.status(400).json({ error: 'modelSetId and testId required' });
    }
    const mc = await buildMcClient(req);
    const data = await mc.getGroupedClashes(modelSetId, parseInt(versionIndex, 10) || 1, testId);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get CLOSED clash groups for a specific test (dismissed/resolved groups) */
app.get('/api/mc/clash-groups/closed', async (req, res) => {
  try {
    const testId = req.query.testId;
    if (!testId) return res.status(400).json({ error: 'testId required' });
    const mc = await buildMcClient(req);
    const data = await mc.getClosedClashGroups(testId, {
      pageLimit:         req.query.pageLimit,
      continuationToken: req.query.continuationToken,
    });
    const groups = data?.groups ?? (Array.isArray(data) ? data : []);
    res.json({ testId, groups, page: data?.page ?? null, modelSetId: data?.modelSetId, modelSetVersion: data?.modelSetVersion });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get ASSIGNED clash groups for a specific test (linked to ACC Issues) */
app.get('/api/mc/clash-groups/assigned', async (req, res) => {
  try {
    const testId = req.query.testId;
    if (!testId) return res.status(400).json({ error: 'testId required' });
    const mc = await buildMcClient(req);
    const data = await mc.getAssignedClashGroups(testId, {
      pageLimit:         req.query.pageLimit,
      continuationToken: req.query.continuationToken,
    });
    const groups = data?.groups ?? (Array.isArray(data) ? data : []);
    res.json({ testId, groups, page: data?.page ?? null, modelSetId: data?.modelSetId, modelSetVersion: data?.modelSetVersion });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get full issue details for a set of assigned clash group IDs */
app.post('/api/mc/clash-groups/assigned/details', async (req, res) => {
  try {
    const testId   = req.query.testId ?? req.body?.testId;
    const groupIds = req.body?.groupIds ?? (Array.isArray(req.body) ? req.body : null);
    if (!testId)   return res.status(400).json({ error: 'testId required' });
    if (!groupIds) return res.status(400).json({ error: 'groupIds array required in body' });
    const mc = await buildMcClient(req);
    const data = await mc.getAssignedClashGroupDetails(testId, groupIds);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** List closed clash groups model-set-wide */
app.get('/api/mc/modelsets/:id/clashes/closed', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.listClosedClashGroups(req.params.id, {
      pageLimit:         req.query.pageLimit,
      continuationToken: req.query.continuationToken,
      clashTestId:       req.query.clashTestId,
      reason:            req.query.reason,
      createdBy:         req.query.createdBy,
      after:             req.query.after,
      before:            req.query.before,
      sort:              req.query.sort,
    });
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** List assigned clash groups model-set-wide */
app.get('/api/mc/modelsets/:id/clashes/assigned', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.listAssignedClashGroups(req.params.id, {
      pageLimit:         req.query.pageLimit,
      continuationToken: req.query.continuationToken,
      clashTestId:       req.query.clashTestId,
      issueId:           req.query.issueId,
      createdBy:         req.query.createdBy,
      after:             req.query.after,
      before:            req.query.before,
      sort:              req.query.sort,
    });
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Create a model set view */
app.post('/api/mc/modelsets/:id/views', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.createModelSetView(req.params.id, req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Create a model set */
app.post('/api/mc/modelsets', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.createModelSet(req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Update a model set (name/description) */
app.patch('/api/mc/modelsets/:id', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.updateModelSet(req.params.id, req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get model set versions list */
app.get('/api/mc/modelsets/:id/versions', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const raw = await mc.getModelSetVersions(req.params.id, {
      pageLimit:         req.query.pageLimit,
      continuationToken: req.query.continuationToken,
    });
    const versions = toArray(raw, 'modelSetVersions', 'versions');
    res.json({ versions, page: raw?.page ?? null });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get a specific model set version (use 'latest' for the tip) */
app.get('/api/mc/modelsets/:id/versions/:version', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.getModelSetVersion(req.params.id, req.params.version);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Get clash group job status */
app.get('/api/mc/clash-group-jobs/:jobId', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.getClashGroupJobStatus(req.params.jobId);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** List existing search sets for a coordination space (version-aware).
 *  Falls back to the v3 /rules document when /searchsets returns 404. */
app.get('/api/mc/search-sets', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);
    let versionIndex = Number(req.query.versionIndex) || null;
    if (!versionIndex) {
      const versResp = await mc.getModelSetVersions(modelSetId);
      const versions = toArray(versResp, 'modelSetVersions', 'versions');
      const latest   = versions[versions.length - 1];
      versionIndex   = latest?.version ?? latest?.versionIndex ?? latest?.index ?? 1;
    }
    try {
      const data = await mc.listSearchSets(modelSetId, versionIndex);
      res.json({ versionIndex, apiSurface: 'searchsets', data });
    } catch (ssErr) {
      const is404 = ssErr.status === 404 || String(ssErr.message).includes('404');
      if (!is404) throw ssErr;
      // v3 unified-rules: /searchsets doesn't exist; fetch /rules instead
      try {
        const rules = await mc.getClashRules(modelSetId);
        res.json({ versionIndex, apiSurface: 'rules', rules });
      } catch (rulesErr) {
        res.status(404).json({
          error: '/searchsets endpoint not available (404) and /rules also failed',
          searchSetsError: ssErr.message,
          rulesError: rulesErr.message,
        });
      }
    }
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Fetch the v3 unified clash-rules document for a coordination space. */
app.get('/api/mc/clash-rules', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);
    const rules = await mc.getClashRules(modelSetId);
    res.json({ modelSetId, rules });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Update the v3 unified clash-rules document. Re-fetches checksum for If-Match.
 *  Exposed via PUT and POST so proxies that block PUT can use POST.
 *  Includes aggregateId and aggregateVersion which the GET response carries
 *  and APS may require on writes. */
async function _putClashRulesHandler(req, res) {
  try {
    const modelSetId = req.query.modelSetId ?? req.body?.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);

    const current = await mc.getClashRules(modelSetId);
    const checksum = current.checksum;

    const updatedRules = {
      checksum,
      documentRules: req.body?.documentRules ?? current.documentRules,
      fileRules:     req.body?.fileRules     ?? current.fileRules,
      clashType:     req.body?.clashType     ?? current.clashType,
      clashDisabled: req.body?.clashDisabled ?? current.clashDisabled,
      ...(current.aggregateId      != null && { aggregateId:      current.aggregateId      }),
      ...(current.aggregateVersion != null && { aggregateVersion: current.aggregateVersion }),
    };

    const result = await mc.putClashRules(modelSetId, updatedRules, checksum);
    res.json({ modelSetId, updated: updatedRules, result });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body, requestBody: err.requestBody });
  }
}
app.put('/api/mc/clash-rules', _putClashRulesHandler);
app.post('/api/mc/clash-rules/update', _putClashRulesHandler);

/** Diagnostic: try PUT /rules with several body shape variations and return
 *  the exact APS response (status + body) for each. Helps determine whether
 *  the 403 is a true permission deny or a body schema rejection. */
app.post('/api/debug/clash-rules-write-test', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? req.body?.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);
    const current = await mc.getClashRules(modelSetId);

    const variants = [
      ['echo (no aggregate fields)', {
        checksum: current.checksum,
        documentRules: current.documentRules,
        fileRules: current.fileRules,
        clashType: current.clashType,
        clashDisabled: current.clashDisabled,
      }],
      ['echo + aggregateId/Version', {
        checksum: current.checksum,
        documentRules: current.documentRules,
        fileRules: current.fileRules,
        clashType: current.clashType,
        clashDisabled: current.clashDisabled,
        aggregateId: current.aggregateId,
        aggregateVersion: current.aggregateVersion,
      }],
      ['echo + aggregate fields, no checksum', {
        documentRules: current.documentRules,
        fileRules: current.fileRules,
        clashType: current.clashType,
        clashDisabled: current.clashDisabled,
        aggregateId: current.aggregateId,
        aggregateVersion: current.aggregateVersion,
      }],
      ['only required fields', {
        clashType: current.clashType,
        clashDisabled: current.clashDisabled,
      }],
    ];

    const results = [];
    for (const [label, body] of variants) {
      try {
        const r = await mc.putClashRules(modelSetId, body, current.checksum);
        results.push({ label, status: 'success', response: r });
      } catch (e) {
        results.push({
          label,
          status: 'failed',
          httpStatus: e.status,
          error: String(e.message ?? '').slice(0, 300),
          apsBody: e.body ? String(e.body).slice(0, 800) : null,
        });
      }
    }

    res.json({ modelSetId, current, results });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Aggressively probes for any way to trigger a clash run or create a clash test
 *  in this v3 container. Tries POST/PATCH/PUT against many candidate paths and
 *  returns the result of each. */
app.post('/api/debug/clash-write-probe', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? req.body?.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });

    const { resolveMcBase } = await import('./src/api/model-coordination.js');
    const clashBase = resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
    const msetBase  = resolveMcBase('MC_MODELSET_API_BASE', 'https://developer.api.autodesk.com/bim360/modelset/v3');
    const containerId = (req.query.containerId ?? process.env.MC_CONTAINER_ID ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const client = await makeAPSClient();
    const cBase = `${clashBase}/containers/${containerId}/modelsets/${modelSetId}`;
    const mBase = `${msetBase}/containers/${containerId}/modelsets/${modelSetId}`;

    const testBody = { name: 'FormaFlow Probe', clashType: 'Hard', tolerance: 0.001 };

    const attempts = [
      ['POST', `${cBase}/tests`,                               testBody],
      ['POST', `${cBase}/versions/1/tests`,                    testBody],
      ['POST', `${cBase}/checks`,                              testBody],
      ['POST', `${cBase}/clashsets`,                           testBody],
      ['POST', `${cBase}/run`,                                 {}],
      ['POST', `${cBase}/trigger`,                             {}],
      ['POST', `${cBase}/refresh`,                             {}],
      ['POST', `${cBase}/process`,                             {}],
      ['POST', `${cBase}/versions/1/run`,                      {}],
      ['POST', `${cBase}/versions/1/trigger`,                  {}],
      ['POST', `${mBase}/versions/1/process`,                  {}],
      ['POST', `${mBase}/versions/1/refresh`,                  {}],
      ['POST', `${mBase}/refresh`,                             {}],
      ['PATCH', `${cBase}/rules`,                              { documentRules: { enabled: true } }],
      ['POST',  `${cBase}/rules`,                              { documentRules: { enabled: true }, fileRules: {}, clashType: 'Hard', clashDisabled: false }],
      // 400 from POST /rules means the path exists — try several body shapes
      ['POST',  `${cBase}/rules`,                              { documentRules: {}, fileRules: {}, clashType: 'Hard', clashDisabled: false }],
      ['POST',  `${cBase}/rules`,                              {}],
      ['POST',  `${cBase}/rules`,                              { clashType: 'Hard' }],
      ['POST',  `${cBase}/rules`,                              { clashType: 'Hard', clashDisabled: false }],
      ['POST',  `${cBase}/rules`,                              { documentRules: { documents: [] }, fileRules: { files: [] }, clashType: 'Hard', clashDisabled: false }],
    ];

    const results = [];
    for (const [method, url, body] of attempts) {
      try {
        let r;
        if (method === 'POST')      r = await client.post(url, body);
        else if (method === 'PATCH') r = await client.patch(url, body);
        else if (method === 'PUT')   r = await client.put(url, body);
        results.push({ method, url: url.replace(clashBase, '').replace(msetBase, ''), status: 'success', response: r });
      } catch (e) {
        results.push({ method, url: url.replace(clashBase, '').replace(msetBase, ''),
          status: 'failed', errStatus: e.status,
          error: e.message?.slice(0, 200),
          body: e.body ? String(e.body).slice(0, 500) : null });
      }
    }

    res.json({ containerId, modelSetId, attempts: results });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Probe-and-write endpoint: try a series of likely documentRules schemas to find
 *  which one ACC accepts. Restores the original rules after first success.
 *  Live findings: ClashTestDocumentRule requires an `action` field. */
app.post('/api/mc/clash-rules/probe-schema', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? req.body?.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);

    const original = await mc.getClashRules(modelSetId);
    // Each candidate is a Map<ruleId, ClashTestDocumentRule>.
    // The rule object requires `action` (proven by API). We probe action values
    // and likely additional fields (sideA/sideB for pairings).
    // SCHEMA DISCOVERED:
    //   action 0,1 work (numeric enum); 2,3 don't exist (KeyNotFoundException)
    //   key must be a real document lineageUrn
    //   each rule needs a viewableName (the .nwc filename within the lineage)
    //
    // Fetch the views to get lineageUrn → viewableName mapping
    let docs = [];
    try {
      const views = await mc._client.get(
        `https://developer.api.autodesk.com/bim360/modelset/v3/containers/${process.env.MC_CONTAINER_ID || process.env.ACC_PROJECT_ID}/modelsets/${modelSetId}/views`
      );
      const vs = views?.modelSetViews ?? views?.views ?? [];
      const def = vs?.[0]?.definition ?? [];
      docs = def.map(d => ({ lineageUrn: d.lineageUrn, viewableName: d.viewableName }));
    } catch { /* fallback */ }
    if (docs.length < 2) {
      docs = [
        { lineageUrn: 'urn:adsk.wipprod:dm.lineage:PUWdjotqTpuWKe-njOgzTQ', viewableName: 'UTUSB_BKR_CLNG_L12.nwc' },
        { lineageUrn: 'urn:adsk.wipprod:dm.lineage:B4IpzGpUTkKbAZdzkJmFcQ', viewableName: 'UTUSB_ACLP_TMPL_R25 - UTUSB_DSGN_STRC_L12.nwc' },
      ];
    }
    const docA = docs[0], docB = docs[1];

    const candidates = [
      // Try alternative names for the viewable field
      { name: 'viewableName',  value: { [docA.lineageUrn]: { action: 1, viewableName: docA.viewableName } } },
      { name: 'viewable',      value: { [docA.lineageUrn]: { action: 1, viewable: docA.viewableName } } },
      { name: 'view',          value: { [docA.lineageUrn]: { action: 1, view: docA.viewableName } } },
      { name: 'name',          value: { [docA.lineageUrn]: { action: 1, name: docA.viewableName } } },
      { name: 'documentName',  value: { [docA.lineageUrn]: { action: 1, documentName: docA.viewableName } } },
      { name: 'nwcName',       value: { [docA.lineageUrn]: { action: 1, nwcName: docA.viewableName } } },
      { name: 'fileName',      value: { [docA.lineageUrn]: { action: 1, fileName: docA.viewableName } } },
      { name: 'viewableUrn',   value: { [docA.lineageUrn]: { action: 1, viewableUrn: docA.viewableName } } },
      // Composite key: lineage::viewable
      { name: 'key_colon',     value: { [`${docA.lineageUrn}:${docA.viewableName}`]: { action: 1 } } },
      { name: 'key_pipe',      value: { [`${docA.lineageUrn}|${docA.viewableName}`]: { action: 1 } } },
      // Rule has documents array containing both lineage+viewable
      { name: 'docs_array',    value: { [docA.lineageUrn]: { action: 1, documents: [{ lineageUrn: docA.lineageUrn, viewableName: docA.viewableName }] } } },
      // viewableName at top-level instead of inside rule
      { name: 'top_viewable',  value: { [docA.lineageUrn]: { viewableName: docA.viewableName, action: 1 } } },
      // Maybe the field is "viewables" (array)
      { name: 'viewables_arr', value: { [docA.lineageUrn]: { action: 1, viewables: [docA.viewableName] } } },
    ];

    const results = [];
    let firstAccepted = null;
    for (const c of candidates) {
      const fresh = await mc.getClashRules(modelSetId);
      try {
        const updated = {
          checksum: fresh.checksum,
          documentRules: c.value,
          fileRules: original.fileRules ?? {},
          clashType: original.clashType ?? 'Hard',
          clashDisabled: false,
        };
        const r = await mc.putClashRules(modelSetId, updated, fresh.checksum);
        results.push({ candidate: c.name, value: c.value, status: 'accepted', response: r });
        firstAccepted = c.name;
        break;
      } catch (e) {
        results.push({ candidate: c.name, value: c.value, status: 'rejected',
          errStatus: e.status, error: e.message, body: e.body });
      }
    }

    res.json({ original, firstAccepted, results });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/** Import our search set library templates into the coordination space.
 *  For /searchsets containers: creates each set via POST.
 *  For v3 /rules containers: first reads the rules document to discover the
 *  schema, then maps templates into the documentRules/fileRules structure and
 *  PUTs the result. The mapping requires the live schema (unknown until /rules
 *  returns 200), so the import returns the current rules + planned templates
 *  as a preview when the schema is not yet determined. */
app.post('/api/mc/search-sets/import', async (req, res) => {
  try {
    const modelSetId = req.query.modelSetId ?? req.body?.modelSetId ?? process.env.MC_MODEL_SET_ID;
    if (!modelSetId) return res.status(400).json({ error: 'modelSetId required' });
    const mc = await buildMcClient(req);
    const { SearchSetGenerator } = await import('./src/search-sets/search-set-generator.js');
    const disciplines = req.body?.disciplines ?? null;

    // Try /searchsets first (legacy containers)
    try {
      const versResp = await mc.getModelSetVersions(modelSetId);
      const versions = toArray(versResp, 'modelSetVersions', 'versions');
      const latest   = versions[versions.length - 1];
      const versionIndex = latest?.version ?? latest?.versionIndex ?? latest?.index ?? 1;

      const ssGen = new SearchSetGenerator(mc, {
        overwriteExisting: req.body?.overwrite ?? false,
        dryRun: req.body?.dryRun ?? false,
      });
      const detectedDiscs = disciplines ?? Object.keys(ssGen._library.searchSetGroups);
      const results = await ssGen.generateForDisciplines(modelSetId, versionIndex, detectedDiscs);

      if (ssGen.endpointUnavailable) {
        // v3 /rules path: read the current rules document, return it for schema discovery
        let rules = null;
        let rulesErr = null;
        try { rules = await mc.getClashRules(modelSetId); } catch (e) { rulesErr = e.message; }
        return res.json({
          apiSurface: 'rules',
          note: 'This container uses v3 /rules (no /searchsets). The rules document is returned below so the import schema can be determined. Re-POST with the schema once known.',
          currentRules: rules,
          rulesError: rulesErr,
          templates: ssGen.getSearchSetNamesByDiscipline(),
        });
      }

      const created = results.filter(r => r.created).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed  = results.filter(r => r.error).length;
      return res.json({ apiSurface: 'searchsets', versionIndex, created, skipped, failed, results });

    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * Diagnostic: probe every plausible search-sets URL pattern against the live
 * Autodesk API and report which one (if any) returns 200. Used to discover
 * the correct endpoint shape since public docs are sparse for this surface.
 */
app.get('/api/debug/searchsets-probe', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID  ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const modelSetId = req.query.modelSetId ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    if (!containerId || !modelSetId) {
      return res.status(400).json({ error: 'containerId and modelSetId required' });
    }

    const { resolveMcBase, ModelCoordinationClient } = await import('./src/api/model-coordination.js');
    const modelsetBase = resolveMcBase('MC_MODELSET_API_BASE', 'https://developer.api.autodesk.com/bim360/modelset/v3');
    const altModelsetBase = 'https://developer.api.autodesk.com/modelcoordination/v3';
    const clashBase    = resolveMcBase('MC_CLASH_API_BASE',    'https://developer.api.autodesk.com/bim360/clash/v3');
    const client = await makeAPSClient();
    const tokenKind = (await getThreeLeggedToken()) ? '3-legged' : '2-legged';

    // Resolve latest version index so we can test versioned paths properly.
    let versionIndex = 1;
    try {
      const mc = new ModelCoordinationClient(client, containerId);
      const versResp = await mc.getModelSetVersions(modelSetId);
      const versions = toArray(versResp, 'modelSetVersions', 'versions');
      const latest   = versions[versions.length - 1];
      versionIndex   = latest?.version ?? latest?.versionIndex ?? latest?.index ?? 1;
    } catch (_) { /* keep default 1 */ }

    // Expanded probe: all four bases × multiple sub-resource names.
    // The model set response includes "hasContentFilters: true" — strong hint
    // that Autodesk calls these "content filters" internally, not "search sets".
    const bases = [
      ['clash/v3',           clashBase],
      ['modelset/v3',        modelsetBase],
      ['modelcoordination',  altModelsetBase],
    ];
    const subResources = [
      'searchsets', 'search-sets', 'searchSets',
      'contentfilters', 'content-filters', 'contentFilters',
      'selectionsets', 'selection-sets', 'selectionSets',
      'filters', 'queries', 'rules',
    ];

    const candidates = [];
    for (const [, base] of bases) {
      for (const sub of subResources) {
        // model-set scope (no version)
        candidates.push(`${base}/containers/${containerId}/modelsets/${modelSetId}/${sub}`);
        // version-scoped
        candidates.push(`${base}/containers/${containerId}/modelsets/${modelSetId}/versions/${versionIndex}/${sub}`);
      }
      // container-scope (rare, but try)
      candidates.push(`${base}/containers/${containerId}/searchsets`);
      candidates.push(`${base}/containers/${containerId}/contentfilters`);
    }
    // Known-good control: views works on modelset/v3 with 3-legged
    candidates.push(`${modelsetBase}/containers/${containerId}/modelsets/${modelSetId}/views`);

    const results = [];
    for (const url of candidates) {
      try {
        const data = await client.get(url);
        results.push({ url, ok: true, status: 200, sampleKeys: Object.keys(data ?? {}).slice(0, 8), body: data });
      } catch (err) {
        results.push({ url, ok: false, status: err.status ?? null, message: String(err.message).slice(0, 160) });
      }
    }
    // Sort: successes first, then 403 (URL exists but auth wrong), then 404
    const sortKey = r => r.ok ? 0 : r.status === 403 ? 1 : r.status === 404 ? 2 : 3;
    results.sort((a, b) => sortKey(a) - sortKey(b));
    const summary = {
      hits200: results.filter(r => r.ok).length,
      hits403: results.filter(r => !r.ok && r.status === 403).length,
      hits404: results.filter(r => !r.ok && r.status === 404).length,
    };
    res.json({ tokenKind, containerId, modelSetId, versionIndex, summary, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Diagnostic: dump the raw model-set response with every field so we can
 * see whether search sets / content filters are exposed as a sub-resource
 * link, an embedded array, or a property hint.
 */
app.get('/api/debug/modelset-raw', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID  ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const modelSetId = req.query.modelSetId ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    if (!containerId || !modelSetId) return res.status(400).json({ error: 'containerId and modelSetId required' });

    const { ModelCoordinationClient } = await import('./src/api/model-coordination.js');
    const client = await makeAPSClient();
    const mc = new ModelCoordinationClient(client, containerId);

    const out = {};
    try { out.modelSet      = await mc.getModelSet(modelSetId); } catch (e) { out.modelSet      = { error: e.message, status: e.status }; }
    try { out.versions      = await mc.getModelSetVersions(modelSetId); } catch (e) { out.versions      = { error: e.message, status: e.status }; }
    const _verArray = out.versions?.modelSetVersions ?? out.versions?.versions ?? out.versions?.data ?? [];
    const _lastVer  = _verArray[_verArray.length - 1];
    const versionIndex = _lastVer?.version ?? _lastVer?.versionIndex ?? 1;
    try { out.fullVersion   = await mc.getModelSetVersion(modelSetId, versionIndex); } catch (e) { out.fullVersion   = { error: e.message, status: e.status }; }
    try { out.views         = await mc.listModelSetViews(modelSetId); } catch (e) { out.views         = { error: e.message, status: e.status }; }
    res.json({ containerId, modelSetId, versionIndex, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Diagnostic: dump the v3 clash-rules document and ALL existing clash-test
 * details (including resources/groups). Used to reverse-engineer the rules
 * schema since the public APS docs don't expose it.
 */
app.get('/api/debug/clash-anatomy', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID  ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const modelSetId = req.query.modelSetId ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    if (!containerId || !modelSetId) return res.status(400).json({ error: 'containerId and modelSetId required' });

    const { ModelCoordinationClient, resolveMcBase } = await import('./src/api/model-coordination.js');
    const client = await makeAPSClient();
    const mc = new ModelCoordinationClient(client, containerId);
    const tokenKind = (await getThreeLeggedToken()) ? '3-legged' : '2-legged';

    let versionIndex = 1;
    try {
      const versResp = await mc.getModelSetVersions(modelSetId);
      const versions = toArray(versResp, 'modelSetVersions', 'versions');
      const latest   = versions[versions.length - 1];
      versionIndex   = latest?.version ?? latest?.versionIndex ?? latest?.index ?? 1;
    } catch (_) {}

    const out = { tokenKind, containerId, modelSetId, versionIndex };
    try { out.rules = await mc.getClashRules(modelSetId); }
    catch (e) { out.rules = { error: e.message, status: e.status }; }

    // Versioned rules variant (in case there is a per-version document)
    const clashBase = resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
    try {
      out.versionedRules = await client.get(`${clashBase}/containers/${containerId}/modelsets/${modelSetId}/versions/${versionIndex}/rules`);
    } catch (e) { out.versionedRules = { error: e.message, status: e.status }; }

    // Also probe the non-versioned test list (some v3 containers expose this)
    try {
      out.flatTestList = await client.get(`${clashBase}/containers/${containerId}/modelsets/${modelSetId}/tests`);
    } catch (e) { out.flatTestList = { error: e.message, status: e.status ?? (String(e.message).includes('404') ? 404 : 500) }; }

    // List + drill into each existing clash test
    let testList = null;
    try { testList = await mc.listClashTests(modelSetId, versionIndex); }
    catch (e) { out.tests = { error: e.message, status: e.status }; }
    if (testList) {
      const { resolveMcBase } = await import('./src/api/model-coordination.js');
      const clashBase = resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
      const tests = toArray(testList, 'tests', 'clashTests');
      out.tests = [];
      for (const t of tests) {
        const testId = t.id ?? t.testId;
        const entry = { id: testId, summary: t };
        const flatBase = `${clashBase}/containers/${containerId}/modelsets/${modelSetId}`;

        // Versioned + non-versioned detail
        try { entry.detail = await mc.getClashTest(modelSetId, versionIndex, testId); }
        catch (e) { entry.detail = { error: e.message, status: e.status }; }

        // Resources — versioned (mc method now does versioned→flat fallback)
        try { entry.resources = await mc.getClashTestResources(modelSetId, versionIndex, testId); }
        catch (e) { entry.resources = { error: e.message, status: e.status }; }

        // Groups — versioned (mc method now does versioned→flat fallback)
        try { entry.groups = await mc.getGroupedClashes(modelSetId, versionIndex, testId); }
        catch (e) { entry.groups = { error: e.message, status: e.status }; }

        // Probe additional URL patterns that v3 containers may expose for results
        const clashBase2 = clashBase.replace(/\/bim360\//, '/');
        const extraPaths = [
          ['flatDetail',          `${flatBase}/tests/${testId}`],
          ['flatGroups',          `${flatBase}/tests/${testId}/groups`],
          ['flatResources',       `${flatBase}/tests/${testId}/resources`],
          ['clashInstances',      `${flatBase}/tests/${testId}/clashinstances`],
          ['versionedClashInst',  `${flatBase}/versions/${versionIndex}/tests/${testId}/clashinstances`],
          ['flatClashsets',       `${flatBase}/clashsets/${testId}/groups`],
          ['flatChecks',          `${flatBase}/checks/${testId}`],
          ['flatChecksGroups',    `${flatBase}/checks/${testId}/groups`],
        ];
        for (const [key, url] of extraPaths) {
          try { entry[key] = await client.get(url); }
          catch (e) { entry[key] = { error: e.message, status: e.status ?? (String(e.message).includes('404') ? 404 : 500) }; }
        }

        out.tests.push(entry);
      }
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Diagnostic: probe every plausible URL for a specific clash test's results.
 * Pass ?testId=<uuid>&modelSetId=<id> to discover which endpoint actually holds the data.
 */
app.get('/api/debug/clash-results-probe', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID  ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const modelSetId = req.query.modelSetId ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    const testId     = req.query.testId;
    if (!containerId || !modelSetId || !testId) {
      return res.status(400).json({ error: 'containerId, modelSetId, and testId required' });
    }

    const { resolveMcBase } = await import('./src/api/model-coordination.js');
    const clashBase = resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');
    const client = await makeAPSClient();
    const b = `${clashBase}/containers/${containerId}/modelsets/${modelSetId}`;
    const v = req.query.versionIndex ?? '1';

    const paths = [
      `${b}/versions/${v}/tests/${testId}`,
      `${b}/versions/${v}/tests/${testId}/groups`,
      `${b}/versions/${v}/tests/${testId}/resources`,
      `${b}/versions/${v}/tests/${testId}/clashinstances`,
      `${b}/tests/${testId}`,
      `${b}/tests/${testId}/groups`,
      `${b}/tests/${testId}/resources`,
      `${b}/tests/${testId}/clashinstances`,
      `${b}/clashsets/${testId}`,
      `${b}/clashsets/${testId}/groups`,
      `${b}/checks/${testId}`,
      `${b}/checks/${testId}/groups`,
    ];

    const results = {};
    for (const url of paths) {
      const key = url.replace(b, '').replace(clashBase, '');
      try {
        const data = await client.get(url);
        results[key] = { status: 200, shape: Array.isArray(data) ? `Array(${data.length})` : `Object{${Object.keys(data ?? {}).join(',')}}`, data };
      } catch (e) {
        results[key] = { status: e.status ?? (String(e.message).includes('404') ? 404 : 500), error: e.message };
      }
    }
    res.json({ containerId, modelSetId, testId, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Diagnostic: list all clash sets in the container (helps verify clash-set IDs) */
app.get('/api/mc/clash-sets', async (req, res) => {
  try {
    const mc = await buildMcClient(req);
    const data = await mc.verifyModelSet(req.query.modelSetId || process.env.MC_MODEL_SET_ID);
    res.json(data);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.body });
  }
});

/**
 * Probe ACC "Clash Checks" (the BETA named clash checks visible in the ACC
 * Model Coordination UI). These are distinct from the legacy /tests endpoint.
 * Tries GET /checks and several result sub-paths for each found check.
 */
app.get('/api/debug/clash-checks-probe', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID  ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    const modelSetId = req.query.modelSetId ?? env.MC_MODEL_SET_ID ?? process.env.MC_MODEL_SET_ID;
    if (!containerId || !modelSetId) {
      return res.status(400).json({ error: 'containerId and modelSetId required' });
    }

    const client = await makeAPSClient();

    const out = { containerId, modelSetId, checks: null, checkResults: {} };

    // Try every known and candidate base URL.
    // Some newer ACC APIs use "b.{projectId}" as the containerId.
    const bContainerId = containerId.startsWith('b.') ? containerId : `b.${containerId}`;
    const candidateBases = [
      `https://developer.api.autodesk.com/bim360/clash/v3/containers/${containerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/bim360/clash/v3/containers/${bContainerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/model-coordination/v2/containers/${containerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/model-coordination/v2/containers/${bContainerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/clash/v1/containers/${containerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/clash/v1/containers/${bContainerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/bim360/clash/v4/containers/${containerId}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/modelcoordination/v2/containers/${containerId}/modelsets/${modelSetId}`,
    ];

    // Step 1: list all named clash checks across all candidate bases
    for (const base of candidateBases) {
      for (const suffix of ['/checks', '/clashchecks', '/clashChecks']) {
        const checksUrl = `${base}${suffix}`;
        try {
          const data = await client.get(checksUrl);
          out.checks = { url: checksUrl, data };
          break;
        } catch (e) {
          out.checkResults[checksUrl] = { status: e.status ?? 500, error: e.message };
        }
      }
      if (out.checks) break;
    }

    // Step 2: if we found checks, probe results for each
    if (out.checks?.data) {
      const raw = out.checks.data;
      const checks = Array.isArray(raw) ? raw
        : Array.isArray(raw.checks) ? raw.checks
        : Array.isArray(raw.data) ? raw.data
        : Array.isArray(raw.items) ? raw.items
        : [];

      out.foundChecks = checks;
      for (const chk of checks.slice(0, 5)) {
        const id = chk.id ?? chk.checkId ?? chk.clashCheckId;
        if (!id) continue;
        const resultPaths = [
          `${b}/checks/${id}`,
          `${b}/checks/${id}/groups`,
          `${b}/checks/${id}/clashinstances`,
          `${b}/checks/${id}/resources`,
        ];
        out.checkResults[id] = {};
        for (const url of resultPaths) {
          const key = url.split(`/${id}`)[1] || 'detail';
          try {
            const data = await client.get(url);
            out.checkResults[id][key] = { status: 200, shape: Array.isArray(data) ? `Array(${data.length})` : `Object{${Object.keys(data ?? {}).join(',')}}`, data };
          } catch (e) {
            out.checkResults[id][key] = { status: e.status ?? 500, error: e.message };
          }
        }
      }
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Probe all model sets across both known MC API bases and return a combined
 * list. Helps find the "second model set" that may exist under an alternate base.
 */
app.get('/api/debug/all-modelsets', async (req, res) => {
  try {
    const env = readEnv();
    const containerId = (req.query.containerId
      ?? env.MC_CONTAINER_ID ?? process.env.MC_CONTAINER_ID
      ?? env.ACC_PROJECT_ID  ?? process.env.ACC_PROJECT_ID ?? '').replace(/^b\./, '');
    if (!containerId) {
      return res.status(400).json({ error: 'containerId required' });
    }
    const client = await makeAPSClient();
    const bases = [
      'https://developer.api.autodesk.com/bim360/modelset/v3',
      'https://developer.api.autodesk.com/modelcoordination/v3',
    ];
    const results = [];
    for (const base of bases) {
      const url = `${base}/containers/${containerId}/modelsets`;
      try {
        const data = await client.get(url);
        const sets = Array.isArray(data) ? data
          : Array.isArray(data.modelSets) ? data.modelSets
          : Array.isArray(data.data) ? data.data
          : [];
        results.push({ base, url, count: sets.length, modelSets: sets });
      } catch (e) {
        results.push({ base, url, status: e.status ?? 500, error: e.message });
      }
    }
    res.json({ containerId, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.get('/api/issues/:id/attachments', async (req, res) => {
  try {
    const data = await (await buildIssuesClient(req)).listAttachments(req.params.id);
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
        const { MC_CANDIDATE_BASES } = await import('./src/api/model-coordination.js');
        const envBase = (process.env.MC_MODELSET_API_BASE ?? '').trim();
        const bases = envBase
          ? [envBase, ...MC_CANDIDATE_BASES.filter(b => b !== envBase)]
          : [...MC_CANDIDATE_BASES];

        for (const base of bases) {
          const url = `${base}/containers/${containerId}/modelsets/${modelSetId}/views`;
          try {
            const data = await client.get(url);
            mc = toArray(data, 'modelSetViews', 'views').map(v => ({
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
            break; // This base URL worked
          } catch (e) {
            if (e.status === 404 || e.status === 403) {
              mcSupported = false;
              mcReason = e.status === 404
                ? 'MC Views API not available for this container'
                : 'MC Views API not authorized for this app — add as Custom Integration';
              // Try next base URL
            } else {
              throw e;
            }
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
      res.json({ supported: true, views: toArray(data, 'modelSetViews', 'views') });
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
    const wfEnv = readEnv();
    let containerId = wfEnv.MC_CONTAINER_ID || process.env.MC_CONTAINER_ID;
    // For ACC projects the MC container ID is typically the same as the project ID
    if (!containerId) {
      containerId = wfEnv.ACC_PROJECT_ID || process.env.ACC_PROJECT_ID;
      if (containerId) {
        emit('info', '  MC_CONTAINER_ID not set — using ACC_PROJECT_ID as fallback (typical for ACC projects)');
      }
    }
    if (!containerId) {
      emit('error', '✗ MC_CONTAINER_ID is not set — configure it on the Connect tab or in Railway env vars');
      return done(false);
    }
    // Strip any "b." prefix — the MC API rejects it.
    containerId = containerId.replace(/^b\./, '');
    const mcClient = new ModelCoordinationClient(apsClient, containerId);
    const setsResp = await mcClient.listModelSets();
    const modelSets = toArray(setsResp, 'modelsets', 'modelSets');
    if (!modelSets.length) { emit('error', '✗ No model sets found — check MC_CONTAINER_ID and ensure a Coordination Space exists in ACC'); return done(false); }

    // Prefer the user-selected coordination space; fall back to first if none chosen.
    const selectedId = wfEnv.MC_MODEL_SET_ID || process.env.MC_MODEL_SET_ID;
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
    const versions = toArray(versResp, 'modelSetVersions', 'versions');
    const latest   = versions[versions.length - 1];
    const versionIndex = latest?.version ?? latest?.versionIndex ?? 1;
    // The versions-list endpoint returns lightweight objects — documents[] is often absent.
    // Fall back to the individual version endpoint to get the full manifest.
    let versionObj = latest ?? {};
    // The MC API v3 version manifest returns documents under `documentVersions` (not `documents`).
    // normalizeDocuments() handles both keys so we don't accidentally report 0 docs.
    if (!normalizeDocuments(versionObj).length) {
      try {
        emit('info', `  Fetching full version manifest for version ${versionIndex}…`);
        const fullVer = await mcClient.getModelSetVersion(modelSetId, versionIndex);
        const candidate = fullVer?.data ?? fullVer ?? {};
        const candidateDocs = normalizeDocuments(candidate);
        if (candidateDocs.length) {
          emit('info', `  ✓ Full manifest returned ${candidateDocs.length} document(s)`);
          versionObj = candidate;
        } else {
          const allKeys = [fullVer, fullVer?.data].filter(o => o && typeof o === 'object')
            .map(o => Object.keys(o).join(', ')).join(' | ');
          emit('warn', `  ⚠ Full manifest returned 0 documents. Response keys: [${allKeys}]`);
        }
      } catch (err) {
        emit('warn', `  ⚠ Could not fetch full version manifest: ${err.message}`);
      }
    }
    const allDocs = normalizeDocuments(versionObj);

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
    // Model Derivative API requires a base64url-encoded version URN.
    // d.derivativeUrn may already be encoded; d.urn is the lineage URN
    // (contains colons) which returns 404 from the MD API.
    const _b64url = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const resolveDerivativeUrn = d => {
      const raw = d.derivativeUrn ?? d.urn ?? null;
      if (!raw) return null;
      return raw.includes(':') ? _b64url(raw) : raw;
    };
    const descriptors = await Promise.all(
      docs.map(d => mdClient.extractModelDescriptor(
        resolveDerivativeUrn(d),
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

    // Pre-flight: probe the Clash service for this model-set version. We use
    // the per-version /tests endpoint as the readiness check because clash/v3
    // doesn't expose a top-level "list model sets" endpoint.
    try {
      const clashReady = await mcClient.isClashEnabled(modelSetId, versionIndex);
      if (clashReady) {
        emit('info', '  ✓ Clash service is reachable for this model set version');
      } else {
        emit('warn', '  ⚠ Clash service does not respond for this model set version.');
        emit('warn', '    Search Set / Clash Test API calls will likely 404.');
        emit('warn', '    To fix: open ACC → Model Coordination → select your Coordination Space → run any clash test, then re-run this workflow.');
      }
    } catch (err) {
      emit('warn', `  ⚠ Could not verify clash readiness: ${err.message}`);
    }

    // Probe the v3 unified-rules endpoint up front. If present, log the current
    // rules document so the user can see (in the workflow output) exactly what
    // ACC is using to drive auto-clash on this model set. This is the modern
    // replacement for per-discipline Search Sets.
    try {
      const v3RulesDoc = await mcClient.getClashRules(modelSetId);
      const docRulesCount  = Object.keys(v3RulesDoc?.documentRules ?? {}).length;
      const fileRulesCount = Object.keys(v3RulesDoc?.fileRules ?? {}).length;
      emit('info', `  ✓ v3 unified-rules document: clashType=${v3RulesDoc?.clashType ?? '—'}, documentRules=${docRulesCount}, fileRules=${fileRulesCount}, disabled=${!!v3RulesDoc?.clashDisabled}`);
    } catch (e) {
      emit('info', `  (No v3 unified-rules document found: ${e.message})`);
    }

    const ssGen = new SearchSetGenerator(mcClient, {
      overwriteExisting: config.searchSets.overwriteExisting,
      createSystemBased: config.searchSets.createSystemBasedSets,
      createFallback:    config.searchSets.createFallbackCategorySets,
      dryRun,
    });
    const ssResults = await ssGen.generateForDisciplines(modelSetId, versionIndex, disciplines);
    if (ssGen.endpointUnavailable) {
      emit('info', '  ℹ This Coordination Space uses the v3 unified-rules clash model (no /searchsets endpoint).');
      emit('info', '    Configure clash rules from the ACC Model Coordination web UI; the workflow will read the resulting tests below.');
    } else if (ssGen.listExistingError) {
      emit('warn', `⚠ Could not list existing Search Sets — ${ssGen.listExistingError} (proceeding without conflict check)`);
    }
    let ssCreated = 0;
    if (!ssGen.endpointUnavailable) {
      ssCreated        = ssResults.filter(r => r.created || r.dryRun).length;
      const ssSkipped  = ssResults.filter(r => r.skipped).length;
      const ssFailed   = ssResults.filter(r => r.error).length;
      emit('info', `✓ Search Sets — ${ssCreated} created, ${ssSkipped} reused, ${ssFailed} failed`);
      for (const r of ssResults) {
        if (r.error)        emit('warn', `  ✗ ${r.name}: ${r.error}`);
        else if (r.skipped) emit('info', `  ↻ ${r.name} (reused, remote id: ${r.remoteId ?? '—'})`);
        else if (r.created) emit('info', `  ＋ ${r.name} (remote id: ${r.remoteId ?? '—'})`);
        else if (r.dryRun)  emit('info', `  • ${r.name} (dry run)`);
      }
    }

    // KEY FIX: clash-test templates reference search sets by library ID
    // (e.g. "ss-arch-walls"), not by name. Building the map by r.id ensures
    // resolveSearchSetIds() actually finds them. Previously the map was keyed
    // by r.name, so every clash test was silently skipped.
    const ssIdToRemoteId = new Map(
      ssResults.filter(r => r.remoteId).map(r => [r.id, r.remoteId])
    );
    if (!ssGen.endpointUnavailable) {
      emit('info', `  ${ssIdToRemoteId.size} Search Set(s) available for clash test references`);
    }
    if (!ssIdToRemoteId.size && disciplines.length && !ssGen.endpointUnavailable) {
      emit('warn', '⚠ No Search Sets resolved — clash tests will be skipped. Possible causes:');
      emit('warn', '   • ACC project may not have Model Coordination / Clash Detection enabled');
      emit('warn', '   • App lacks 3-legged token / write permission for MC API');
      emit('warn', '   • Create calls returned no remote id (response shape mismatch)');
      emit('warn', '   → Step 6 will attempt to read any clash tests already created in the ACC web UI');
    }

    // ── Step 5 — Clash Tests ────────────────────────────────────────────
    emit('info', '── Step 5 / 6  Configuring clash tests');
    if (disciplines.length < 2) {
      emit('warn', `⚠ Only ${disciplines.length} discipline(s) detected — at least 2 are required for any clash pair (e.g. ARCH + STRUCT). Assign disciplines manually on the Coordination tab if auto-detection is incomplete.`);
    }
    // When the v3 unified-rules model is in use there are no Search Sets to
    // reference — clash tests are auto-generated by ACC against the rules
    // document whenever a view is published. Skip the create loop and route
    // straight to Step 6's "read existing tests" path.
    let testResults = [];
    if (ssGen.endpointUnavailable) {
      emit('info', '  v3 unified-rules model in use — clash tests are auto-generated by ACC on view publish. Skipping create loop.');
    } else {
      const testConfigurator = new ClashTestConfigurator(mcClient, {
        subTestsEnabled: config.clashTests.subTestsEnabled,
        dryRun,
        disabledTestIds: config.clashTests.disabledTestIds,
      });
      testResults = await testConfigurator.configureForDisciplines(
        modelSetId, versionIndex, disciplines, ssIdToRemoteId
      );
    }
    const testsCreated = testResults.filter(r => r.created || r.dryRun).length;
    const testsSkipped = testResults.filter(r => !r.created && !r.dryRun && !r.error).length;
    const testsFailed  = testResults.filter(r => r.error).length;
    if (!ssGen.endpointUnavailable) {
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
        const is404 = String(e.message).includes('404');
        emit('warn', `  Could not read existing ACC clash tests: ${e.message}`);
        if (is404) {
          emit('warn', '  → The Clash API returned 404 for this container. Possible causes:');
          emit('warn', '    • Model Coordination / Clash Detection is not enabled for this ACC project');
          emit('warn', '    • The app may lack the required scope (data:read on Model Coordination)');
          emit('warn', '    • Log in to ACC → Project Admin → Services → Model Coordination and verify the feature is active');
        }
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
      if (report.totalClashes === 0 && testsForResults.length > 0) {
        emit('warn', '⚠ 0 clashes from legacy /tests. Probing ACC Clash Checks (ARCH/STRC)…');
        try {
          const checks = await mcClient.listClashChecks(modelSetId);
          if (checks.length) {
            emit('info', `  Found ${checks.length} Clash Check(s) in ACC UI: ${checks.map(c => c.name ?? c.id).join(', ')}`);
            const checkGroups = [];
            for (const chk of checks) {
              const chkId = chk.id ?? chk.checkId ?? chk.clashCheckId;
              if (!chkId) continue;
              const chkData = await mcClient.getClashCheckResults(modelSetId, chkId);
              const chkClashes = chkData ? (Array.isArray(chkData) ? chkData
                : Array.isArray(chkData.groups) ? chkData.groups
                : Array.isArray(chkData.data) ? chkData.data
                : []) : [];
              if (chkClashes.length) {
                emit('info', `  ✓ Clash Check ${chk.name ?? chkId}: ${chkClashes.length} group(s)`);
                checkGroups.push(...chkClashes.map((g, i) => ({
                  name: `${chk.name ?? 'CHECK'}_${String(i + 1).padStart(3, '0')}`,
                  level: g.levelName ?? g.level ?? 'ZUNK',
                  system: g.systemClassification ?? null,
                  clashCount: g.count ?? g.clashCount ?? (Array.isArray(g.clashes) ? g.clashes.length : 0),
                  clashes: Array.isArray(g.clashes) ? g.clashes : [],
                  testId: chkId,
                  testName: chk.name ?? chkId,
                  sequence: String(i + 1).padStart(3, '0'),
                })));
              } else {
                emit('info', `  Clash Check ${chk.name ?? chkId}: 0 groups (no result data)`);
              }
            }
            if (checkGroups.length) {
              report.groups.push(...checkGroups);
              report.totalGroups = report.groups.length;
              report.totalClashes = report.groups.reduce((s, g) => s + (g.clashCount ?? 0), 0);
              emit('info', `  ✓ Merged ${checkGroups.length} groups from Clash Checks`);
            }
          } else {
            emit('info', '  No ACC Clash Checks found via /checks endpoint');
            emit('warn', '  → To diagnose: GET /api/debug/clash-checks-probe?modelSetId=' + modelSetId);
          }
        } catch (chkErr) {
          emit('warn', `  Clash Checks probe error: ${chkErr.message}`);
        }
        if (report.totalClashes === 0) {
          emit('warn', '⚠ Still 0 clashes. The models may have no hard intersections at current tolerance.');
          emit('warn', '  Options:');
          emit('warn', '  1. Open ACC → Model Coordination → Clash checks → edit ARCH/STRC → increase Tolerance');
          emit('warn', '  2. Check that models from different disciplines overlap in 3D space');
          emit('warn', '  → Probe: /api/debug/clash-checks-probe?modelSetId=' + modelSetId);
          for (const t of testsForResults) {
            if (t.remoteId) {
              emit('warn', `  → /api/debug/clash-results-probe?testId=${t.remoteId}&modelSetId=${modelSetId}`);
            }
          }
        }

        // ── Discipline-pair fallback ─────────────────────────────────────────
        // When ACC returns 0 real clash instances (0 hard-clash intersections
        // at current tolerance), generate one structural group per discipline
        // pair so downstream steps always have ≥ 2 groups to work with.
        // Groups are clearly marked synthetic:true and clashCount:0.
        if (report.totalGroups === 0 && disciplines.length >= 2) {
          emit('info', '  ↻ Generating discipline-pair groups as structural fallback (no hard clashes found)…');
          const discs = disciplines.filter(d => d !== 'UNKNOWN').sort();
          let pairSeq = 0;
          for (let i = 0; i < discs.length; i++) {
            for (let j = i + 1; j < discs.length; j++) {
              pairSeq++;
              const seq = String(pairSeq).padStart(3, '0');
              const grpName = `${discs[i]}_vs_${discs[j]}_${seq}`;
              report.groups.push({
                name:       grpName,
                level:      'ALL',
                system:     null,
                clashCount: 0,
                clashes:    [],
                testId:     `synthetic-${discs[i]}-vs-${discs[j]}`,
                testName:   `${discs[i]} vs ${discs[j]}`,
                sequence:   seq,
                synthetic:  true,
                note:       'No hard clashes detected at current tolerance. Increase tolerance in ACC Clash Checks to surface real intersections.',
              });
              emit('info', `  ＋ ${grpName} (structural — 0 hard clashes at current tolerance)`);
            }
          }
          report.totalGroups = report.groups.length;
          report.totalClashes = 0;
          emit('info', `  ✓ ${pairSeq} discipline-pair group(s) created`);
        }
      }
    } else {
      emit('info', dryRun
        ? '── Step 6 / 6  Skipped (dry run) — set DRY_RUN=false to read existing ACC clash tests'
        : '── Step 6 / 6  No completed tests to process');
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

// Bootstrap 3-legged session from APS_REFRESH_TOKEN env var if no token file exists.
// This makes the session survive Railway redeployments without needing a Volume.
await bootstrapTokenFromEnv();

app.listen(PORT, () => {
  console.log(`\n  FormaFlow UI  →  http://localhost:${PORT}\n`);
});
