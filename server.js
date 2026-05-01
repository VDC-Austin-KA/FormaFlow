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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
app.get('/api/project/folders', async (req, res) => {
  try {
    const { accountId, projectId } = req.query;
    if (!accountId || !projectId) return res.status(400).json({ error: 'accountId and projectId required' });
    const client = await makeAPSClient();
    // Data Management API requires b. prefix on both hub and project IDs
    const hubId  = accountId.startsWith('b.') ? accountId : `b.${accountId}`;
    const projId = projectId.startsWith('b.')  ? projectId : `b.${projectId}`;
    const data = await client.get(
      `https://developer.api.autodesk.com/project/v1/hubs/${hubId}/projects/${projId}/topFolders`
    );
    res.json(data);
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
    // Use the correct v3 base URL (without the erroneous /modelcoordination/ segment)
    const MC_MODELSET_BASE = (process.env.MC_MODELSET_API_BASE
      ?? 'https://developer.api.autodesk.com/bim360/modelset/v3'
    ).replace('/bim360/modelcoordination/', '/bim360/');

    // ── Strategy 1: ACC v3 — containerId = projectId ──────────────────────
    try {
      await client.get(`${MC_MODELSET_BASE}/containers/${projectId}/modelsets`);
      return res.json({ data: [{ id: projectId }] });
    } catch (e1) {
      const s1 = e1.status || 0;

      if (s1 === 403) {
        return res.status(403).json({
          error: 'APS app is not authorised for this ACC account.',
          hint: 'An ACC Account Admin must go to Account Admin → Custom Integrations, add this Client ID, and enable Model Coordination.',
          accountId,
          projectId,
          apsStatus: 403,
        });
      }

      // 404 → project exists but MC not on v3 path — fall through to legacy lookup
      if (s1 !== 404) throw e1;
    }

    // ── Strategy 2: BIM360 legacy — fetch real containerId from HQ API ────
    let legacyContainerId = null;
    try {
      const accountIdClean = accountId.replace(/^b\./, '');
      const hqProject = await client.get(
        `https://developer.api.autodesk.com/hq/v1/accounts/${accountIdClean}/projects/${projectId}`
      );
      // BIM 360 returns the MC container under relationships.docs
      legacyContainerId = hqProject?.data?.relationships?.docs?.data?.id
        ?? hqProject?.relationships?.docs?.data?.id
        ?? null;
    } catch (_) {
      // HQ API unavailable or not a BIM360 project — continue to error
    }

    if (legacyContainerId) {
      // Verify the legacy container ID works
      try {
        await client.get(`${MC_MODELSET_BASE}/containers/${legacyContainerId}/modelsets`);
        return res.json({ data: [{ id: legacyContainerId }] });
      } catch (_) {
        // Legacy container found but still no MC access — fall through to error
      }
    }

    // ── Neither strategy succeeded ─────────────────────────────────────────
    return res.status(404).json({
      error: 'Model Coordination is not enabled for this project.',
      hint: 'In ACC, open the project → Settings → Products & Services and confirm "Model Coordination" is active. If this is a BIM360 project, ensure Model Coordination was set up when the project was created.',
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
    // Trim to essentials the UI needs to render a picker
    const items = (data?.data ?? []).map(it => ({
      id: it.id,
      type: it.type,                                // 'folders' | 'items'
      name: it.attributes?.displayName ?? it.attributes?.name ?? it.id,
      extension: it.attributes?.extension?.type ?? null,
      derivativeUrn: it.relationships?.tip?.data?.id ?? null
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.body });
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
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise APS list responses — handles data[], results[], items[], named keys, or bare arrays. */
function toArray(raw, ...extraKeys) {
  if (Array.isArray(raw)) return raw;
  for (const k of ['data', 'results', 'items', 'sets', ...extraKeys]) {
    if (Array.isArray(raw?.[k])) return raw[k];
  }
  return [];
}

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
  // Use client-provided sessionId so the SSE subscriber and emitter share the same channel.
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
    const modelSets = toArray(setsResp, 'modelsets', 'modelSets');
    if (!modelSets.length) { emit('error', '✗ No model sets found — check MC_CONTAINER_ID and ensure Model Coordination is enabled for this project'); return done(false); }

    // Prefer the space saved in env (set via Connect tab); fall back to first
    const selectedId = process.env.MC_MODEL_SET_ID;
    let ms = selectedId ? modelSets.find(s => (s.id ?? s.modelSetId) === selectedId) : null;
    if (!ms && selectedId) emit('warn', `⚠ Saved coordination space (${selectedId}) not found — using first available`);
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
        const candidate = fullVer?.data ?? fullVer?.version ?? fullVer ?? {};
        if (candidate.documents?.length) {
          emit('info', `  ✓ Full manifest: ${candidate.documents.length} document(s)`);
          versionObj = candidate;
        } else {
          const keys = [fullVer, fullVer?.data, fullVer?.version].filter(Boolean).map(o => Object.keys(o).join(', ')).join(' | ');
          emit('warn', `  ⚠ Full manifest also returned 0 documents. Response keys: [${keys}]`);
        }
      } catch (err) {
        emit('warn', `  ⚠ Could not fetch full version manifest: ${err.message}`);
      }
    }
    const docs = versionObj.documents ?? [];
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
    const ssErrors   = ssResults.filter(r => r.error);

    if (ssGen.listExistingError) {
      emit('warn', `⚠ Could not list existing Search Sets — ${ssGen.listExistingError}`);
    }
    if (ssErrors.length) {
      for (const r of ssErrors) emit('warn', `  ⚠ Search Set "${r.name}": ${r.error}`);
    }
    emit('info', `✓ Search Sets — ${ssCreated} created, ${ssSkipped} already existed, ${ssErrors.length} errors`);

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
    let testsCreated = testResults.filter(r => r.created || r.dryRun).length;
    const testsErrored = testResults.filter(r => r.error);
    if (testsErrored.length) {
      for (const r of testsErrored) emit('warn', `  ⚠ Clash test "${r.name}": ${r.error}`);
    }
    emit('info', `✓ Clash tests — ${testsCreated} created`);

    // When Search Sets API is unavailable (404) or no tests were created, fall back
    // to existing ACC clash tests that were created directly in the ACC platform.
    let testsForResults = testResults.filter(r => (r.created || r.dryRun) && r.remoteId);
    if (!testsForResults.length && !dryRun) {
      try {
        emit('info', '  No new tests — reading existing ACC clash tests as fallback');
        const existingData = await mcClient.listClashTests(modelSetId, versionIndex);
        const existing = toArray(existingData, 'tests', 'clashTests');
        if (existing.length) {
          testsForResults = existing.map(t => ({ name: t.name ?? t.id, remoteId: t.id ?? t.clashTestId, created: false }));
          emit('info', `  ✓ Found ${existing.length} existing clash test(s) in ACC`);
          testsCreated = 0; // none were newly created
        } else {
          emit('warn', '  ⚠ No clash tests found in ACC — nothing to process');
        }
      } catch (err) {
        emit('warn', `  ⚠ Could not fetch existing clash tests: ${err.message}`);
      }
    }

    // ── Step 6 — Results ────────────────────────────────────────────────
    let report = { totalGroups: 0, totalClashes: 0, groups: [] };
    if (!dryRun && testsForResults.length) {
      emit('info', '── Step 6 / 6  Waiting for results');
      for (const t of testsForResults) {
        try {
          await mcClient.waitForClashTest(modelSetId, versionIndex, t.remoteId, 5000, 300_000,
            (status) => emit('info', `    ${t.name}: ${status}`));
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
      report = await processor.processAll(modelSetId, versionIndex, testsForResults);
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
