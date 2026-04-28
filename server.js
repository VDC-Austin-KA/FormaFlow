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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
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
// APS client factory (uses current process.env)
// ─────────────────────────────────────────────────────────────────────────────

async function makeAPSClient(overrides = {}) {
  const { APSClient } = await import('./src/api/aps-client.js');
  return new APSClient(
    overrides.clientId ?? process.env.APS_CLIENT_ID,
    overrides.clientSecret ?? process.env.APS_CLIENT_SECRET
  );
}

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
    const MC_MODELSET_BASE = process.env.MC_MODELSET_API_BASE
      ?? 'https://developer.api.autodesk.com/bim360/modelset/v3';

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
    const data = await mc.listModelSets();
    res.json(data);
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
    const versions = versResp?.data ?? versResp ?? [];
    const latest   = versions[versions.length - 1] ?? null;
    const versionIndex = latest?.versionIndex ?? null;

    if (!latest) return res.json({ versionIndex: null, documents: [] });

    const docs = (latest.documents ?? []).map(d => {
      const rawUrn = d.urn ?? d.derivativeUrn ?? null;
      const viewerUrn = rawUrn
        ? Buffer.from(rawUrn).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
        : null;
      const name = d.name ?? d.fileName ?? d.displayName ?? rawUrn ?? 'Unknown';
      return {
        id:           d.id ?? rawUrn,
        name,
        rawUrn,
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
    const versions = versResp?.data ?? versResp ?? [];
    const latest   = versions[versions.length - 1];
    if (!latest) return res.json({ versionIndex: null, tests: [] });

    const versionIndex = latest.versionIndex ?? 1;
    const data = await mc.listClashTests(modelSetId, versionIndex);
    res.json({ versionIndex, tests: data?.data ?? data ?? [] });
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
      res.json({ supported: true, views: data?.data ?? data ?? [] });
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
    const { APSClient } = await import('./src/api/aps-client.js');
    const { ModelCoordinationClient } = await import('./src/api/model-coordination.js');
    const { ModelDerivativeClient }   = await import('./src/api/model-derivative.js');
    const { DisciplineClassifier }    = await import('./src/model-identification/discipline-classifier.js');
    const { SearchSetGenerator }      = await import('./src/search-sets/search-set-generator.js');
    const { ClashTestConfigurator }   = await import('./src/clash-tests/clash-test-configurator.js');
    const { ClashResultsProcessor }   = await import('./src/results/clash-results-processor.js');

    const apsClient = new APSClient();
    await apsClient.getToken();
    emit('info', '✓ APS authentication successful');

    // ── Step 2 — Model Set ──────────────────────────────────────────────
    emit('info', '── Step 2 / 6  Fetching model set');
    const mcClient = new ModelCoordinationClient(apsClient);
    const setsResp = await mcClient.listModelSets();
    const modelSets = setsResp?.data ?? setsResp ?? [];
    if (!modelSets.length) { emit('error', '✗ No model sets found — check MC_CONTAINER_ID'); return done(false); }

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
    const versions = versResp?.data ?? versResp ?? [];
    const latest   = versions[versions.length - 1];
    const versionIndex = latest?.versionIndex ?? 1;
    const docs = latest?.documents ?? [];
    emit('info', `✓ Version ${versionIndex} — ${docs.length} document(s)`);

    // ── Step 3 — Extract + Classify ─────────────────────────────────────
    emit('info', '── Step 3 / 6  Identifying disciplines');
    const mdClient = new ModelDerivativeClient(apsClient);
    const descriptors = await Promise.all(
      docs.map(d => mdClient.extractModelDescriptor(d.urn ?? d.derivativeUrn, d.name ?? d.fileName ?? 'Unknown'))
    );

    const classifier = new DisciplineClassifier();
    const classifications = classifier.classifyAll(descriptors);
    const disciplineSet = new Set();

    for (const [id, result] of classifications) {
      const model = descriptors.find(d => d.id === id);
      emit('info', `  ${model?.fileName ?? id}  →  ${result.discipline}  (${(result.confidence * 100).toFixed(1)}%)`);
      if (result.discipline !== 'UNKNOWN') disciplineSet.add(result.discipline);
    }
    const disciplines = [...disciplineSet];
    emit('info', `✓ Disciplines detected: ${disciplines.join(', ') || 'none'}`);

    // ── Step 4 — Search Sets ────────────────────────────────────────────
    emit('info', '── Step 4 / 6  Creating Search Sets');
    const ssGen = new SearchSetGenerator(mcClient, {
      overwriteExisting: config.searchSets.overwriteExisting,
      createSystemBased: config.searchSets.createSystemBasedSets,
      createFallback:    config.searchSets.createFallbackCategorySets,
      dryRun,
    });
    const ssResults = await ssGen.generateForDisciplines(modelSetId, disciplines);
    const ssCreated  = ssResults.filter(r => r.created || r.dryRun).length;
    const ssSkipped  = ssResults.filter(r => r.skipped).length;
    emit('info', `✓ Search Sets — ${ssCreated} created, ${ssSkipped} already existed`);

    const ssNameToId = new Map(ssResults.filter(r => r.remoteId).map(r => [r.name, r.remoteId]));

    // ── Step 5 — Clash Tests ────────────────────────────────────────────
    emit('info', '── Step 5 / 6  Configuring clash tests');
    const testConfigurator = new ClashTestConfigurator(mcClient, {
      subTestsEnabled: config.clashTests.subTestsEnabled,
      dryRun,
      disabledTestIds: config.clashTests.disabledTestIds,
    });
    const testResults = await testConfigurator.configureForDisciplines(
      modelSetId, versionIndex, disciplines, ssNameToId
    );
    const testsCreated = testResults.filter(r => r.created || r.dryRun).length;
    emit('info', `✓ Clash tests — ${testsCreated} created`);

    // ── Step 6 — Results ────────────────────────────────────────────────
    let report = { totalGroups: 0, totalClashes: 0, groups: [] };
    if (!dryRun && testResults.some(r => r.created)) {
      emit('info', '── Step 6 / 6  Waiting for results');
      for (const t of testResults.filter(r => r.created && r.remoteId)) {
        try {
          await mcClient.waitForClashTest(modelSetId, versionIndex, t.remoteId, 5000, 300_000);
          emit('info', `  ✓ ${t.name}`);
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
      report = await processor.processAll(modelSetId, versionIndex, testResults);
    } else {
      emit('info', dryRun ? '── Step 6 / 6  Skipped (dry run)' : '── Step 6 / 6  No tests to poll');
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
