/* ═══════════════════════════════════════════════════════════
   FormaFlow — Frontend Application
   Manages: tab navigation, API calls, SSE log streaming,
   Search Set cards, Clash Test table, Settings, Run Workflow
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const State = {
  config: null,         // loaded from GET /api/config
  connected: false,
  currentTab: 'connect',
  ssFilter: 'ALL',
  runSessionId: null,
  runSSE: null,
  stepMap: { auth: 0, modelset: 1, identify: 2, searchsets: 3, clashtests: 4, results: 5 },
};

// Discipline colour map (matches CSS variables)
const DISC_COLOR = {
  ARCH: '#f59e0b', STRUCT: '#3b82f6', MECH: '#10b981',
  PLUMB: '#06b6d4', ELEC: '#f97316', FP: '#ef4444',
  CIVIL: '#78716c', INT: '#8b5cf6', UNKNOWN: '#9ca3af',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || res.statusText);
    e.hint    = err.hint    || null;
    e.apsBody = err.apsBody || null;
    e.status  = res.status;
    throw e;
  }
  return res.json().catch(() => null);
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function el(id) { return document.getElementById(id); }

function formatTime(iso) {
  return iso ? iso.slice(11, 19) : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab navigation
// ─────────────────────────────────────────────────────────────────────────────

const TAB_META = {
  connect:    { title: 'Connect',       sub: 'Configure APS credentials and ACC project' },
  hub:        { title: 'Hub Projects',  sub: 'Browse and switch between all projects in your ACC hub' },
  viewer:     { title: '3D Viewer',     sub: 'Visualize models and clash results in an interactive 3D view' },
  models:     { title: 'Models',        sub: 'View and override automatically identified disciplines' },
  coordination: { title: 'Coordination', sub: 'Assign disciplines, pick clash models, align to PBP / origin / survey / manual offsets' },
  issues:     { title: 'Issues',         sub: 'View, filter, comment, and create ACC project issues' },
  searchsets: { title: 'Search Sets',   sub: 'Toggle and preview reusable property-based filters' },
  clashtests: { title: 'Clash Tests',   sub: 'Enable, disable, and fine-tune clash test pairs' },
  settings:   { title: 'Settings',      sub: 'Workflow options, naming conventions, and output' },
  run:        { title: 'Run Workflow',   sub: 'Execute the full automated coordination workflow' },
};

// Tabs that need flex layout (not block/overflow-y-auto)
const FLEX_TABS = new Set(['viewer']);

function navigate(tab) {
  State.currentTab = tab;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    const isActive = p.id === `tab-${tab}`;
    if (FLEX_TABS.has(tab) && isActive) {
      p.classList.remove('hidden');
    } else if (FLEX_TABS.has(p.id.replace('tab-', '')) && !isActive) {
      p.classList.add('hidden');
    } else {
      p.classList.toggle('hidden', !isActive);
    }
  });
  const meta = TAB_META[tab] || {};
  el('tab-title').textContent = meta.title || tab;
  el('tab-sub').textContent = meta.sub || '';
  el('header-actions').innerHTML = '';
  if (tab === 'clashtests' || tab === 'searchsets' || tab === 'settings') renderSaveBtn(tab);
  // Lazy-init viewer on first open
  if (tab === 'viewer' && !_viewerState.sdkLoaded) initViewerTab();
  // Lazy-load coordination data
  if (tab === 'coordination' && !_coordState.loaded) loadCoordinationData();
  // Lazy-load issues + types
  if (tab === 'issues' && !_issuesState.loaded) loadIssues();
}

function renderSaveBtn(tab) {
  // Save button already in tab HTML for settings/clashtests; skip header
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect tab
// ─────────────────────────────────────────────────────────────────────────────

function populateConnect(cfg) {
  el('inp-client-id').value     = cfg.env.APS_CLIENT_ID     || '';
  el('inp-client-secret').value = cfg.env.APS_CLIENT_SECRET || '';
  el('inp-account-id').value    = cfg.env.ACC_ACCOUNT_ID    || '';
  el('inp-project-id').value    = cfg.env.ACC_PROJECT_ID    || '';
  el('inp-container-id').value  = cfg.env.MC_CONTAINER_ID   || '';
  el('inp-folder-urn').value    = cfg.env.TARGET_FOLDER_URN || '';
  if (cfg.env.TARGET_FOLDER_URN) {
    el('folder-urn-row').classList.remove('hidden');
  }
  if (cfg.env.MC_MODEL_SET_ID) {
    // Pre-seed the dropdown with the saved value; the actual list will load on demand.
    const sel = el('sel-coord-space');
    if (sel && !sel.querySelector(`option[value="${cfg.env.MC_MODEL_SET_ID}"]`)) {
      sel.add(new Option('Saved coordination space (click Load to refresh)', cfg.env.MC_MODEL_SET_ID));
    }
    if (sel) sel.value = cfg.env.MC_MODEL_SET_ID;
    showCoordSpaceInfo('Saved selection — click Load to verify and refresh.');
  }
}

function showCoordSpaceInfo(text) {
  const info = el('coord-space-info');
  if (!info) return;
  el('coord-space-info-text').textContent = text;
  info.classList.remove('hidden');
}

async function testConnection() {
  const btn = el('btn-test-conn');
  const badge = el('conn-status-badge');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  badge.className = 'hidden';

  try {
    const res = await api('POST', '/api/auth/test', {
      clientId:     el('inp-client-id').value,
      clientSecret: el('inp-client-secret').value,
    });

    badge.className = 'status-badge ok';
    badge.textContent = '✓ Connected';
    badge.classList.remove('hidden');

    el('conn-dot').className = 'w-2 h-2 rounded-full flex-shrink-0 connected';
    el('conn-label').textContent = 'Connected';
    State.connected = true;
    toast('APS connection successful', 'success');
  } catch (err) {
    badge.className = 'status-badge error';
    badge.textContent = '✗ ' + err.message;
    badge.classList.remove('hidden');

    el('conn-dot').className = 'w-2 h-2 rounded-full flex-shrink-0 failed';
    el('conn-label').textContent = 'Connection failed';
    State.connected = false;
    toast('Connection failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

async function loadFolders() {
  const accountId = el('inp-account-id').value.trim();
  const projectId = el('inp-project-id').value.trim();
  if (!accountId || !projectId) { toast('Enter Account ID and Project ID first', 'error'); return; }

  const btn = el('btn-load-folders');
  btn.disabled = true; btn.textContent = 'Loading…';

  try {
    const data = await api('GET', `/api/project/folders?accountId=${encodeURIComponent(accountId)}&projectId=${encodeURIComponent(projectId)}`);
    const folders = data?.data ?? [];
    const userFolders   = folders.filter(f => f._category !== 'system');
    const systemFolders = folders.filter(f => f._category === 'system');

    const tree = el('folder-tree');
    tree.innerHTML = '';

    // User folders first, system folders dimmed at the bottom
    for (const f of [...userFolders, ...systemFolders]) {
      tree.appendChild(buildFolderNode(
        f.id, f.attributes?.name ?? f.id, f._category === 'system'
      ));
    }

    el('folder-tree-container').classList.remove('hidden');
    if (!folders.length) toast('No folders found — check account/project IDs', 'error');
    else toast(`Loaded ${userFolders.length} project folder(s)`);
  } catch (err) {
    toast('Failed to load folders: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Load Folders';
  }
}

function buildFolderNode(folderId, folderName, isSystem = false) {
  const node = document.createElement('div');
  node.className = 'folder-tree-node';
  node.dataset.folderId = folderId;
  node.dataset.loaded   = 'false';

  node.innerHTML = `
    <div class="folder-node-row ${isSystem ? 'folder-node-system' : ''}">
      <button class="folder-expand-btn" title="Expand subfolders">▶</button>
      <svg class="w-3.5 h-3.5 flex-shrink-0 ${isSystem ? 'text-slate-400' : 'text-amber-500'}" fill="currentColor" viewBox="0 0 24 24">
        <path d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/>
      </svg>
      <span class="folder-node-name" title="${folderName}">${folderName}</span>
      ${isSystem ? '<span class="folder-system-badge">system</span>' : ''}
    </div>
    <div class="folder-node-children hidden"></div>
  `;

  const expandBtn  = node.querySelector('.folder-expand-btn');
  const nameLabel  = node.querySelector('.folder-node-name');
  const childrenEl = node.querySelector('.folder-node-children');

  // Expand / collapse
  expandBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!childrenEl.classList.contains('hidden')) {
      childrenEl.classList.add('hidden');
      expandBtn.textContent = '▶';
      expandBtn.classList.remove('expanded');
      return;
    }
    if (node.dataset.loaded === 'false') {
      await populateFolderChildren(folderId, childrenEl, expandBtn, node);
    }
    childrenEl.classList.remove('hidden');
    expandBtn.textContent = '▼';
    expandBtn.classList.add('expanded');
  });

  // Select on name click
  nameLabel.addEventListener('click', () => selectFolderNode(folderId, folderName, node));

  return node;
}

async function populateFolderChildren(folderId, childrenEl, expandBtn, parentNode) {
  const projectId = el('inp-project-id').value.trim();
  expandBtn.textContent = '⋯';
  expandBtn.disabled = true;

  try {
    const data = await api('GET',
      `/api/project/folder-contents?projectId=${encodeURIComponent(projectId)}&folderUrn=${encodeURIComponent(folderId)}`);
    const subfolders = (data?.items ?? []).filter(i => i.type === 'folders');

    parentNode.dataset.loaded = 'true';

    if (!subfolders.length) {
      childrenEl.innerHTML = '<div class="folder-leaf-msg">No subfolders</div>';
      expandBtn.textContent = '—';
      return;
    }
    subfolders.forEach(f => childrenEl.appendChild(buildFolderNode(f.id, f.name, false)));
    expandBtn.textContent = '▼';
  } catch (err) {
    childrenEl.innerHTML = '<div class="folder-leaf-msg text-red-400">Failed to load</div>';
    expandBtn.textContent = '▶';
    parentNode.dataset.loaded = 'false';
  } finally {
    expandBtn.disabled = false;
  }
}

function selectFolderNode(folderId, folderName, nodeEl) {
  // Deselect all
  document.querySelectorAll('.folder-tree-node.selected').forEach(n => n.classList.remove('selected'));
  nodeEl.classList.add('selected');

  // Update display + URN fields
  const nameSpan = el('selected-folder-name');
  nameSpan.textContent = folderName;
  nameSpan.className = 'text-sm text-slate-800 font-medium flex-1 truncate';

  el('inp-folder-urn').value = folderId;
  el('folder-urn-row').classList.remove('hidden');

  toast(`Folder selected: ${folderName}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordination Space (Model Set) selection
// ─────────────────────────────────────────────────────────────────────────────

let _coordSpaces = [];

async function loadCoordinationSpaces() {
  const containerId = el('inp-container-id').value.trim();
  hideCoordSpaceError();
  if (!containerId) { toast('Set MC Container ID first (click Detect)', 'error'); return; }

  const btn = el('btn-load-coord-spaces');
  btn.disabled = true; btn.textContent = '…';

  try {
    const data = await api('GET', `/api/project/modelsets?containerId=${encodeURIComponent(containerId)}`);
    const sets = data?.data ?? data ?? [];
    _coordSpaces = sets;

    const sel = el('sel-coord-space');
    const previousValue = sel.value;
    sel.innerHTML = sets.length
      ? '<option value="">— select a coordination space —</option>'
      : '<option value="">— no coordination spaces in this container —</option>';

    for (const s of sets) {
      const id   = s.id ?? s.modelSetId;
      const name = s.name ?? id;
      const docCount = s.documentCount ?? s.size ?? null;
      const label = docCount != null ? `${name}  (${docCount} models)` : name;
      sel.add(new Option(label, id));
    }
    if (previousValue && sel.querySelector(`option[value="${previousValue}"]`)) sel.value = previousValue;

    if (!sets.length) {
      showCoordSpaceError(
        'No coordination spaces returned',
        'The container responded but contained no model sets. Possible reasons:',
        [
          'You haven\'t created any Coordination Spaces in this project yet — open ACC → Model Coordination → New Coordination Space',
          'Your Container ID belongs to a different project',
        ]
      );
    } else {
      showCoordSpaceInfo(`${sets.length} coordination space(s) available`);
      toast(`Loaded ${sets.length} coordination space(s)`);
    }
  } catch (err) {
    const clientId = el('inp-client-id').value.trim() || '(your APS Client ID)';
    if (err.status === 403) {
      showCoordSpaceError(
        '403 Forbidden — APS app not authorized for Model Coordination on this container',
        'This is the most common gotcha. An ACC Account Admin needs to authorize your APS app:',
        [
          'Go to ACC → Account Admin → Settings → Custom Integrations',
          `Click "Add Custom Integration" and paste your APS Client ID:  ${clientId}`,
          'Give it a name (e.g. "FormaFlow") and save',
          'Wait ~30 seconds, then reload and click Load again',
        ]
      );
    } else if (err.status === 404) {
      showCoordSpaceError(
        '404 Not Found — Container does not exist on the MC API',
        'The Container ID resolved is not registered with Model Coordination. Possible reasons:',
        [
          'Your project hasn\'t been onboarded to ACC Model Coordination yet — open the MC app once in ACC web to enable',
          'The Container ID is wrong — for ACC v3 projects it equals the Project ID (without the "b." prefix)',
        ]
      );
    } else if (err.status === 401) {
      showCoordSpaceError(
        '401 Unauthorized — APS credentials rejected',
        'Verify your APS Client ID and Client Secret on the Connect tab and click Test Connection.',
        []
      );
    } else {
      showCoordSpaceError(`Error: ${err.message}`, '', []);
    }
    toast('Failed to load coordination spaces — see details under the picker', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Load';
  }
}

function showCoordSpaceError(msg, hint, steps) {
  const box = el('coord-space-error');
  el('coord-space-error-msg').textContent  = msg;
  el('coord-space-error-hint').textContent = hint ?? '';
  const stepsEl = el('coord-space-error-steps');
  stepsEl.innerHTML = '';
  if (steps?.length) {
    for (const s of steps) {
      const li = document.createElement('li');
      li.textContent = s;
      stepsEl.appendChild(li);
    }
    stepsEl.classList.remove('hidden');
  } else {
    stepsEl.classList.add('hidden');
  }
  box.classList.remove('hidden');
}

function hideCoordSpaceError() {
  el('coord-space-error')?.classList.add('hidden');
}

async function onCoordSpaceChange() {
  const sel = el('sel-coord-space');
  const id  = sel.value;
  if (!id) return;
  const name = sel.options[sel.selectedIndex]?.text ?? id;
  showCoordSpaceInfo(`Active: ${name}`);
  // Persist immediately so the workflow uses it
  try {
    await api('POST', '/api/config/env', { MC_MODEL_SET_ID: id });
    if (State.config?.env) State.config.env.MC_MODEL_SET_ID = id;
    toast('Coordination space saved');
    // Refresh views (saved views are scoped to a space)
    reloadViewsList().catch(() => {});
  } catch (err) {
    toast('Failed to save selection: ' + err.message, 'error');
  }
}

function getActiveCoordSpaceId() {
  return el('sel-coord-space')?.value || State.config?.env?.MC_MODEL_SET_ID || '';
}

function getActiveCoordSpaceName() {
  const sel = el('sel-coord-space');
  if (sel?.selectedIndex > 0) return sel.options[sel.selectedIndex].text;
  return getActiveCoordSpaceId() || '';
}

async function detectContainer() {
  const accountId = el('inp-account-id').value.trim();
  const projectId = el('inp-project-id').value.trim();
  const errPanel  = el('container-error');

  if (!accountId) { toast('Enter Account ID first', 'error'); return; }
  if (!projectId) { toast('Enter Project ID first', 'error'); return; }

  const btn = el('btn-detect-container');
  btn.disabled = true;
  btn.textContent = '…';
  errPanel.classList.add('hidden');
  errPanel.textContent = '';

  try {
    const data = await api('GET',
      `/api/project/containers?accountId=${encodeURIComponent(accountId)}&projectId=${encodeURIComponent(projectId)}`);
    const containers = data?.data ?? data ?? [];

    if (containers.length > 0) {
      const id = containers[0].id ?? containers[0];
      el('inp-container-id').value = id;

      if (data.warning) {
        // Inferred (not verified) — show amber warning, not red error
        errPanel.className = 'mt-2 p-3 rounded text-sm bg-amber-900/40 border border-amber-700 text-amber-200';
        errPanel.textContent = `⚠ ${data.warning}`;
        errPanel.classList.remove('hidden');
        toast(`Container ID filled in (unverified — see warning below)`, 'error');
      } else {
        errPanel.classList.add('hidden');
        toast(`Container detected: ${id}`);
      }
    } else {
      toast('No containers found — ensure your app is provisioned in ACC Admin', 'error');
    }
  } catch (err) {
    // Build a persistent, readable error panel
    const lines = [err.message || 'Container detection failed'];
    if (err.hint)    lines.push(`\n💡 ${err.hint}`);
    if (err.apsBody) lines.push(`\nAutodesk response: ${err.apsBody}`);
    if (err.status === 403 || err.status === 404) {
      lines.push(`\n➤ You can paste your Project ID (${projectId}) into the MC Container ID field directly — for ACC v3 projects they are the same value.`);
    }
    errPanel.className = 'mt-2 p-3 rounded text-sm bg-red-900/40 border border-red-700 text-red-200';
    errPanel.textContent = lines.join('');
    errPanel.classList.remove('hidden');
    toast(err.message || 'Container detection failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities panel
// ─────────────────────────────────────────────────────────────────────────────

const TIER_LABELS = {
  0: 'Local — No API Required',
  1: 'Authentication',
  2: 'Hub Context',
  3: 'Project Context',
  4: 'Model Coordination',
};

async function loadCapabilities() {
  try {
    const data = await api('GET', '/api/capabilities');
    renderCapabilities(data);
  } catch (e) {
    el('caps-grid').innerHTML = '<p class="text-xs text-slate-400">Could not load capabilities.</p>';
  }
}

function renderCapabilities(data) {
  const { capabilities, nextStep, summary } = data;

  // Summary badge
  const summaryEl = el('caps-summary');
  if (summaryEl) {
    summaryEl.textContent = `${summary.available} / ${summary.total} available`;
  }

  // Next-step callout
  const callout = el('caps-next-step');
  if (nextStep) {
    el('caps-next-action').textContent = `Next step: ${nextStep.action}`;
    el('caps-next-detail').textContent = nextStep.detail;
    callout.classList.remove('hidden');
  } else {
    callout.classList.add('hidden');
  }

  // Group capabilities by tier
  const byTier = {};
  for (const cap of capabilities) {
    (byTier[cap.tier] = byTier[cap.tier] || []).push(cap);
  }

  const grid = el('caps-grid');
  grid.innerHTML = '';

  for (const [tier, caps] of Object.entries(byTier).sort(([a], [b]) => +a - +b)) {
    const group = document.createElement('div');

    const label = document.createElement('p');
    label.className = 'text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2';
    label.textContent = TIER_LABELS[+tier] || `Tier ${tier}`;
    group.appendChild(label);

    const rows = document.createElement('div');
    rows.className = 'space-y-1.5';

    for (const cap of caps) {
      const row = document.createElement('div');
      row.className = [
        'flex items-start gap-3 px-3 py-2.5 rounded-lg border',
        cap.available
          ? 'bg-emerald-50 border-emerald-100'
          : 'bg-slate-50 border-slate-200 opacity-75',
      ].join(' ');

      const checkSvg = `<svg class="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
      </svg>`;
      const lockSvg = `<svg class="w-4 h-4 text-slate-300 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>`;

      const missingHtml = (!cap.available && cap.missing.length)
        ? `<p class="text-xs text-slate-400 mt-0.5">Needs: <code class="font-mono bg-slate-100 px-1 rounded">${cap.missing.join(', ')}</code></p>`
        : '';
      const noteHtml = (cap.available && cap.note)
        ? `<p class="text-xs text-emerald-600 mt-0.5 font-mono">${cap.note}</p>`
        : '';

      row.innerHTML = `
        ${cap.available ? checkSvg : lockSvg}
        <div class="min-w-0 flex-1">
          <p class="text-xs font-semibold leading-snug ${cap.available ? 'text-emerald-800' : 'text-slate-500'}">${cap.name}</p>
          <p class="text-xs leading-relaxed mt-0.5 ${cap.available ? 'text-emerald-700' : 'text-slate-400'}">${cap.description}</p>
          ${noteHtml}${missingHtml}
        </div>
      `;
      rows.appendChild(row);
    }

    group.appendChild(rows);
    grid.appendChild(group);
  }
}

async function saveEnv() {
  const folderUrn = el('inp-folder-urn').value;

  const payload = {
    APS_CLIENT_ID:     el('inp-client-id').value,
    APS_CLIENT_SECRET: el('inp-client-secret').value,
    ACC_ACCOUNT_ID:    el('inp-account-id').value,
    ACC_PROJECT_ID:    el('inp-project-id').value,
    MC_CONTAINER_ID:   el('inp-container-id').value,
    MC_MODEL_SET_ID:   el('sel-coord-space')?.value ?? '',
    TARGET_FOLDER_URN: folderUrn,
  };

  try {
    await api('POST', '/api/config/env', payload);
    if (folderUrn) {
      el('inp-folder-urn').value = folderUrn;
      el('folder-urn-row').classList.remove('hidden');
    }
    const saveStatus = el('save-status');
    saveStatus.classList.remove('hidden');
    setTimeout(() => saveStatus.classList.add('hidden'), 2500);
    toast('Configuration saved', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Sets tab
// ─────────────────────────────────────────────────────────────────────────────

// Operators offered in the editor. Symbol is for read-only preview cards.
const SS_OPERATORS = [
  { value: 'equals',      label: 'equals',           symbol: '=' },
  { value: 'notEquals',   label: 'does not equal',   symbol: '≠' },
  { value: 'contains',    label: 'contains',         symbol: '⊃' },
  { value: 'notContains', label: 'does not contain', symbol: '⊅' },
  { value: 'startsWith',  label: 'starts with',      symbol: '▸' },
  { value: 'endsWith',    label: 'ends with',        symbol: '◂' },
  { value: 'in',          label: 'is one of',        symbol: 'in' },
  { value: 'exists',      label: 'exists',           symbol: '∃' },
  { value: 'greaterThan', label: 'greater than',     symbol: '>' },
  { value: 'lessThan',    label: 'less than',        symbol: '<' }
];
const OP_SYMBOL = Object.fromEntries(SS_OPERATORS.map(o => [o.value, o.symbol]));

// In-memory editor state
const SSEditor = {
  mode: 'edit',        // 'edit' | 'create'
  originalId: null,
  draft: null,         // the set being edited (deep-copied from library)
  properties: []       // pulled from model; name → values[]
};

function renderSearchSets(library, filter = 'ALL') {
  const grid = el('ss-grid');
  grid.innerHTML = '';
  const sets = library.searchSets ?? [];

  for (const ss of sets) {
    const disc = ss.discipline;
    if (filter !== 'ALL' && disc !== filter) continue;

    const color = DISC_COLOR[disc] || '#94a3b8';
    const card = document.createElement('div');
    card.className = `ss-card${ss._disabled ? ' disabled' : ''}`;
    card.dataset.id = ss.id;

    // Build filter preview tags (respect chosen operator symbol)
    const conditions = ss.filter?.conditions ?? [];
    const tags = conditions.slice(0, 3).map(c => {
      if (c.conditionOperator) return `<span class="ss-filter-tag">(nested group)</span>`;
      const op = OP_SYMBOL[c.operator] ?? c.operator;
      const val = Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? '…');
      return `<span class="ss-filter-tag">${c.property} ${op} ${String(val).slice(0, 28)}</span>`;
    }).join('');

    card.innerHTML = `
      <div class="ss-card-top">
        <div class="flex items-start gap-2 min-w-0">
          <div class="disc-dot flex-shrink-0" style="background:${color};margin-top:4px"></div>
          <div class="min-w-0">
            <div class="ss-card-name truncate">${ss.name}</div>
            ${ss.systemBased ? '<span class="sys-badge">System-Based</span>' : ''}
          </div>
        </div>
        <label class="toggle-switch flex-shrink-0">
          <input type="checkbox" ${ss._disabled ? '' : 'checked'} data-ss-id="${ss.id}"/>
          <span class="toggle-knob"></span>
        </label>
      </div>
      <button class="ss-card-edit" data-edit-id="${ss.id}">Edit</button>
      <p class="ss-card-desc">${ss.description || ''}</p>
      <div class="flex flex-wrap">${tags}</div>
    `;

    card.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      ss._disabled = !e.target.checked;
      card.classList.toggle('disabled', ss._disabled);
    });

    card.querySelector('.ss-card-edit').addEventListener('click', () => openSSEditor(ss.id));

    grid.appendChild(card);
  }

  if (!grid.children.length) {
    grid.innerHTML = '<p class="text-slate-400 text-sm col-span-3 py-8 text-center">No Search Sets match this filter.</p>';
  }
}

async function saveSearchSets() {
  try {
    await api('PUT', '/api/config/search-sets', State.config.searchSets);
    toast('Search Sets saved', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

// ───────────────── Search Set editor modal ─────────────────

function openSSEditor(ssId) {
  const lib = State.config.searchSets;
  const existing = (lib.searchSets ?? []).find(s => s.id === ssId);
  if (!existing) { toast('Search Set not found', 'error'); return; }
  SSEditor.mode = 'edit';
  SSEditor.originalId = existing.id;
  SSEditor.draft = deepClone(existing);
  el('ss-modal-title').textContent = 'Edit Search Set';
  el('btn-ss-delete').classList.remove('hidden');
  populateSSEditor();
  el('ss-modal').classList.remove('hidden');
}

function openSSCreator(prefill) {
  SSEditor.mode = 'create';
  SSEditor.originalId = null;
  SSEditor.draft = prefill ? deepClone(prefill) : {
    id: `ss-custom-${Date.now().toString(36)}`,
    name: '',
    discipline: 'UNKNOWN',
    category: '',
    transferable: true,
    systemBased: false,
    description: '',
    filter: { conditionOperator: 'or', conditions: [{ property: 'Category', operator: 'equals', value: '' }] }
  };
  el('ss-modal-title').textContent = prefill ? 'Import Search Set' : 'New Search Set';
  el('btn-ss-delete').classList.add('hidden');
  populateSSEditor();
  el('ss-modal').classList.remove('hidden');
}

function populateSSEditor() {
  const d = SSEditor.draft;
  el('ss-edit-id').value           = d.id;
  el('ss-edit-name').value         = d.name || '';
  el('ss-edit-discipline').value   = d.discipline || 'UNKNOWN';
  el('ss-edit-category').value     = d.category || '';
  el('ss-edit-description').value  = d.description || '';
  el('ss-edit-transferable').checked = !!d.transferable;
  el('ss-edit-system-based').checked = !!d.systemBased;
  el('ss-edit-join').value         = d.filter?.conditionOperator || 'or';
  el('ss-edit-join-label').textContent = (el('ss-edit-join').value || 'or').toUpperCase();
  renderConditionRows();
  updatePropHint();
}

function renderConditionRows() {
  const host = el('ss-conditions');
  host.innerHTML = '';
  const conditions = SSEditor.draft.filter.conditions;
  conditions.forEach((c, idx) => host.appendChild(buildConditionRow(c, idx)));
}

function buildConditionRow(cond, idx) {
  const row = document.createElement('div');
  row.className = 'cond-row';
  row.dataset.idx = idx;

  const propList = SSEditor.properties.map(p => p.name);
  const datalistId = `ss-prop-list`;

  const propInput = document.createElement('input');
  propInput.type = 'text';
  propInput.value = cond.property || '';
  propInput.placeholder = 'Property (e.g. Category)';
  propInput.setAttribute('list', datalistId);
  propInput.addEventListener('input', () => {
    SSEditor.draft.filter.conditions[idx].property = propInput.value;
    refreshValueSuggestions(valueInput, propInput.value);
  });

  const opSelect = document.createElement('select');
  for (const o of SS_OPERATORS) {
    const opt = new Option(o.label, o.value);
    opSelect.add(opt);
  }
  opSelect.value = cond.operator || 'equals';
  opSelect.addEventListener('change', () => {
    SSEditor.draft.filter.conditions[idx].operator = opSelect.value;
    valueInput.disabled = opSelect.value === 'exists';
    if (opSelect.value === 'exists') valueInput.value = '';
  });

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.value = Array.isArray(cond.value) ? cond.value.join(', ') : (cond.value ?? '');
  valueInput.placeholder = opSelect.value === 'in' ? 'comma-separated values' : 'Value';
  valueInput.setAttribute('list', `${datalistId}-values-${idx}`);
  valueInput.disabled = opSelect.value === 'exists';
  valueInput.addEventListener('input', () => {
    const v = valueInput.value;
    if (opSelect.value === 'in') {
      SSEditor.draft.filter.conditions[idx].value = v.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      SSEditor.draft.filter.conditions[idx].value = v;
    }
  });

  // Values datalist (populated per-row from live model props)
  const valuesList = document.createElement('datalist');
  valuesList.id = `${datalistId}-values-${idx}`;
  row.appendChild(valuesList);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'cond-remove';
  removeBtn.innerHTML = '×';
  removeBtn.title = 'Remove condition';
  removeBtn.addEventListener('click', () => {
    SSEditor.draft.filter.conditions.splice(idx, 1);
    renderConditionRows();
  });

  row.appendChild(propInput);
  row.appendChild(opSelect);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);

  refreshValueSuggestions(valueInput, propInput.value);
  return row;
}

function refreshValueSuggestions(inputEl, propName) {
  const listId = inputEl.getAttribute('list');
  const list = listId ? document.getElementById(listId) : null;
  if (!list) return;
  list.innerHTML = '';
  const match = SSEditor.properties.find(p => p.name === propName);
  if (!match) return;
  for (const v of match.values.slice(0, 200)) {
    list.appendChild(new Option(v, v));
  }
}

// Shared properties datalist at document level so every property field can use it
function ensureSharedPropsList() {
  let list = document.getElementById('ss-prop-list');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'ss-prop-list';
    document.body.appendChild(list);
  }
  list.innerHTML = '';
  for (const p of SSEditor.properties) list.appendChild(new Option(p.name, p.name));
}

function updatePropHint() {
  const hint = el('ss-prop-hint');
  if (SSEditor.properties.length) {
    hint.textContent = `✓ ${SSEditor.properties.length} propertie(s) loaded from model — start typing in any Property field for autocomplete.`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

function closeSSEditor() {
  el('ss-modal').classList.add('hidden');
  SSEditor.draft = null;
}

function commitSSEditor() {
  const d = SSEditor.draft;
  d.name        = el('ss-edit-name').value.trim();
  d.discipline  = el('ss-edit-discipline').value;
  d.category    = el('ss-edit-category').value.trim();
  d.description = el('ss-edit-description').value.trim();
  d.transferable = el('ss-edit-transferable').checked;
  d.systemBased  = el('ss-edit-system-based').checked;
  d.filter.conditionOperator = el('ss-edit-join').value;

  if (!d.name) { toast('Name is required', 'error'); return; }
  if (!d.filter.conditions.length) { toast('Add at least one condition', 'error'); return; }

  const lib = State.config.searchSets;
  lib.searchSets = lib.searchSets ?? [];

  if (SSEditor.mode === 'edit') {
    const idx = lib.searchSets.findIndex(s => s.id === SSEditor.originalId);
    if (idx >= 0) lib.searchSets[idx] = d;
  } else {
    // Ensure ID uniqueness
    let base = d.id;
    let n = 2;
    while (lib.searchSets.some(s => s.id === d.id)) d.id = `${base}-${n++}`;
    lib.searchSets.push(d);

    // Add to the matching discipline group so the workflow picks it up
    lib.searchSetGroups = lib.searchSetGroups ?? {};
    lib.searchSetGroups[d.discipline] = lib.searchSetGroups[d.discipline] ?? [];
    if (!lib.searchSetGroups[d.discipline].includes(d.id)) {
      lib.searchSetGroups[d.discipline].push(d.id);
    }
  }

  closeSSEditor();
  renderSearchSets(lib, State.ssFilter);
  toast('Saved to local library — click "Save Library" to persist', 'success');
}

function deleteCurrentSS() {
  if (SSEditor.mode !== 'edit' || !SSEditor.originalId) return;
  if (!confirm(`Delete "${SSEditor.draft.name}" from the library?`)) return;
  const lib = State.config.searchSets;
  lib.searchSets = (lib.searchSets ?? []).filter(s => s.id !== SSEditor.originalId);
  for (const group of Object.values(lib.searchSetGroups ?? {})) {
    const idx = group.indexOf(SSEditor.originalId);
    if (idx >= 0) group.splice(idx, 1);
  }
  closeSSEditor();
  renderSearchSets(lib, State.ssFilter);
  toast('Deleted — click "Save Library" to persist', 'success');
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ───────────────── Model property picker ─────────────────

async function openModelPicker() {
  el('ss-model-modal').classList.remove('hidden');
  const status = el('ss-model-status');
  status.textContent = 'Loading folders…';

  const accountId = State.config.env.ACC_ACCOUNT_ID;
  const projectId = State.config.env.ACC_PROJECT_ID;
  if (!accountId || !projectId) {
    status.textContent = 'Set ACC Account ID and Project ID on the Connect tab first.';
    return;
  }

  try {
    const data = await api('GET', `/api/project/folders?accountId=${encodeURIComponent(accountId)}&projectId=${encodeURIComponent(projectId)}`);
    const sel = el('ss-model-folder');
    sel.innerHTML = '<option value="">— select a folder —</option>';
    for (const f of (data?.data ?? [])) {
      sel.add(new Option(f.attributes?.name || f.id, f.id));
    }
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Could not load folders: ' + err.message;
  }
}

async function loadFolderModels(folderUrn) {
  const sel = el('ss-model-pick');
  const status = el('ss-model-status');
  const pullBtn = el('btn-model-pull');
  sel.innerHTML = '<option value="">— loading —</option>';
  sel.disabled = true;
  pullBtn.disabled = true;

  const projectId = State.config.env.ACC_PROJECT_ID;
  if (!projectId) { status.textContent = 'Set Project ID first.'; return; }

  try {
    const res = await api('GET', `/api/project/folder-contents?projectId=${encodeURIComponent(projectId)}&folderUrn=${encodeURIComponent(folderUrn)}`);
    const items = (res?.items ?? []).filter(it => it.type === 'items');
    sel.innerHTML = items.length ? '<option value="">— pick a model —</option>' : '<option value="">— no models in folder —</option>';
    for (const it of items) {
      const opt = new Option(it.name, it.id);
      opt.dataset.deriv = it.derivativeUrn || '';
      sel.add(opt);
    }
    sel.disabled = !items.length;
    status.textContent = items.length ? `${items.length} model(s) found.` : '';
  } catch (err) {
    status.textContent = 'Could not load folder contents: ' + err.message;
    sel.innerHTML = '<option value="">— error —</option>';
  }
}

async function pullModelProperties() {
  const pick = el('ss-model-pick');
  const itemId = pick.value;
  if (!itemId) return;
  const status = el('ss-model-status');
  status.innerHTML = 'Extracting properties <span class="spinner-dot"></span><span class="spinner-dot"></span><span class="spinner-dot"></span>';

  const projectId = State.config.env.ACC_PROJECT_ID;
  try {
    const data = await api('GET', `/api/models/properties?projectId=${encodeURIComponent(projectId)}&itemId=${encodeURIComponent(itemId)}`);
    SSEditor.properties = data?.properties ?? [];
    ensureSharedPropsList();
    updatePropHint();
    status.textContent = `✓ ${SSEditor.properties.length} propertie(s) loaded from ${pick.options[pick.selectedIndex].text}.`;
    setTimeout(() => { el('ss-model-modal').classList.add('hidden'); }, 900);
    // Refresh current condition rows to pick up new value suggestions
    if (!el('ss-modal').classList.contains('hidden')) renderConditionRows();
  } catch (err) {
    status.textContent = 'Extraction failed: ' + err.message;
  }
}

// ───────────────── Navisworks XML import ─────────────────

async function handleNavisworksFile(file) {
  const disciplineSel = el('ss-import-discipline');
  const defaultDisc = disciplineSel ? disciplineSel.value : 'UNKNOWN';
  let xml;
  try {
    xml = await file.text();
  } catch (err) {
    toast('Could not read file: ' + err.message, 'error');
    return;
  }
  let parsed;
  try {
    const res = await fetch(`/api/search-sets/import-navisworks?discipline=${encodeURIComponent(defaultDisc)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    parsed = await res.json();
  } catch (err) {
    toast('Import parse failed: ' + err.message, 'error');
    return;
  }
  showImportPreview(parsed);
}

function showImportPreview(parsed) {
  const listHost = el('ss-import-list');
  const warnHost = el('ss-import-warnings');
  listHost.innerHTML = '';
  warnHost.innerHTML = '';

  if (parsed.warnings?.length) {
    warnHost.classList.remove('hidden');
    for (const w of parsed.warnings) {
      const line = document.createElement('div');
      line.textContent = '⚠ ' + w;
      warnHost.appendChild(line);
    }
  } else {
    warnHost.classList.add('hidden');
  }

  if (!parsed.sets?.length) {
    listHost.innerHTML = '<p class="text-sm text-slate-500 p-4 text-center">No parseable sets found.</p>';
    el('btn-import-confirm').disabled = true;
  } else {
    el('btn-import-confirm').disabled = false;
    for (const s of parsed.sets) {
      const item = document.createElement('div');
      item.className = 'imp-item';
      item.innerHTML = `
        <input type="checkbox" checked data-id="${s.id}"/>
        <div>
          <div class="imp-name">${s.name}</div>
          <div class="imp-meta">${s.filter.conditionOperator.toUpperCase()} · ${s.filter.conditions.length} condition(s) · ${s.discipline}</div>
        </div>
        <span class="imp-meta">${s.filter.conditions.slice(0, 2).map(c => `${c.property} ${OP_SYMBOL[c.operator] || c.operator} ${Array.isArray(c.value) ? c.value.join('/') : c.value}`).join(' · ')}</span>
      `;
      listHost.appendChild(item);
    }
  }
  State._pendingImport = parsed;
  el('ss-import-modal').classList.remove('hidden');
}

function mergeImportedSets() {
  const parsed = State._pendingImport;
  if (!parsed?.sets?.length) return;

  const checked = new Set([...document.querySelectorAll('#ss-import-list input[type=checkbox]')].filter(c => c.checked).map(c => c.dataset.id));
  const toAdd = parsed.sets.filter(s => checked.has(s.id));

  const lib = State.config.searchSets;
  lib.searchSets = lib.searchSets ?? [];
  lib.searchSetGroups = lib.searchSetGroups ?? {};

  let added = 0;
  for (const s of toAdd) {
    // Resolve ID collisions
    let base = s.id, n = 2;
    while (lib.searchSets.some(x => x.id === s.id)) s.id = `${base}-${n++}`;
    lib.searchSets.push(s);

    const group = lib.searchSetGroups[s.discipline] = lib.searchSetGroups[s.discipline] ?? [];
    if (!group.includes(s.id)) group.push(s.id);
    added++;
  }

  el('ss-import-modal').classList.add('hidden');
  State._pendingImport = null;
  renderSearchSets(lib, State.ssFilter);
  toast(`Imported ${added} set(s) — click "Save Library" to persist`, 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// Clash Tests tab
// ─────────────────────────────────────────────────────────────────────────────

function renderClashTests(config) {
  const tbody = el('clash-table-body');
  tbody.innerHTML = '';
  const tests = config.clashTests ?? [];

  for (const t of tests) {
    const discs = (t.requiredDisciplines ?? []).map(d =>
      `<span class="disc-tag" style="background:${DISC_COLOR[d]||'#94a3b8'}">${d}</span>`
    ).join('');

    const row = document.createElement('tr');
    row.dataset.testId = t.id;
    row.innerHTML = `
      <td class="text-slate-400 font-mono text-xs">${t.priority}</td>
      <td class="font-medium text-slate-800 font-mono text-xs">${t.name}</td>
      <td>${discs}</td>
      <td><span class="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-600 font-medium">${t.clashType}</span></td>
      <td><input class="clash-tol-input" type="number" step="0.001" min="0" value="${t.tolerance}" data-test-id="${t.id}" data-field="tolerance"/></td>
      <td class="text-center">
        ${t.subTests?.length ? `<button class="text-xs text-brand hover:underline" data-expand="${t.id}">${t.subTests.length} ▾</button>` : '<span class="text-slate-300">—</span>'}
      </td>
      <td class="text-center">
        <label class="toggle-switch">
          <input type="checkbox" ${t.enabled ? 'checked' : ''} data-test-id="${t.id}" data-field="enabled"/>
          <span class="toggle-knob"></span>
        </label>
      </td>
    `;
    tbody.appendChild(row);

    // Sub-tests (hidden by default)
    if (t.subTests?.length) {
      for (const sub of t.subTests) {
        const subRow = document.createElement('tr');
        subRow.className = 'sub-row';
        subRow.dataset.parentId = t.id;
        subRow.style.display = 'none';
        subRow.innerHTML = `
          <td></td>
          <td colspan="2" class="font-mono text-xs text-slate-500">↳ ${sub.name}</td>
          <td></td><td></td>
          <td></td>
          <td></td>
        `;
        tbody.appendChild(subRow);
      }
    }
  }

  // Expand/collapse sub-tests
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-expand]');
    if (!btn) return;
    const parentId = btn.dataset.expand;
    const subRows = tbody.querySelectorAll(`[data-parent-id="${parentId}"]`);
    const collapsed = subRows[0]?.style.display === 'none';
    subRows.forEach(r => r.style.display = collapsed ? '' : 'none');
    btn.textContent = `${subRows.length} ${collapsed ? '▴' : '▾'}`;
  });

  // Inline field changes
  tbody.addEventListener('change', e => {
    const { testId, field } = e.target.dataset;
    if (!testId || !field) return;
    const test = (State.config.clashTests.clashTests ?? []).find(t => t.id === testId);
    if (!test) return;
    if (field === 'enabled') test.enabled = e.target.checked;
    if (field === 'tolerance') test.tolerance = parseFloat(e.target.value);
  });
}

async function saveClashConfig() {
  try {
    await api('PUT', '/api/config/clash-tests', State.config.clashTests);
    toast('Clash configuration saved', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

function setAllClashTests(enabled) {
  (State.config.clashTests.clashTests ?? []).forEach(t => t.enabled = enabled);
  document.querySelectorAll('[data-field="enabled"]').forEach(cb => cb.checked = enabled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────────────

function populateSettings(cfg) {
  el('set-proj-code').value    = cfg.workflow.project?.code || 'PROJ';
  el('set-proj-name').value    = cfg.workflow.project?.name || '';
  el('set-naming-format').value = cfg.naming.clashGroupNaming?.format || '[Level]_[TestName]_[Sequence]';
  el('tog-group-level').checked  = cfg.workflow.results?.groupByLevel ?? true;
  el('tog-group-system').checked = cfg.workflow.results?.groupBySystemClassification ?? true;
  el('tog-stop-unknown').checked = cfg.workflow.workflow?.stopOnUnknownDiscipline ?? false;
  el('tog-sys-sets').checked     = cfg.workflow.searchSets?.createSystemBasedSets ?? true;
  el('tog-subtests').checked     = cfg.workflow.clashTests?.subTestsEnabled ?? true;
  el('tog-overwrite').checked    = cfg.workflow.searchSets?.overwriteExisting ?? false;
  el('set-export-path').value    = cfg.workflow.results?.exportPath || './output/clash-results';
  el('set-log-level').value      = cfg.env.LOG_LEVEL || 'info';
  updateNamingPreview();
}

function updateNamingPreview() {
  const fmt = el('set-naming-format').value || '[Level]_[TestName]_[Sequence]';
  el('naming-preview').textContent = fmt
    .replace('[Level]',      'L03')
    .replace('[TestName]',   'ARCH_vs_STRUCT')
    .replace('[SearchSetA]', 'ARCH_Floors')
    .replace('[SearchSetB]', 'STRUCT_Framing')
    .replace('[Sequence]',   '001');
}

async function saveSettings() {
  const wf = State.config.workflow;
  wf.project = wf.project || {};
  wf.project.code = el('set-proj-code').value;
  wf.project.name = el('set-proj-name').value;
  wf.results = wf.results || {};
  wf.results.groupByLevel                = el('tog-group-level').checked;
  wf.results.groupBySystemClassification = el('tog-group-system').checked;
  wf.results.exportPath                  = el('set-export-path').value;
  wf.workflow = wf.workflow || {};
  wf.workflow.stopOnUnknownDiscipline    = el('tog-stop-unknown').checked;
  wf.searchSets = wf.searchSets || {};
  wf.searchSets.createSystemBasedSets   = el('tog-sys-sets').checked;
  wf.searchSets.overwriteExisting       = el('tog-overwrite').checked;
  wf.clashTests = wf.clashTests || {};
  wf.clashTests.subTestsEnabled         = el('tog-subtests').checked;

  const namingConfig = State.config.naming;
  namingConfig.clashGroupNaming.format  = el('set-naming-format').value;

  try {
    await Promise.all([
      api('PUT', '/api/config/workflow', wf),
      api('POST', '/api/config/env', { LOG_LEVEL: el('set-log-level').value }),
    ]);
    toast('Settings saved', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run Workflow tab
// ─────────────────────────────────────────────────────────────────────────────

function appendLog(entry) {
  const log = el('log-output');
  const line = document.createElement('div');
  line.className = 'log-line';
  const lvl = entry.level || 'info';
  line.innerHTML = `
    <span class="log-ts">${formatTime(entry.ts)}</span>
    <span class="log-lvl-${lvl}">${lvl.toUpperCase().padEnd(5)}</span>
    <span class="log-msg">${escHtml(entry.message || '')}</span>
  `;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function setStep(step, state) {
  const stepEl = document.querySelector(`.step[data-step="${step}"]`);
  if (!stepEl) return;
  stepEl.classList.remove('active', 'done', 'error');
  if (state) stepEl.classList.add(state);
}

function inferStep(message) {
  if (!message) return null;
  if (message.includes('Step 1')) return { step: 'auth',       state: 'active' };
  if (message.includes('Step 2')) return { step: 'modelset',   state: 'active' };
  if (message.includes('Step 3')) return { step: 'identify',   state: 'active' };
  if (message.includes('Step 4')) return { step: 'searchsets', state: 'active' };
  if (message.includes('Step 5')) return { step: 'clashtests', state: 'active' };
  if (message.includes('Step 6')) return { step: 'results',    state: 'active' };
  if (message.includes('✓ APS auth'))   return { step: 'auth',       state: 'done' };
  if (message.includes('✓ Model set'))  return { step: 'modelset',   state: 'done' };
  if (message.includes('Disciplines'))  return { step: 'identify',   state: 'done' };
  if (message.includes('Search Sets'))  return { step: 'searchsets', state: 'done' };
  if (message.includes('Clash tests'))  return { step: 'clashtests', state: 'done' };
  return null;
}

async function runWorkflow() {
  const btn = el('btn-run');
  if (State.runSSE) { State.runSSE.close(); State.runSSE = null; }

  // Reset progress steps
  Object.keys(State.stepMap).forEach(s => setStep(s, null));
  el('run-summary').classList.add('hidden');
  el('log-output').innerHTML = '';
  btn.disabled = true;
  btn.classList.add('running');
  el('run-btn-label').textContent = 'Running…';

  const dryRun = el('tog-dry-run').checked;

  try {
    // 1. Start SSE listener before triggering the run
    const sessionId = `run-${Date.now()}`;
    await new Promise((resolve, reject) => {
      const src = new EventSource(`/api/workflow/stream?sessionId=${sessionId}`);
      State.runSSE = src;

      src.addEventListener('message', e => {
        const data = JSON.parse(e.data);

        if (data.type === 'connected') {
          resolve(); // SSE ready — now start the workflow
          return;
        }

        if (data.type === 'log') {
          appendLog(data);
          const hint = inferStep(data.message);
          if (hint) setStep(hint.step, hint.state);
          return;
        }

        if (data.type === 'done') {
          // Mark remaining active step done or error
          Object.keys(State.stepMap).forEach(s => {
            const stepEl = document.querySelector(`.step[data-step="${s}"]`);
            if (stepEl?.classList.contains('active')) {
              setStep(s, data.success ? 'done' : 'error');
            }
          });
          if (data.success) {
            Object.keys(State.stepMap).forEach(s => setStep(s, 'done'));
            showRunSummary(data);
            toast('Workflow complete', 'success');
          } else {
            toast('Workflow failed — see log', 'error');
          }
          btn.disabled = false;
          btn.classList.remove('running');
          el('run-btn-label').textContent = 'Run Workflow';
          src.close();
        }
      });

      src.onerror = () => {
        reject(new Error('SSE connection error'));
        btn.disabled = false;
        btn.classList.remove('running');
        el('run-btn-label').textContent = 'Run Workflow';
      };
    });

    // 2. Trigger the workflow (after SSE is connected)
    await api('POST', '/api/workflow/run', { dryRun, sessionId: State.runSSE?.url?.split('=')[1] });

  } catch (err) {
    toast('Run failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.classList.remove('running');
    el('run-btn-label').textContent = 'Run Workflow';
  }
}

function showRunSummary(data) {
  const body = el('run-summary-body');
  const r = data.report || {};
  const discs = (data.disciplines || []).map(d =>
    `<span class="disc-tag text-xs" style="background:${DISC_COLOR[d]||'#94a3b8'}">${d}</span>`
  ).join(' ');

  body.innerHTML = `
    <div class="flex flex-wrap gap-1 mb-1">${discs || '<span class="text-slate-400">—</span>'}</div>
    <div class="flex justify-between"><span class="text-slate-500">Search Sets</span><span class="font-medium">${data.ssCreated ?? 0} created</span></div>
    <div class="flex justify-between"><span class="text-slate-500">Clash Tests</span><span class="font-medium">${data.testsCreated ?? 0} created</span></div>
    <div class="flex justify-between"><span class="text-slate-500">Clash Groups</span><span class="font-medium">${r.totalGroups ?? 0}</span></div>
    <div class="flex justify-between"><span class="text-slate-500">Total Clashes</span><span class="font-medium text-brand">${r.totalClashes ?? 0}</span></div>
  `;
  el('run-summary').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 3D Viewer
// ─────────────────────────────────────────────────────────────────────────────

const DISC_COLORS_HEX = {
  ARCH:'#f59e0b', STRUCT:'#3b82f6', MECH:'#10b981', PLUMB:'#06b6d4',
  ELEC:'#f97316', FP:'#ef4444',    CIVIL:'#78716c', INT:'#8b5cf6', UNKNOWN:'#9ca3af',
};

const _viewerState = {
  sdkLoaded: false,
  viewer: null,
  loadedModels: [],   // { urn, name, discipline, model }
  clashGroups: [],
  activeGroup: null,
  source: 'space',    // 'space' | 'folder'
};

const RECENT_MODELS_KEY = 'formaflow.recentModels';
const RECENT_MODELS_LIMIT = 10;

function loadRecentModels() {
  try { return JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) || '[]'); }
  catch { return []; }
}

function saveRecentModel(modelDef) {
  if (!modelDef?.viewerUrn) return;
  const list = loadRecentModels().filter(m => m.viewerUrn !== modelDef.viewerUrn);
  list.unshift({
    viewerUrn:  modelDef.viewerUrn,
    name:       modelDef.name,
    discipline: modelDef.discipline ?? 'UNKNOWN',
    addedAt:    Date.now(),
  });
  localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(list.slice(0, RECENT_MODELS_LIMIT)));
  renderRecentModels();
}

function renderRecentModels() {
  const list = loadRecentModels();
  const section = el('viewer-recent-section');
  const container = el('viewer-recent-list');
  if (!section || !container) return;

  if (!list.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  container.innerHTML = '';
  for (const m of list) {
    const isLoaded = _viewerState.loadedModels.some(lm => lm.urn === m.viewerUrn);
    const row = document.createElement('div');
    row.className = `viewer-recent-row${isLoaded ? ' loaded' : ''}`;
    row.title = m.name;
    row.innerHTML = `
      <div class="disc-dot" style="background:${DISC_COLORS_HEX[m.discipline] ?? '#9ca3af'}"></div>
      <span class="model-name truncate flex-1">${m.name}</span>
      <span class="text-xs text-slate-500">${isLoaded ? '✓' : '↻'}</span>
    `;
    row.addEventListener('click', () => {
      // Reload from recent — synthetic modelDef
      const fakeItem = { name: m.name, discipline: m.discipline };
      const fauxEl = document.createElement('div');
      fauxEl.dataset.urn = m.viewerUrn;
      toggleViewerModel(fauxEl, { viewerUrn: m.viewerUrn, name: m.name, discipline: m.discipline });
      renderRecentModels();
    });
    container.appendChild(row);
  }
}

function clearRecentModels() {
  localStorage.removeItem(RECENT_MODELS_KEY);
  renderRecentModels();
  toast('Recent models cleared');
}

function setViewerSource(src) {
  _viewerState.source = src;
  document.querySelectorAll('.viewer-src-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.src === src)
  );
  el('btn-load-viewer-models').textContent = src === 'space'
    ? 'Load from Coord. Space' : 'Load from Folder';

  const infoEl = el('viewer-active-space');
  if (src === 'space') {
    const name = getActiveCoordSpaceName();
    if (name) {
      infoEl.classList.remove('hidden');
      infoEl.textContent = `📐 ${name}`;
      infoEl.title = name;
    } else {
      infoEl.classList.remove('hidden');
      infoEl.textContent = '⚠ No coordination space selected — use Connect tab';
    }
  } else {
    infoEl.classList.add('hidden');
  }
}

async function unloadAllModels() {
  if (!_viewerState.viewer || !_viewerState.loadedModels.length) return;
  const count = _viewerState.loadedModels.length;
  for (const m of _viewerState.loadedModels) {
    try { _viewerState.viewer.unloadModel(m.model); } catch (_) {}
  }
  _viewerState.loadedModels = [];
  document.querySelectorAll('.viewer-model-item.loaded').forEach(item => {
    item.classList.remove('loaded');
    const status = item.querySelector('.model-status');
    if (status) status.textContent = '▶';
  });
  updateViewerModelCounter();
  renderRecentModels();
  el('btn-unload-all-models').classList.add('hidden');
  el('viewer-status-text').textContent = '';
  toast(`Unloaded ${count} model(s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved Views (FormaFlow local + ACC Model Coordination merged)
// ─────────────────────────────────────────────────────────────────────────────

let _savedViews = [];
let _selectedView = null;

async function reloadViewsList() {
  const sel = el('sel-view');
  if (!sel) return;
  const previous = sel.value;
  sel.disabled = true;

  try {
    const containerId = el('inp-container-id').value.trim();
    const modelSetId  = getActiveCoordSpaceId();
    const qs = new URLSearchParams();
    if (containerId) qs.set('containerId', containerId);
    if (modelSetId)  qs.set('modelSetId', modelSetId);

    const data = await api('GET', `/api/views?${qs}`);
    _savedViews = data?.views ?? [];

    sel.innerHTML = '<option value="">— select a saved view —</option>';
    if (data.mcCount) {
      const grpMc = document.createElement('optgroup');
      grpMc.label = `ACC Model Coordination (${data.mcCount})`;
      for (const v of _savedViews.filter(x => x.source === 'mc')) {
        grpMc.appendChild(new Option(v.name, v.id));
      }
      sel.appendChild(grpMc);
    }
    if (data.localCount) {
      const grpLocal = document.createElement('optgroup');
      grpLocal.label = `FormaFlow Saved Views (${data.localCount})`;
      for (const v of _savedViews.filter(x => x.source === 'local')) {
        grpLocal.appendChild(new Option(v.name, v.id));
      }
      sel.appendChild(grpLocal);
    }

    el('views-count-badge').textContent =
      data.mcCount || data.localCount ? `${data.mcCount + data.localCount} saved` : '';

    const statusEl = el('views-mc-status');
    if (!data.mcSupported && data.mcReason) {
      statusEl.textContent = `${data.mcReason} — local views only`;
      statusEl.classList.remove('hidden');
    } else {
      statusEl.classList.add('hidden');
    }

    if (previous && sel.querySelector(`option[value="${previous}"]`)) sel.value = previous;
    onViewSelected();
  } catch (err) {
    toast('Failed to load views: ' + err.message, 'error');
  } finally {
    sel.disabled = false;
  }
}

function onViewSelected() {
  const id = el('sel-view').value;
  _selectedView = _savedViews.find(v => v.id === id) ?? null;
  el('btn-view-load').disabled = !_selectedView;
  const isLocal = _selectedView?.source === 'local';
  el('btn-view-delete').classList.toggle('hidden', !isLocal);
}

async function loadSelectedView() {
  if (!_selectedView) return;
  const v = _selectedView;
  const btn = el('btn-view-load');
  btn.disabled = true;
  el('viewer-status-text').textContent = `Loading view "${v.name}"…`;

  try {
    if (_viewerState.loadedModels.length) await unloadAllModels();

    // Resolve modelIds → viewerUrns. Need either coord space documents (preferred)
    // or fall back to current viewer-model-list cached entries
    const containerId = el('inp-container-id').value.trim();
    const modelSetId  = v.modelSetId || getActiveCoordSpaceId();
    let docs = [];
    if (containerId && modelSetId) {
      const resp = await api('GET',
        `/api/mc/space-documents?modelSetId=${encodeURIComponent(modelSetId)}&containerId=${encodeURIComponent(containerId)}`);
      docs = resp?.documents ?? [];
    }

    // Build a list of items to load
    const targets = [];
    for (const id of v.modelIds ?? []) {
      const doc = docs.find(d => d.id === id || d.rawUrn === id);
      if (doc?.viewerUrn) {
        targets.push({ name: doc.name, viewerUrn: doc.viewerUrn, discipline: guessDiscFromName(doc.name) });
      }
    }

    if (!targets.length) {
      toast('No matching loadable models found in this view', 'error');
      el('viewer-status-text').textContent = '';
      return;
    }

    // Load them sequentially (viewer's loadDocumentNode handles concurrency badly)
    for (const t of targets) {
      const fauxEl = document.createElement('div');
      fauxEl.dataset.urn = t.viewerUrn;
      try { await toggleViewerModel(fauxEl, t); } catch (_) {}
    }

    // Apply camera if available
    if (v.camera && _viewerState.viewer?.navigation) {
      const nav = _viewerState.viewer.navigation;
      try {
        const THREE = window.THREE ?? Autodesk?.Viewing?.Private?.THREE;
        if (THREE && v.camera.position && v.camera.target) {
          nav.setView(
            new THREE.Vector3(...v.camera.position),
            new THREE.Vector3(...v.camera.target)
          );
          if (v.camera.up) nav.setCameraUpVector(new THREE.Vector3(...v.camera.up));
        }
      } catch (_) { /* camera restore is best-effort */ }
    }

    toast(`View loaded: ${targets.length} model(s)`);
    el('viewer-status-text').textContent = `View "${v.name}" applied`;
  } catch (err) {
    toast('View load failed: ' + err.message, 'error');
  } finally {
    btn.disabled = !_selectedView;
  }
}

async function saveCurrentAsView() {
  if (!_viewerState.viewer || !_viewerState.loadedModels.length) {
    toast('Load some models first, then save the view', 'error');
    return;
  }

  const name = window.prompt('Save current view as:', `View — ${new Date().toLocaleString()}`);
  if (!name) return;

  // Capture camera
  let camera = null;
  try {
    const cam = _viewerState.viewer.navigation?.getCamera() ?? _viewerState.viewer.getCamera();
    if (cam) {
      camera = {
        position: [cam.position.x, cam.position.y, cam.position.z],
        target:   [cam.target.x,   cam.target.y,   cam.target.z],
        up:       cam.up ? [cam.up.x, cam.up.y, cam.up.z] : null,
      };
    }
  } catch (_) { /* camera capture is best-effort */ }

  // Map loaded viewer URNs back to coord-space document IDs (best-effort)
  const containerId = el('inp-container-id').value.trim();
  const modelSetId  = getActiveCoordSpaceId();
  let docs = [];
  if (containerId && modelSetId) {
    try {
      const resp = await api('GET',
        `/api/mc/space-documents?modelSetId=${encodeURIComponent(modelSetId)}&containerId=${encodeURIComponent(containerId)}`);
      docs = resp?.documents ?? [];
    } catch (_) {}
  }
  const modelIds = _viewerState.loadedModels.map(lm => {
    const matched = docs.find(d => d.viewerUrn === lm.urn);
    return matched?.id ?? lm.urn; // fallback to viewerUrn so re-load still resolves
  });

  try {
    await api('POST', '/api/views', { name, modelSetId, modelIds, camera });
    toast(`View "${name}" saved`);
    await reloadViewsList();
  } catch (err) {
    toast('Save view failed: ' + err.message, 'error');
  }
}

async function deleteSelectedView() {
  if (!_selectedView || _selectedView.source !== 'local') return;
  if (!window.confirm(`Delete saved view "${_selectedView.name}"?`)) return;
  try {
    await api('DELETE', `/api/views/${encodeURIComponent(_selectedView.id)}`);
    toast('View deleted');
    _selectedView = null;
    await reloadViewsList();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

async function loadViewerSDK() {
  if (_viewerState.sdkLoaded) return;
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';
    script.onload = () => { _viewerState.sdkLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load APS Viewer SDK'));
    document.head.appendChild(script);
  });
}

async function initViewerTab() {
  el('viewer-status-text').textContent = 'Loading viewer SDK…';
  try {
    await loadViewerSDK();
    await new Promise((resolve, reject) => {
      Autodesk.Viewing.Initializer({
        env: 'AutodeskProduction2',
        api: 'streamingV2',
        getAccessToken: async (onToken) => {
          try {
            const data = await api('GET', '/api/viewer/token');
            onToken(data.access_token, data.expires_in ?? 3600);
          } catch (e) {
            toast('Viewer auth failed: ' + e.message, 'error');
          }
        },
      }, () => {
        const container = el('viewer-container');
        el('viewer-placeholder').style.display = 'none';
        _viewerState.viewer = new Autodesk.Viewing.GuiViewer3D(container, {
          disabledExtensions: { bimwalk: true },
        });
        _viewerState.viewer.start();
        el('viewer-status-text').textContent = 'Viewer ready';
        resolve();
      });
    });
  } catch (err) {
    el('viewer-status-text').textContent = 'Viewer failed to load';
    toast('Viewer SDK error: ' + err.message, 'error');
  }
}

async function loadViewerModels() {
  const btn = el('btn-load-viewer-models');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    // Pull persisted coord assignments first so user-assigned disciplines are
    // applied to whatever the source list (folder/coord space) returns.
    const persisted = await api('GET', '/api/coordination/assignments').catch(() => null);
    if (persisted) {
      _coordState.assignments      = persisted.assignments      ?? _coordState.assignments      ?? {};
      _coordState.modelDisciplines = persisted.modelDisciplines ?? _coordState.modelDisciplines ?? {};
    }

    const sourceModels = _viewerState.source === 'space'
      ? await fetchSpaceViewerModels()
      : await fetchFolderViewerModels();

    if (!sourceModels) return; // error already toasted

    // Merge in any user-disciplined models from other folders / the coord space
    // that aren't in the current source list. They get a flag so we can label
    // them and explain why they're showing up.
    const merged = mergeDisciplinedModels(sourceModels);

    const list = el('viewer-model-list');
    list.innerHTML = '';

    if (!merged.length) {
      list.innerHTML = '<p class="text-xs text-slate-600 px-2 py-3">No viewable models found</p>';
      el('viewer-model-list-count').textContent = '0 models';
      return;
    }

    const isNwcFile = name => /\.(nwc|nwd)$/i.test(name ?? '');
    const disciplines = new Set();
    let extrasShown = 0;

    merged.forEach(m => {
      const userDisc  = getUserDiscipline(m);
      const finalDisc = userDisc || guessDiscFromName(m.name);
      m.discipline = finalDisc;
      disciplines.add(finalDisc);

      const nwcOnly = !m.viewerUrn && isNwcFile(m.name);
      const isExtra = m._fromOtherSource;
      if (isExtra) extrasShown++;

      const item = document.createElement('div');
      item.className = `viewer-model-item${nwcOnly ? ' nwc-only' : ''}${isExtra ? ' from-other' : ''}`;
      item.dataset.urn  = m.viewerUrn ?? '';
      item.dataset.name = m.name;
      item.dataset.disc = finalDisc;
      item.title = nwcOnly
        ? 'NWC file — not yet translated to SVF2; load into a Navisworks model set to enable 3D viewing'
        : (isExtra ? `Outside current ${_viewerState.source === 'space' ? 'coord space' : 'folder'} — included because a discipline is assigned` : '');

      const discBadge = userDisc
        ? `<span class="disc-badge user-set" style="background:${DISC_COLORS_HEX[finalDisc] ?? '#9ca3af'}22;color:${DISC_COLORS_HEX[finalDisc] ?? '#9ca3af'};border-color:${DISC_COLORS_HEX[finalDisc] ?? '#9ca3af'}55" title="User-assigned discipline">${finalDisc}</span>`
        : `<span class="disc-badge guessed" title="Auto-detected — set in Models or Coordination tab to lock">${finalDisc}</span>`;

      item.innerHTML = `
        <div class="disc-dot" style="background:${DISC_COLORS_HEX[finalDisc] ?? '#9ca3af'}"></div>
        <span class="model-name" title="${m.name}">${m.name}</span>
        ${discBadge}
        ${isExtra ? '<span class="extra-badge" title="From outside current source">+</span>' : ''}
        ${nwcOnly
          ? '<span class="nwc-badge">NWC</span>'
          : '<span class="model-status">▶</span>'}
      `;
      if (!nwcOnly) item.addEventListener('click', () => toggleViewerModel(item, m));
      list.appendChild(item);
    });

    const nwcCount = merged.filter(m => !m.viewerUrn && isNwcFile(m.name)).length;
    el('viewer-model-list-count').textContent =
      `${merged.length} models${extrasShown ? ` (+${extrasShown} cross-folder)` : ''}`;

    renderDiscToggles([...disciplines]);
    const msg = extrasShown
      ? `${merged.length - nwcCount} viewable + ${nwcCount} NWC + ${extrasShown} cross-folder disciplined`
      : `Found ${merged.length - nwcCount} viewable + ${nwcCount} NWC coordination model(s)`;
    toast(msg);
  } catch (err) {
    toast('Failed to list models: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = _viewerState.source === 'space' ? 'Load from Coord. Space' : 'Load from Folder';
  }
}

// Combine the source list with any model that has a user-assigned discipline
// elsewhere (Models tab cache or Coordination space). Returned items match the
// shape of the source list; cross-source ones are flagged with `_fromOtherSource`.
function mergeDisciplinedModels(sourceModels) {
  const isNwcFile = name => /\.(nwc|nwd)$/i.test(name ?? '');
  // Identity keys used for de-dup — viewerUrn first, then name fallback
  const keyOf = m => m.viewerUrn || m.name || '';
  const seen  = new Set(sourceModels.map(keyOf).filter(Boolean));
  const out   = [...sourceModels];

  // Pull from Models tab cache
  for (const m of _modelsData || []) {
    const k = keyOf(m);
    if (!k || seen.has(k)) continue;
    if (!m.viewerUrn && !isNwcFile(m.name)) continue;
    if (!getUserDiscipline(m)) continue;            // only include if user-disciplined
    seen.add(k);
    out.push({
      id:        m.id,
      name:      m.name,
      viewerUrn: m.viewerUrn,
      rawUrn:    m.rawUrn,
      _fromOtherSource: true,
    });
  }

  // Pull from coord space cache
  for (const m of _coordState.models || []) {
    const k = keyOf(m);
    if (!k || seen.has(k)) continue;
    if (!m.viewerUrn) continue;
    if (!getUserDiscipline(m)) continue;
    seen.add(k);
    out.push({
      id:        m.id,
      name:      m.name,
      viewerUrn: m.viewerUrn,
      rawUrn:    m.rawUrn,
      _fromOtherSource: true,
    });
  }

  return out;
}

async function fetchSpaceViewerModels() {
  const modelSetId = getActiveCoordSpaceId();
  const containerId = el('inp-container-id').value.trim();
  if (!modelSetId)  { toast('Pick a Coordination Space on the Connect tab first', 'error'); return null; }
  if (!containerId) { toast('Set MC Container ID on the Connect tab first', 'error'); return null; }

  const data = await api('GET',
    `/api/mc/space-documents?modelSetId=${encodeURIComponent(modelSetId)}&containerId=${encodeURIComponent(containerId)}`);
  return (data?.documents ?? []).map(d => ({
    name:       d.name,
    viewerUrn:  d.viewerUrn,
    rawUrn:     d.rawUrn,
  }));
}

async function fetchFolderViewerModels() {
  const projectId = el('inp-project-id').value.trim();
  const folderUrn = el('inp-folder-urn').value.trim();
  if (!projectId) { toast('Set Project ID on the Connect tab first', 'error'); return null; }
  if (!folderUrn) { toast('Select a Target Folder on the Connect tab first', 'error'); return null; }

  const data = await api('GET',
    `/api/project/folder-contents?projectId=${encodeURIComponent(projectId)}&folderUrn=${encodeURIComponent(folderUrn)}`);
  const isNwcFile = name => /\.(nwc|nwd)$/i.test(name ?? '');
  return (data.items ?? []).filter(i => {
    if (i.type !== 'items') return false;
    if (i.viewerUrn) return true;
    if (isNwcFile(i.name)) return true;
    return false;
  });
}

function guessDiscFromName(name = '') {
  const n = name.toUpperCase();
  // Architecture — ARCH, A_, AR_, ARCHITECTURAL, INTERIOR, INT
  if (/\bARCH\b|_A_|_AR_|ARCHITECTURAL|INTERIOR/.test(n)) return 'ARCH';
  if (/\bINT\b|_INT_|INT[-_]/.test(n))                    return 'INT';
  // Structure — STRUCT, S_, STR_, STRUCTURAL, FOUNDATION, CONCRETE, STEEL
  if (/\bSTRUCT\b|_S_|_STR_|STRUCTURAL|FOUNDATION|CONCRETE|STEEL[-_]/.test(n)) return 'STRUCT';
  // Mechanical / HVAC — MECH, M_, HVAC, DUCT, MECHANICAL, PIPING (non-plumbing)
  if (/\bMECH\b|_M_|HVAC|DUCT|MECHANICAL|CHILLED[-_ ]?WATER|AIR[-_ ]?HAND/.test(n)) return 'MECH';
  // Plumbing — PLUMB, P_, PLMB, SANIT, SANITARY, DOMESTIC
  if (/\bPLUMB\b|_P_|PLMB|SANIT|SANITARY|DOMESTIC[-_ ]?WATER/.test(n)) return 'PLUMB';
  // Electrical — ELEC, E_, ELE_, ELECTRICAL, POWER, LIGHTING, LOW[-_]VOLTAGE
  if (/\bELEC\b|_E_|ELE[-_]|ELECTRICAL|POWER|LIGHTING|LOW[-_]VOLTAGE/.test(n)) return 'ELEC';
  // Fire Protection — FIRE, FP_, SPRINK, SUPPRESSION
  if (/\bFP\b|FP[-_]|FIRE[-_ ]?PROTECTION|SPRINK|SUPPRESSION/.test(n)) return 'FP';
  // Civil / Site — CIVIL, SITE, GRADING, SURVEY, TOPO, INFRASTRUCTURE
  if (/\bCIVIL\b|SITE[-_]|GRADING|SURVEY|TOPO|INFRASTRUCTURE/.test(n)) return 'CIVIL';
  return 'UNKNOWN';
}

async function toggleViewerModel(itemEl, modelDef) {
  if (!_viewerState.viewer) {
    toast('Viewer not initialized — open the 3D Viewer tab first', 'error');
    return;
  }

  const existing = _viewerState.loadedModels.find(m => m.urn === modelDef.viewerUrn);
  if (existing) {
    _viewerState.viewer.unloadModel(existing.model);
    _viewerState.loadedModels = _viewerState.loadedModels.filter(m => m.urn !== modelDef.viewerUrn);
    itemEl.classList.remove('loaded');
    const statusEl = itemEl.querySelector('.model-status');
    if (statusEl) statusEl.textContent = '▶';
    updateViewerModelCounter();
    el('btn-unload-all-models').classList.toggle('hidden', _viewerState.loadedModels.length === 0);
    renderRecentModels();
    return;
  }

  itemEl.classList.add('loading');
  itemEl.querySelector('.model-status').textContent = '⋯';
  el('viewer-status-text').textContent = `Loading ${modelDef.name}…`;

  try {
    await new Promise((resolve, reject) => {
      Autodesk.Viewing.Document.load(
        `urn:${modelDef.viewerUrn}`,
        async (doc) => {
          const geometry = doc.getRoot().getDefaultGeometry();
          const model = await _viewerState.viewer.loadDocumentNode(doc, geometry, {
            keepCurrentModels: true,
            loadAsHidden: false,
          });
          const finalDisc = getUserDiscipline(modelDef) || modelDef.discipline || guessDiscFromName(modelDef.name);
          _viewerState.loadedModels.push({ urn: modelDef.viewerUrn, name: modelDef.name,
            discipline: finalDisc, model });
          itemEl.classList.remove('loading'); itemEl.classList.add('loaded');
          const statusEl = itemEl.querySelector('.model-status');
          if (statusEl) statusEl.textContent = '✓';
          el('viewer-status-text').textContent = `${modelDef.name} loaded`;
          updateViewerModelCounter();
          el('btn-unload-all-models').classList.remove('hidden');
          saveRecentModel(modelDef);
          // Apply any saved manual alignment for this model
          const matchedItem = _coordState.models.find(cm => cm.viewerUrn === modelDef.viewerUrn);
          if (matchedItem?.id) maybeApplyAlignmentToViewer(matchedItem.id);
          resolve();
        },
        (code, msg) => reject(new Error(`Viewer load error ${code}: ${msg}`))
      );
    });
  } catch (err) {
    itemEl.classList.remove('loading'); itemEl.classList.add('error');
    const statusEl = itemEl.querySelector('.model-status');
    if (statusEl) statusEl.textContent = '✗';
    toast('Load failed: ' + err.message, 'error');
  }
}

function updateViewerModelCounter() {
  const n = _viewerState.loadedModels.length;
  el('viewer-model-count').textContent = n;
  el('viewer-model-counter').classList.toggle('hidden', n === 0);

  // Aggregate disciplines across loaded models, count per disc, render chips
  const counts = {};
  for (const lm of _viewerState.loadedModels) {
    const d = lm.discipline || 'UNKNOWN';
    counts[d] = (counts[d] || 0) + 1;
  }
  const chips = el('viewer-loaded-disc-chips');
  if (chips) {
    chips.innerHTML = Object.entries(counts).map(([d, c]) => {
      const color = DISC_COLORS_HEX[d] ?? '#9ca3af';
      return `<span class="loaded-disc-chip" style="background:${color}22;color:${color};border-color:${color}55" title="${c} ${d} model(s) loaded">${d}${c > 1 ? `·${c}` : ''}</span>`;
    }).join('');
  }
}

function renderDiscToggles(disciplines) {
  const container = el('viewer-disc-toggles');
  container.innerHTML = '';
  disciplines.forEach(disc => {
    const color = DISC_COLORS_HEX[disc] ?? '#9ca3af';
    const row = document.createElement('div');
    row.className = 'disc-toggle-row';
    row.innerHTML = `
      <div class="disc-swatch" style="background:${color}"></div>
      <span class="flex-1">${disc}</span>
      <input type="checkbox" checked class="accent-blue-500" data-disc="${disc}"/>
    `;
    row.querySelector('input').addEventListener('change', (e) => {
      toggleDisciplineVisibility(disc, e.target.checked);
    });
    container.appendChild(row);
  });
}

function toggleDisciplineVisibility(disc, visible) {
  if (!_viewerState.viewer) return;
  _viewerState.loadedModels
    .filter(m => m.discipline === disc)
    .forEach(m => {
      if (visible) _viewerState.viewer.showModel(m.model, false);
      else         _viewerState.viewer.hideModel(m.model);
    });
}

async function loadClashResultsForViewer() {
  try {
    const data = await api('GET', '/api/clash/results');
    const groups = data?.groups ?? data?.clashGroups ?? [];
    if (!groups.length) { toast('No clash results found — run the workflow first', 'error'); return; }
    _viewerState.clashGroups = groups;
    renderClashGroups(groups);
    toast(`Loaded ${groups.length} clash group(s)`);
  } catch (err) {
    toast('Failed to load clash results: ' + err.message, 'error');
  }
}

function renderClashGroups(groups) {
  const list = el('viewer-clash-list');
  const filter = (el('inp-clash-filter').value ?? '').toLowerCase();
  const filtered = filter ? groups.filter(g => g.name?.toLowerCase().includes(filter)) : groups;

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<div class="p-4 text-xs text-slate-600 text-center">No groups match the filter</div>';
    return;
  }

  // Build discipline summary chips
  const discCounts = {};
  filtered.forEach(g => {
    const d = g.disciplines?.[0] ?? 'UNKNOWN';
    discCounts[d] = (discCounts[d] ?? 0) + (g.clashes?.length ?? g.count ?? 0);
  });
  const chips = el('clash-disc-chips');
  chips.innerHTML = Object.entries(discCounts).map(([d, n]) =>
    `<span class="clash-disc-chip" style="background:${DISC_COLORS_HEX[d] ?? '#9ca3af'}" data-disc="${d}">${d} ${n}</span>`
  ).join('');
  chips.classList.remove('hidden');

  let totalClashes = 0;
  filtered.forEach(g => {
    const count = g.clashes?.length ?? g.count ?? 0;
    totalClashes += count;
    const div = document.createElement('div');
    div.className = 'clash-group-item';
    div.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="cg-name" title="${g.name ?? ''}">${g.name ?? 'Unnamed Group'}</span>
        <span class="cg-count">${count}</span>
      </div>
      <div class="cg-meta">
        <span>${g.level ?? ''}</span>
        <span>${g.testName ?? ''}</span>
      </div>
    `;
    div.addEventListener('click', () => selectClashGroup(div, g));
    list.appendChild(div);
  });

  el('footer-group-count').textContent = `${filtered.length} groups`;
  el('footer-clash-count').textContent = `${totalClashes} clashes`;
  el('clash-results-footer').classList.remove('hidden');
}

function selectClashGroup(itemEl, group) {
  document.querySelectorAll('.clash-group-item').forEach(el => el.classList.remove('active'));
  itemEl.classList.add('active');
  _viewerState.activeGroup = group;
  showClashMarkersForGroup(group);
}

function showClashMarkersForGroup(group) {
  if (!_viewerState.viewer) return;
  const THREE = Autodesk.Viewing.Private.THREE;
  const SCENE = 'clash-markers';

  if (_viewerState.viewer.overlays.hasScene(SCENE)) {
    _viewerState.viewer.overlays.clearScene(SCENE);
  } else {
    _viewerState.viewer.overlays.addScene(SCENE);
  }

  const clashes = group.clashes ?? [];
  let hasPoints = false;
  const positions = [];

  clashes.forEach(clash => {
    if (!clash.point) return;
    hasPoints = true;
    positions.push(new THREE.Vector3(clash.point.x, clash.point.y, clash.point.z));
    const geo = new THREE.SphereGeometry(0.2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.85 });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(clash.point.x, clash.point.y, clash.point.z);
    _viewerState.viewer.overlays.addMesh(sphere, SCENE);
  });

  if (hasPoints && positions.length) {
    // Fly camera to the bounding box of this clash group
    const box = new THREE.Box3().setFromPoints(positions);
    _viewerState.viewer.navigation.fitBounds(false, box, true);
  }
  toast(`Showing ${clashes.length} clash(es) for: ${group.name ?? 'group'}`);
}

function clearClashMarkers() {
  if (!_viewerState.viewer) return;
  if (_viewerState.viewer.overlays.hasScene('clash-markers')) {
    _viewerState.viewer.overlays.clearScene('clash-markers');
  }
}

function showAllClashMarkers() {
  if (!_viewerState.clashGroups.length) { toast('Load clash results first', 'error'); return; }
  _viewerState.clashGroups.forEach(g => showClashMarkersForGroup(g));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub — multi-project manager
// ─────────────────────────────────────────────────────────────────────────────

let _hubProjects = [];
let _hubFilter = 'all';
let _hubSort   = 'name';

async function loadHubProjects() {
  const btn = el('btn-load-hub-projects');
  const errorEl = el('hub-error');
  btn.disabled = true; btn.textContent = 'Loading…';
  errorEl.classList.add('hidden');

  // Skeleton placeholders while loading
  const grid = el('hub-project-grid');
  grid.innerHTML = Array(6).fill('').map(() => `
    <div class="hub-project-card animate-pulse">
      <div class="h-4 bg-slate-200 rounded w-3/4 mb-3"></div>
      <div class="h-3 bg-slate-100 rounded w-1/2 mb-2"></div>
      <div class="h-3 bg-slate-100 rounded w-2/3 mb-3"></div>
      <div class="h-7 bg-slate-100 rounded w-24"></div>
    </div>
  `).join('');

  try {
    const data = await api('GET', '/api/hub/projects');
    _hubProjects = data?.data ?? [];
    renderHubProjects(_hubProjects);

    const accCount   = _hubProjects.filter(p => (p.attributes?.projectType ?? '').toUpperCase().includes('ACC')).length;
    const otherCount = _hubProjects.length - accCount;
    el('hub-stat-total').textContent = _hubProjects.length;
    el('hub-stat-acc').textContent   = accCount;
    el('hub-stat-other').textContent = otherCount;

    const currentProjId = el('inp-project-id').value.trim();
    const current = _hubProjects.find(p => p.id?.replace(/^b\./, '') === currentProjId);
    el('hub-stat-active').textContent = current?.attributes?.name ?? 'None';

    toast(`Loaded ${_hubProjects.length} project(s)`);
  } catch (err) {
    grid.innerHTML = '';
    errorEl.classList.remove('hidden');
    el('hub-error-msg').textContent = `Failed to load hub projects: ${err.message}`;
    el('hub-error-hint').textContent = err.status === 403
      ? 'Tip: Your APS app may not be authorized for this ACC hub. An ACC Account Admin needs to add your Client ID under Account Admin → Settings → Custom Integrations.'
      : err.status === 401
      ? 'Tip: Verify APS Client ID/Secret on the Connect tab and click Test Connection.'
      : '';
    toast('Failed to load hub projects', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Load Projects';
  }
}

function renderHubProjects(projects) {
  const grid = el('hub-project-grid');
  const filter   = (el('inp-hub-search')?.value ?? '').toLowerCase();
  const currentProjId = el('inp-project-id').value.trim();

  // Apply filter pill
  let filtered = projects.filter(p => {
    if (_hubFilter === 'acc') return (p.attributes?.projectType ?? '').toUpperCase().includes('ACC');
    if (_hubFilter === 'bim360') return (p.attributes?.projectType ?? '').toLowerCase().includes('bim');
    if (_hubFilter === 'active') return p.id?.replace(/^b\./, '') === currentProjId;
    return true;
  });

  if (filter) {
    filtered = filtered.filter(p =>
      (p.attributes?.name ?? '').toLowerCase().includes(filter) ||
      (p.id ?? '').toLowerCase().includes(filter)
    );
  }

  // Sort
  const sortFn = {
    'name':       (a, b) => (a.attributes?.name ?? '').localeCompare(b.attributes?.name ?? ''),
    'name-desc':  (a, b) => (b.attributes?.name ?? '').localeCompare(a.attributes?.name ?? ''),
    'updated':    (a, b) => (b.attributes?.updatedAt ?? '').localeCompare(a.attributes?.updatedAt ?? ''),
    'type':       (a, b) => (a.attributes?.projectType ?? '').localeCompare(b.attributes?.projectType ?? ''),
  }[_hubSort] ?? ((a, b) => 0);
  filtered = [...filtered].sort(sortFn);

  if (!filtered.length) {
    grid.innerHTML = '<div class="col-span-3 text-center text-slate-400 py-12">No projects match the current filter</div>';
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const rawId      = p.id?.replace(/^b\./, '') ?? '';
    const isActive   = rawId === currentProjId;
    const name       = p.attributes?.name ?? 'Unnamed Project';
    const type       = p.attributes?.projectType ?? 'ACC';
    const status     = p.attributes?.status ?? 'active';
    const updatedAt  = p.attributes?.updatedAt ?? p.attributes?.createdAt ?? null;
    const updatedStr = updatedAt ? formatRelativeDate(updatedAt) : '';
    const safeName = name.replace(/'/g, '\\\'').replace(/"/g, '&quot;');
    return `
      <div class="hub-project-card ${isActive ? 'active-project' : ''}" data-project-id="${rawId}">
        <div class="hpc-name" title="${name}">${name}</div>
        <div class="hpc-type">
          <span class="hpc-type-badge">${type}</span>
          <span class="text-slate-400">·</span>
          <span class="${status === 'active' ? 'text-emerald-600' : 'text-slate-400'}">${status}</span>
          ${updatedStr ? `<span class="text-slate-400">·</span><span class="text-xs text-slate-500">${updatedStr}</span>` : ''}
        </div>
        <div class="hpc-id">${rawId}</div>
        <div class="hpc-actions">
          <button class="btn-primary text-xs py-1 px-3 ${isActive ? 'opacity-50 cursor-default' : ''}"
            onclick="switchHubProject('${rawId}', '${safeName}')"
            ${isActive ? 'disabled' : ''}>
            ${isActive ? '✓ Active' : 'Use This Project'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function formatRelativeDate(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days < 1)   return 'today';
    if (days < 30)  return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  } catch { return ''; }
}

function switchHubProject(projectId, projectName) {
  el('inp-project-id').value = projectId;
  // Reset container + folder since they're project-specific
  el('inp-container-id').value = '';
  el('inp-folder-urn').value   = '';
  el('folder-urn-row').classList.add('hidden');
  // Reset the folder tree
  const folderTree = el('folder-tree');
  if (folderTree) folderTree.innerHTML = '';
  el('folder-tree-container')?.classList.add('hidden');
  const nameSpan = el('selected-folder-name');
  if (nameSpan) { nameSpan.textContent = 'No folder selected'; nameSpan.className = 'text-sm text-slate-500 flex-1 truncate'; }
  el('hub-stat-active').textContent = projectName;

  // Re-render cards to update active state
  renderHubProjects(_hubProjects);

  navigate('connect');
  toast(`Switched to "${projectName}" — save credentials to persist`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Models tab
// ─────────────────────────────────────────────────────────────────────────────

let _modelsData = [];      // cached for disc-filter re-renders
let _modelsDiscFilter = 'ALL';

async function loadModels() {
  const projectId = el('inp-project-id').value.trim();
  const folderUrn = el('inp-folder-urn').value.trim();
  if (!projectId) { toast('Set Project ID on the Connect tab first', 'error'); return; }
  if (!folderUrn) { toast('Select a Target Folder on the Connect tab first', 'error'); return; }

  const btn = el('btn-load-models');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  el('models-count-label').textContent = 'Scanning subfolders…';
  el('models-empty').classList.add('hidden');
  el('models-list').classList.add('hidden');
  el('models-disc-filter').classList.add('hidden');

  try {
    // Pull coordination assignments alongside the folder scan so any persisted
    // discipline overrides win over the auto-guess.
    const [data, persisted] = await Promise.all([
      api('GET', `/api/project/folder-contents-recursive?projectId=${encodeURIComponent(projectId)}&folderUrn=${encodeURIComponent(folderUrn)}`),
      api('GET', '/api/coordination/assignments').catch(() => ({})),
    ]);
    if (persisted) {
      _coordState.modelDisciplines = persisted.modelDisciplines ?? _coordState.modelDisciplines ?? {};
      _coordState.assignments      = persisted.assignments      ?? _coordState.assignments      ?? {};
    }
    _modelsData = (data.items ?? []).map(m => {
      const guessed = guessDiscFromName(m.name);
      const override = getUserDiscipline({ ...m, name: m.name });
      return { ...m, discipline: override || m.discipline || guessed };
    });

    if (!_modelsData.length) {
      el('models-empty').classList.remove('hidden');
      el('models-count-label').textContent = 'No models found';
      return;
    }

    _modelsDiscFilter = 'ALL';
    document.querySelectorAll('#models-disc-filter .disc-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.disc === 'ALL');
    });
    el('models-disc-filter').classList.remove('hidden');
    renderModels();
    el('models-count-label').textContent = `${_modelsData.length} model(s)`;
    toast(`Found ${_modelsData.length} model(s) across all subfolders`);
  } catch (err) {
    el('models-empty').classList.remove('hidden');
    el('models-count-label').textContent = '';
    toast('Failed to load models: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load Models';
  }
}

const DISC_LABEL = {
  ARCH: 'Architecture', STRUCT: 'Structure', MECH: 'Mechanical',
  PLUMB: 'Plumbing', ELEC: 'Electrical', FP: 'Fire Protection',
  CIVIL: 'Civil / Site', INT: 'Interiors', UNKNOWN: 'Unknown',
};

function renderModels() {
  const list = el('models-list');
  list.innerHTML = '';

  const visible = _modelsDiscFilter === 'ALL'
    ? _modelsData
    : _modelsData.filter(m => m.discipline === _modelsDiscFilter);

  if (!visible.length) {
    list.innerHTML = `<p class="text-sm text-slate-400 py-4 text-center">No ${_modelsDiscFilter} models found</p>`;
    list.classList.remove('hidden');
    return;
  }

  // Group by folderPath
  const byFolder = new Map();
  for (const m of visible) {
    const key = m.folderPath || '(root)';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(m);
  }

  for (const [folder, models] of byFolder) {
    const group = document.createElement('div');
    group.className = 'mb-4';
    group.innerHTML = `
      <div class="flex items-center gap-2 mb-1.5 px-1">
        <svg class="w-3.5 h-3.5 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/>
        </svg>
        <span class="text-xs font-semibold text-slate-600 truncate">${folder}</span>
        <span class="text-xs text-slate-400">(${models.length})</span>
      </div>
    `;

    const rows = document.createElement('div');
    rows.className = 'space-y-1 pl-5';

    for (const m of models) {
      const isNwc = /\.(nwc|nwd)$/i.test(m.name);
      const color = DISC_COLOR[m.discipline] ?? '#9ca3af';
      const row = document.createElement('div');
      row.className = 'model-browser-row';
      row.dataset.itemId = m.id;
      row.innerHTML = `
        <div class="disc-dot flex-shrink-0" style="background:${color}" title="${DISC_LABEL[m.discipline] ?? m.discipline}"></div>
        <span class="model-br-name flex-1 truncate text-sm" title="${m.name}">${m.name}</span>
        ${isNwc ? '<span class="nwc-badge">NWC</span>' : ''}
        <select class="model-disc-select" data-item-id="${m.id}" title="Override discipline">
          ${Object.entries(DISC_LABEL).map(([k, v]) =>
            `<option value="${k}"${k === m.discipline ? ' selected' : ''}>${v}</option>`
          ).join('')}
        </select>
      `;

      row.querySelector('.model-disc-select').addEventListener('change', (e) => {
        const newDisc = e.target.value;
        const model = _modelsData.find(x => x.id === m.id);
        if (model) model.discipline = newDisc;
        row.querySelector('.disc-dot').style.background = DISC_COLOR[newDisc] ?? '#9ca3af';

        // Persist override under every key the model is known by, so the viewer
        // can match it later regardless of which lookup path it uses.
        _coordState.modelDisciplines = _coordState.modelDisciplines || {};
        for (const k of [m.id, m.viewerUrn, m.name].filter(Boolean)) {
          _coordState.modelDisciplines[k] = newDisc;
        }
        saveCoordinationDebounced();
      });

      rows.appendChild(row);
    }

    group.appendChild(rows);
    list.appendChild(group);
  }

  list.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordination tab — discipline assignment, clash includes, alignment
// ─────────────────────────────────────────────────────────────────────────────

const _coordState = {
  loaded: false,
  models: [],            // [{ id, name, viewerUrn, rawUrn, discipline }]
  assignments: {},       // { ARCH: itemId, ... }   canonical model per discipline
  clashIncludes: [],     // [itemId, ...]
  alignments: {},        // { itemId: { mode, offset:[x,y,z] } }
  alignSnap: 1.0,
  modelDisciplines: {},  // { itemId|viewerUrn|name: 'ARCH' }   per-model overrides from Models tab
};

// Best-effort key extraction so a viewer item can look up its discipline
// override regardless of whether it has an item-id, a viewer-URN, or just a name.
function modelDisciplineKey(m = {}) {
  return m.id || m.itemId || m.viewerUrn || m.urn || m.name || '';
}

function getUserDiscipline(m = {}) {
  const md = _coordState.modelDisciplines || {};
  // Try itemId, viewerUrn, then name
  for (const k of [m.id, m.itemId, m.viewerUrn, m.urn, m.name]) {
    if (k && md[k]) return md[k];
  }
  // Fallback: is this model the canonical assignment for any discipline?
  const assigns = _coordState.assignments || {};
  for (const [disc, assignedId] of Object.entries(assigns)) {
    if (!assignedId) continue;
    if (assignedId === m.id || assignedId === m.itemId) return disc;
  }
  return null;
}

const ALIGN_MODES = [
  { value: 'pbp',      label: 'Project Base Point' },
  { value: 'internal', label: 'Internal Origin' },
  { value: 'survey',   label: 'Survey Point' },
  { value: 'manual',   label: 'Manual Offset' },
];

const COORD_DISC_KEYS = ['ARCH','STRUCT','MECH','PLUMB','ELEC','FP','CIVIL','INT'];

async function loadCoordinationData() {
  el('coord-empty').classList.add('hidden');
  el('coord-sections').classList.add('hidden');

  try {
    const [persisted, modelsResp] = await Promise.all([
      api('GET', '/api/coordination/assignments').catch(() => ({})),
      fetchCoordSpaceModels(),
    ]);

    _coordState.assignments      = persisted?.assignments      ?? {};
    _coordState.clashIncludes    = persisted?.clashIncludes    ?? [];
    _coordState.alignments       = persisted?.alignments       ?? {};
    _coordState.alignSnap        = persisted?.alignSnap        ?? 1.0;
    _coordState.modelDisciplines = persisted?.modelDisciplines ?? {};
    _coordState.models           = modelsResp ?? [];

    // Apply persisted overrides on top of guesses
    for (const m of _coordState.models) {
      const ud = getUserDiscipline(m);
      if (ud) m.discipline = ud;
    }

    if (!_coordState.models.length) {
      el('coord-empty').classList.remove('hidden');
      _coordState.loaded = true;
      return;
    }

    // Auto-include any model that's assigned to a discipline if state is fresh
    if (!_coordState.clashIncludes.length && Object.keys(_coordState.assignments).length === 0) {
      _coordState.clashIncludes = _coordState.models.map(m => m.id);
    }

    el('sel-align-snap').value = String(_coordState.alignSnap);

    renderCoordinationTab();
    el('coord-sections').classList.remove('hidden');
    _coordState.loaded = true;
  } catch (err) {
    el('coord-empty').classList.remove('hidden');
    toast('Failed to load coordination data: ' + err.message, 'error');
  }
}

async function fetchCoordSpaceModels() {
  const modelSetId  = getActiveCoordSpaceId();
  const containerId = el('inp-container-id').value.trim();
  if (!modelSetId || !containerId) return [];
  const data = await api('GET',
    `/api/mc/space-documents?modelSetId=${encodeURIComponent(modelSetId)}&containerId=${encodeURIComponent(containerId)}`);
  return (data?.documents ?? []).map(d => ({
    id:         d.id,
    name:       d.name,
    rawUrn:     d.rawUrn,
    viewerUrn:  d.viewerUrn,
    discipline: guessDiscFromName(d.name),
  }));
}

function renderCoordinationTab() {
  renderCoordDisciplineRows();
  renderCoordClashRows();
  renderCoordAlignRows();
}

function renderCoordDisciplineRows() {
  const host = el('coord-disc-rows');
  host.innerHTML = '';
  for (const disc of COORD_DISC_KEYS) {
    const assignedId = _coordState.assignments[disc] ?? '';
    const candidateGuesses = _coordState.models.filter(m => m.discipline === disc);

    const row = document.createElement('div');
    row.className = 'coord-disc-row';
    row.innerHTML = `
      <div class="disc-dot flex-shrink-0" style="background:${DISC_COLOR[disc]}"></div>
      <div class="coord-disc-label">${DISC_LABEL[disc] ?? disc}</div>
      <select class="field-input text-sm flex-1 max-w-2xl" data-disc="${disc}">
        <option value="">— unassigned —</option>
        ${_coordState.models.map(m => {
          const isGuess = candidateGuesses.some(g => g.id === m.id);
          return `<option value="${m.id}"${assignedId === m.id ? ' selected' : ''}>${
            m.name}${isGuess ? '  (auto-detected)' : ''}</option>`;
        }).join('')}
      </select>
      <span class="text-xs text-slate-400 w-32 text-right">${
        candidateGuesses.length ? `${candidateGuesses.length} candidate${candidateGuesses.length === 1 ? '' : 's'}` : 'no candidates'
      }</span>
    `;
    row.querySelector('select').addEventListener('change', e => {
      const id = e.target.value;
      if (id) _coordState.assignments[disc] = id;
      else delete _coordState.assignments[disc];
      saveCoordinationDebounced();
    });
    host.appendChild(row);
  }
}

function renderCoordClashRows() {
  const host = el('coord-clash-rows');
  host.innerHTML = '';
  for (const m of _coordState.models) {
    const isIncluded = _coordState.clashIncludes.includes(m.id);
    const row = document.createElement('label');
    row.className = `coord-clash-row${isIncluded ? ' active' : ''}`;
    row.innerHTML = `
      <input type="checkbox" data-id="${m.id}" ${isIncluded ? 'checked' : ''}>
      <div class="disc-dot flex-shrink-0" style="background:${DISC_COLOR[m.discipline] ?? '#9ca3af'}"></div>
      <span class="flex-1 truncate text-sm" title="${m.name}">${m.name}</span>
      <span class="text-xs text-slate-400">${DISC_LABEL[m.discipline] ?? '—'}</span>
    `;
    row.querySelector('input').addEventListener('change', e => {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        if (!_coordState.clashIncludes.includes(id)) _coordState.clashIncludes.push(id);
        row.classList.add('active');
      } else {
        _coordState.clashIncludes = _coordState.clashIncludes.filter(x => x !== id);
        row.classList.remove('active');
      }
      saveCoordinationDebounced();
    });
    host.appendChild(row);
  }
}

function renderCoordAlignRows() {
  const host = el('coord-align-rows');
  host.innerHTML = '';
  for (const m of _coordState.models) {
    const align = _coordState.alignments[m.id] ?? { mode: 'pbp', offset: [0, 0, 0] };
    const isManual = align.mode === 'manual';
    const offset = align.offset ?? [0, 0, 0];

    const row = document.createElement('div');
    row.className = 'coord-align-row';
    row.innerHTML = `
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <div class="disc-dot flex-shrink-0" style="background:${DISC_COLOR[m.discipline] ?? '#9ca3af'}"></div>
        <span class="truncate text-sm" title="${m.name}">${m.name}</span>
      </div>
      <select class="field-input text-xs py-1 w-44" data-id="${m.id}" data-field="mode">
        ${ALIGN_MODES.map(o =>
          `<option value="${o.value}"${align.mode === o.value ? ' selected' : ''}>${o.label}</option>`
        ).join('')}
      </select>
      <div class="coord-align-manual ${isManual ? '' : 'hidden'}">
        ${['X', 'Y', 'Z'].map((axis, i) => `
          <div class="coord-align-axis">
            <span>${axis}</span>
            <button type="button" class="align-step" data-id="${m.id}" data-axis="${i}" data-dir="-1">−</button>
            <input type="number" step="0.1" class="field-input text-xs w-20 py-1 text-center"
              data-id="${m.id}" data-field="offset" data-axis="${i}" value="${offset[i] ?? 0}"/>
            <button type="button" class="align-step" data-id="${m.id}" data-axis="${i}" data-dir="1">+</button>
            <span class="text-xs text-slate-400">ft</span>
          </div>
        `).join('')}
        <button type="button" class="btn-secondary text-xs py-1 px-2" data-id="${m.id}" data-action="reset-offset">Reset</button>
        <button type="button" class="btn-secondary text-xs py-1 px-2" data-id="${m.id}" data-action="apply-viewer" title="Apply this offset to the model in the 3D viewer">Apply in Viewer</button>
      </div>
    `;

    // Mode change
    row.querySelector('select[data-field="mode"]').addEventListener('change', e => {
      const id = e.target.dataset.id;
      const mode = e.target.value;
      const existing = _coordState.alignments[id] ?? { mode, offset: [0,0,0] };
      _coordState.alignments[id] = { ...existing, mode };
      const manualEl = row.querySelector('.coord-align-manual');
      manualEl.classList.toggle('hidden', mode !== 'manual');
      saveCoordinationDebounced();
      maybeApplyAlignmentToViewer(id);
    });

    // Offset inputs
    row.querySelectorAll('input[data-field="offset"]').forEach(inp => {
      inp.addEventListener('change', e => {
        const id = e.target.dataset.id;
        const axis = parseInt(e.target.dataset.axis, 10);
        const val = parseFloat(e.target.value || '0');
        const snap = _coordState.alignSnap;
        const snapped = snap > 0 ? Math.round(val / snap) * snap : val;
        e.target.value = snapped.toFixed(snap >= 1 ? 0 : 3);
        const align = _coordState.alignments[id] ?? { mode: 'manual', offset: [0,0,0] };
        align.mode = 'manual';
        align.offset[axis] = snapped;
        _coordState.alignments[id] = align;
        saveCoordinationDebounced();
      });
    });

    // Step buttons
    row.querySelectorAll('button.align-step').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const axis = parseInt(btn.dataset.axis, 10);
        const dir  = parseInt(btn.dataset.dir, 10);
        const step = _coordState.alignSnap > 0 ? _coordState.alignSnap : 1.0;
        const align = _coordState.alignments[id] ?? { mode: 'manual', offset: [0,0,0] };
        align.mode = 'manual';
        align.offset[axis] = (align.offset[axis] ?? 0) + step * dir;
        _coordState.alignments[id] = align;
        const inp = row.querySelector(`input[data-axis="${axis}"][data-id="${id}"]`);
        if (inp) inp.value = align.offset[axis].toFixed(step >= 1 ? 0 : 3);
        saveCoordinationDebounced();
      });
    });

    // Reset / apply-viewer buttons
    row.querySelectorAll('button[data-action="reset-offset"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        _coordState.alignments[id] = { mode: 'manual', offset: [0, 0, 0] };
        renderCoordAlignRows();
        saveCoordinationDebounced();
        maybeApplyAlignmentToViewer(id);
      });
    });
    row.querySelectorAll('button[data-action="apply-viewer"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (maybeApplyAlignmentToViewer(id)) toast('Offset applied in viewer');
        else toast('Model not currently loaded in the 3D viewer', 'error');
      });
    });

    host.appendChild(row);
  }
}

let _coordSaveTimer = null;
function saveCoordinationDebounced() {
  el('coord-save-indicator').classList.remove('hidden');
  el('coord-saved-at').classList.add('hidden');
  clearTimeout(_coordSaveTimer);
  _coordSaveTimer = setTimeout(saveCoordination, 500);
}

async function saveCoordination() {
  try {
    await api('PUT', '/api/coordination/assignments', {
      modelSetId:       getActiveCoordSpaceId(),
      assignments:      _coordState.assignments,
      clashIncludes:    _coordState.clashIncludes,
      alignments:       _coordState.alignments,
      alignSnap:        _coordState.alignSnap,
      modelDisciplines: _coordState.modelDisciplines,
    });
    el('coord-save-indicator').classList.add('hidden');
    el('coord-saved-at').classList.remove('hidden');
    setTimeout(() => el('coord-saved-at').classList.add('hidden'), 1500);
  } catch (err) {
    el('coord-save-indicator').classList.add('hidden');
    toast('Save failed: ' + err.message, 'error');
  }
}

// Convert feet → model display units (assume imperial RVT publishes in feet).
// Apply offset to a currently-loaded viewer model via setPlacementTransform.
function maybeApplyAlignmentToViewer(itemId) {
  if (!_viewerState.viewer) return false;
  const model = _coordState.models.find(m => m.id === itemId);
  if (!model?.viewerUrn) return false;
  const loaded = _viewerState.loadedModels.find(lm => lm.urn === model.viewerUrn);
  if (!loaded?.model) return false;

  const align = _coordState.alignments[itemId] ?? { mode: 'pbp', offset: [0,0,0] };
  if (align.mode !== 'manual') {
    // Reset to identity for non-manual modes (PBP/Internal/Survey are model-side concerns
    // that the viewer can't shift independently — see PR description for details).
    if (typeof loaded.model.setPlacementTransform === 'function') {
      const THREE = window.THREE ?? Autodesk?.Viewing?.Private?.THREE;
      if (THREE) loaded.model.setPlacementTransform(new THREE.Matrix4());
    }
    return true;
  }
  const [x, y, z] = align.offset;
  const THREE = window.THREE ?? Autodesk?.Viewing?.Private?.THREE;
  if (!THREE) return false;
  const m = new THREE.Matrix4().makeTranslation(x, y, z);
  if (typeof loaded.model.setPlacementTransform === 'function') {
    loaded.model.setPlacementTransform(m);
    _viewerState.viewer.impl.invalidate(true, true, true);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordination tab — MC Live Data (Search Sets, Clash Tests, Workflow Results)
// ─────────────────────────────────────────────────────────────────────────────

const _mcState = {
  searchSets:    null,   // raw data from /api/mc/search-sets
  clashTests:    null,   // { versionIndex, tests: [] }
  clashGroups:   {},     // { [testId]: data }  cached per test
  loadingGroups: new Set(),
  clashResults:  null,   // last workflow run
};

// ── Search Sets ──────────────────────────────────────────────────────────────

async function loadMcSearchSets() {
  const modelSetId = getActiveCoordSpaceId();
  if (!modelSetId) { toast('Select a Coordination Space first', 'error'); return; }

  const listEl = el('mc-ss-list');
  const countEl = el('mc-ss-count');
  listEl.innerHTML = '<div class="mc-loading">Loading…</div>';
  countEl.classList.add('hidden');

  try {
    const data = await api('GET', `/api/mc/search-sets?modelSetId=${encodeURIComponent(modelSetId)}`);
    _mcState.searchSets = data;
    renderMcSearchSets();
  } catch (err) {
    listEl.innerHTML = `<p class="mc-error">${escapeHtml(err.message)}</p>`;
  }
}

function renderMcSearchSets() {
  const listEl  = el('mc-ss-list');
  const countEl = el('mc-ss-count');
  const data    = _mcState.searchSets;
  const sets    = data?.searchSets ?? data?.data ?? (Array.isArray(data) ? data : []);

  if (!sets.length) {
    listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">No search sets found in this coordination space.</p>';
    countEl.classList.add('hidden');
    return;
  }

  countEl.textContent = `${sets.length} set${sets.length !== 1 ? 's' : ''}`;
  countEl.classList.remove('hidden');

  listEl.innerHTML = sets.map(s => `
    <div class="mc-row">
      <div class="mc-row-main">
        <span class="mc-row-name">${escapeHtml(s.name ?? s.id ?? 'Unnamed')}</span>
        ${s.modelName ? `<span class="mc-row-sub">${escapeHtml(s.modelName)}</span>` : ''}
      </div>
      <div class="mc-row-meta">
        ${s.isDirty ? '<span class="mc-badge mc-badge-warn">Dirty</span>' : ''}
        ${s.hasElements !== undefined ? `<span class="mc-badge">${s.hasElements ? 'Active' : 'Empty'}</span>` : ''}
        ${s.lastModifiedTime ? `<span class="text-xs text-slate-400">${formatRelativeDate(s.lastModifiedTime)}</span>` : ''}
      </div>
    </div>`).join('');
}

// ── Clash Tests ───────────────────────────────────────────────────────────────

async function loadMcClashTests() {
  const modelSetId = getActiveCoordSpaceId();
  if (!modelSetId) { toast('Select a Coordination Space first', 'error'); return; }

  const listEl    = el('mc-ct-list');
  const versionEl = el('mc-ct-version');
  const countEl   = el('mc-ct-count');
  listEl.innerHTML = '<div class="mc-loading">Loading…</div>';
  versionEl.classList.add('hidden');
  countEl.classList.add('hidden');

  try {
    const data = await api('GET', `/api/mc/clash-tests?modelSetId=${encodeURIComponent(modelSetId)}`);
    _mcState.clashTests = data;
    renderMcClashTests();
  } catch (err) {
    listEl.innerHTML = `<p class="mc-error">${escapeHtml(err.message)}</p>`;
  }
}

function renderMcClashTests() {
  const listEl    = el('mc-ct-list');
  const versionEl = el('mc-ct-version');
  const countEl   = el('mc-ct-count');
  const data      = _mcState.clashTests;
  const tests     = data?.tests ?? (Array.isArray(data) ? data : []);
  const vi        = data?.versionIndex;

  if (vi !== null && vi !== undefined) {
    versionEl.textContent = `v${vi}`;
    versionEl.classList.remove('hidden');
  }

  if (!tests.length) {
    listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">No clash tests found.</p>';
    countEl.classList.add('hidden');
    return;
  }

  countEl.textContent = `${tests.length} test${tests.length !== 1 ? 's' : ''}`;
  countEl.classList.remove('hidden');

  listEl.innerHTML = tests.map(t => {
    const testId  = t.id ?? t.testId;
    const status  = t.status ?? t.status ?? '';
    const total   = t.clashCount ?? t.totalClashes ?? t.clashesTotal ?? '';
    const new_    = t.newClashCount ?? t.newClashes ?? '';
    const active  = t.activeClashCount ?? t.activeClashes ?? '';
    return `
    <div class="mc-test-row" id="mc-test-${escapeHtml(testId)}">
      <div class="mc-test-header" data-testid="${escapeHtml(testId)}" data-vi="${vi ?? ''}">
        <span class="mc-expand-icon">▶</span>
        <div class="mc-row-main">
          <span class="mc-row-name">${escapeHtml(t.name ?? testId)}</span>
          ${t.description ? `<span class="mc-row-sub">${escapeHtml(t.description)}</span>` : ''}
        </div>
        <div class="mc-row-meta">
          ${status ? `<span class="mc-badge mc-status-${escapeHtml(status.toLowerCase())}">${escapeHtml(status)}</span>` : ''}
          ${total !== '' ? `<span class="mc-badge mc-badge-clash" title="Total clashes">${total} clashes</span>` : ''}
          ${new_ !== '' ? `<span class="mc-badge mc-badge-new" title="New clashes">${new_} new</span>` : ''}
        </div>
      </div>
      <div class="mc-groups-panel hidden" id="mc-groups-${escapeHtml(testId)}">
        <div class="mc-groups-inner"><p class="text-slate-400 text-sm py-2 px-2">Loading groups…</p></div>
      </div>
    </div>`;
  }).join('');

  // Attach click handlers for expand/collapse
  listEl.querySelectorAll('.mc-test-header').forEach(hdr => {
    hdr.addEventListener('click', () => toggleClashTestGroups(hdr.dataset.testid, hdr.dataset.vi));
  });
}

async function toggleClashTestGroups(testId, versionIndex) {
  const rowEl    = el(`mc-test-${testId}`);
  const panelEl  = el(`mc-groups-${testId}`);
  const expandEl = rowEl?.querySelector('.mc-expand-icon');
  if (!rowEl || !panelEl) return;

  const isOpen = !panelEl.classList.contains('hidden');
  if (isOpen) {
    panelEl.classList.add('hidden');
    if (expandEl) expandEl.textContent = '▶';
    return;
  }

  // Open
  panelEl.classList.remove('hidden');
  if (expandEl) expandEl.textContent = '▼';

  // Already cached?
  if (_mcState.clashGroups[testId]) {
    renderMcClashGroups(testId, _mcState.clashGroups[testId], panelEl.querySelector('.mc-groups-inner'));
    return;
  }
  if (_mcState.loadingGroups.has(testId)) return;

  _mcState.loadingGroups.add(testId);
  const modelSetId = getActiveCoordSpaceId();
  try {
    const data = await api('GET',
      `/api/mc/clash-groups?modelSetId=${encodeURIComponent(modelSetId)}&versionIndex=${encodeURIComponent(versionIndex)}&testId=${encodeURIComponent(testId)}`
    );
    _mcState.clashGroups[testId] = data;
    renderMcClashGroups(testId, data, panelEl.querySelector('.mc-groups-inner'));
  } catch (err) {
    if (panelEl.querySelector('.mc-groups-inner')) {
      panelEl.querySelector('.mc-groups-inner').innerHTML = `<p class="mc-error">${escapeHtml(err.message)}</p>`;
    }
  } finally {
    _mcState.loadingGroups.delete(testId);
  }
}

function renderMcClashGroups(testId, data, container) {
  if (!container) return;
  const groups = data?.clashGroups ?? data?.data ?? data?.groups ?? (Array.isArray(data) ? data : []);

  if (!groups.length) {
    container.innerHTML = '<p class="text-slate-400 text-sm py-2 px-2">No clash groups found for this test.</p>';
    return;
  }

  const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e', none: '#94a3b8' };

  container.innerHTML = `
    <div class="mc-groups-table-header">
      <span>Group</span><span>Severity</span><span>Clashes</span><span>Status</span>
    </div>
    ${groups.slice(0, 100).map(g => {
      const sev   = (g.severity ?? g.clashSeverity ?? 'none').toLowerCase();
      const count = g.clashCount ?? g.count ?? '';
      const name  = g.name ?? g.groupName ?? g.id ?? 'Group';
      const stat  = g.status ?? g.groupStatus ?? '';
      return `<div class="mc-group-row">
        <span class="mc-group-name">${escapeHtml(name)}</span>
        <span class="mc-badge" style="background:${SEV_COLOR[sev] ?? SEV_COLOR.none}22;color:${SEV_COLOR[sev] ?? SEV_COLOR.none};border-color:${SEV_COLOR[sev] ?? SEV_COLOR.none}44">${escapeHtml(sev)}</span>
        <span class="text-xs text-slate-600">${count !== '' ? count : '—'}</span>
        <span class="text-xs text-slate-500">${escapeHtml(stat)}</span>
      </div>`;
    }).join('')}
    ${groups.length > 100 ? `<p class="text-xs text-slate-400 px-2 py-1">… and ${groups.length - 100} more</p>` : ''}
  `;
}

// ── Workflow Clash Results ────────────────────────────────────────────────────

async function loadWorkflowClashResults() {
  const listEl    = el('clash-results-list');
  const summEl    = el('clash-results-summary');
  const metaEl    = el('wf-results-meta');
  listEl.innerHTML = '<div class="mc-loading">Loading…</div>';
  summEl.classList.add('hidden');
  metaEl.classList.add('hidden');

  try {
    const data = await api('GET', '/api/clash/results');
    _mcState.clashResults = data;
    renderWorkflowClashResults();
  } catch (err) {
    listEl.innerHTML = `<p class="mc-error">${escapeHtml(err.message)}</p>`;
  }
}

function renderWorkflowClashResults() {
  const listEl = el('clash-results-list');
  const summEl = el('clash-results-summary');
  const metaEl = el('wf-results-meta');
  const data   = _mcState.clashResults;

  if (!data || (!data.groups?.length && !data.summary)) {
    listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">No workflow results found. Run the workflow to generate clash data.</p>';
    summEl.classList.add('hidden');
    return;
  }

  const summary = data.summary ?? {};
  const groups  = data.groups ?? data.clashGroups ?? [];

  // Summary cards
  const statCards = [
    { label: 'Total Clashes', value: summary.totalClashes ?? groups.reduce((n, g) => n + (g.clashCount ?? 0), 0), color: 'text-slate-700' },
    { label: 'Groups',        value: groups.length,                                                                  color: 'text-blue-600' },
    { label: 'Critical',      value: groups.filter(g => (g.severity ?? '').toLowerCase() === 'critical').length,     color: 'text-red-600'  },
    { label: 'High',          value: groups.filter(g => (g.severity ?? '').toLowerCase() === 'high').length,         color: 'text-orange-500' },
  ];
  summEl.innerHTML = statCards.map(c => `
    <div class="mc-stat-card">
      <p class="mc-stat-value ${c.color}">${c.value}</p>
      <p class="mc-stat-label">${c.label}</p>
    </div>`).join('');
  summEl.classList.remove('hidden');

  if (summary.runAt || summary.generatedAt) {
    metaEl.textContent = `Run: ${formatRelativeDate(summary.runAt ?? summary.generatedAt)}`;
    metaEl.classList.remove('hidden');
  }

  // Group list
  if (!groups.length) {
    listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">No clash groups in results file.</p>';
    return;
  }

  const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e', none: '#94a3b8' };

  listEl.innerHTML = `
    <div class="mc-groups-table-header mt-2">
      <span>Group / Test</span><span>Severity</span><span>Clashes</span><span>Disciplines</span>
    </div>
    ${groups.slice(0, 200).map(g => {
      const sev  = (g.severity ?? 'none').toLowerCase();
      const cnt  = g.clashCount ?? g.count ?? g.clashes?.length ?? '';
      const disc = [g.disciplineA, g.disciplineB].filter(Boolean).join(' × ') || (g.disciplines ?? []).join(' × ') || '';
      return `<div class="mc-group-row">
        <div>
          <span class="mc-group-name">${escapeHtml(g.name ?? g.testName ?? g.id ?? 'Group')}</span>
          ${g.testName ? `<span class="mc-row-sub">${escapeHtml(g.testName)}</span>` : ''}
        </div>
        <span class="mc-badge" style="background:${SEV_COLOR[sev] ?? SEV_COLOR.none}22;color:${SEV_COLOR[sev] ?? SEV_COLOR.none};border-color:${SEV_COLOR[sev] ?? SEV_COLOR.none}44">${escapeHtml(sev)}</span>
        <span class="text-xs text-slate-600">${cnt !== '' ? cnt : '—'}</span>
        <span class="text-xs text-slate-500">${escapeHtml(disc)}</span>
      </div>`;
    }).join('')}
    ${groups.length > 200 ? `<p class="text-xs text-slate-400 px-2 py-1">… and ${groups.length - 200} more groups</p>` : ''}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issues tab — ACC Construction Issues v1
// ─────────────────────────────────────────────────────────────────────────────

const _issuesState = {
  loaded: false,
  issues: [],
  types: [],
  selectedId: null,
  filterStatus: 'open',
  filterText: '',
};

const ISSUE_STATUS_COLOR = {
  draft:    '#94a3b8',
  open:     '#3b82f6',
  answered: '#a855f7',
  closed:   '#10b981',
  void:     '#64748b',
};

async function loadIssues() {
  const projectId = el('inp-project-id').value.trim();
  if (!projectId) { toast('Set Project ID on the Connect tab first', 'error'); return; }

  const list = el('issues-list');
  el('issues-error').classList.add('hidden');
  list.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Loading…</div>';

  try {
    const qs = new URLSearchParams({ projectId });
    if (_issuesState.filterStatus) qs.set('status', _issuesState.filterStatus);
    const data = await api('GET', `/api/issues?${qs}`);
    _issuesState.issues = data?.results ?? data?.data ?? data ?? [];

    // Load types lazily (silent if it fails)
    if (!_issuesState.types.length) {
      try {
        const tdata = await api('GET', `/api/issues/types?projectId=${encodeURIComponent(projectId)}`);
        _issuesState.types = tdata?.results ?? tdata?.data ?? [];
      } catch (_) {}
    }

    _issuesState.loaded = true;
    renderIssuesList();
    el('badge-issues').textContent = _issuesState.issues.length;
    el('badge-issues').classList.toggle('hidden', !_issuesState.issues.length);
  } catch (err) {
    list.innerHTML = '';
    const errBox = el('issues-error');
    errBox.classList.remove('hidden');
    el('issues-error-msg').textContent  = `Failed to load issues: ${err.message}`;
    el('issues-error-hint').textContent = err.status === 403
      ? 'Tip: APS app may not be authorized — add as Custom Integration in ACC Account Admin.'
      : err.status === 404
      ? 'Tip: Construction Issues service may not be enabled for this project.'
      : err.status === 401
      ? 'Tip: Verify APS Client ID/Secret on the Connect tab.'
      : '';
  }
}

function renderIssuesList() {
  const list = el('issues-list');
  let filtered = _issuesState.issues;
  if (_issuesState.filterText) {
    const q = _issuesState.filterText.toLowerCase();
    filtered = filtered.filter(i =>
      (i.title ?? '').toLowerCase().includes(q) ||
      (i.description ?? '').toLowerCase().includes(q) ||
      (i.identifier ?? '').toLowerCase().includes(q)
    );
  }

  el('issues-count').textContent = `${filtered.length}${filtered.length !== _issuesState.issues.length ? ` of ${_issuesState.issues.length}` : ''}`;

  if (!filtered.length) {
    list.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">No issues match the current filter</div>';
    return;
  }

  list.innerHTML = '';
  for (const i of filtered) {
    const status = (i.status ?? 'open').toLowerCase();
    const ident  = i.identifier ?? `#${i.id?.slice(0, 6) ?? ''}`;
    const title  = i.title ?? '(untitled)';
    const due    = i.due_date ?? null;
    const isSelected = i.id === _issuesState.selectedId;

    const row = document.createElement('div');
    row.className = `issue-row${isSelected ? ' selected' : ''}`;
    row.dataset.id = i.id;
    row.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="issue-status-dot" style="background:${ISSUE_STATUS_COLOR[status] ?? '#94a3b8'}" title="${status}"></span>
        <span class="text-xs font-mono text-slate-500">${ident}</span>
        <span class="issue-status-badge" style="color:${ISSUE_STATUS_COLOR[status] ?? '#94a3b8'};border-color:${ISSUE_STATUS_COLOR[status] ?? '#94a3b8'}">${status}</span>
      </div>
      <div class="text-sm text-slate-800 font-medium mt-1 truncate" title="${title}">${title}</div>
      <div class="flex items-center justify-between text-xs text-slate-500 mt-1">
        <span>${i.assigned_to_name ?? i.created_by_name ?? '—'}</span>
        ${due ? `<span class="${new Date(due) < new Date() && status !== 'closed' ? 'text-red-500' : ''}">due ${due.slice(0,10)}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', () => selectIssue(i.id));
    list.appendChild(row);
  }
}

async function selectIssue(issueId) {
  _issuesState.selectedId = issueId;
  document.querySelectorAll('.issue-row').forEach(r => r.classList.toggle('selected', r.dataset.id === issueId));

  const detail = el('issue-detail');
  el('issue-detail-empty').classList.add('hidden');
  detail.classList.remove('hidden');
  detail.innerHTML = '<p class="text-sm text-slate-400">Loading…</p>';

  try {
    const projectId = el('inp-project-id').value.trim();
    const issue = await api('GET', `/api/issues/${encodeURIComponent(issueId)}?projectId=${encodeURIComponent(projectId)}`);
    renderIssueDetail(issue);

    // Comments — best-effort
    try {
      const c = await api('GET', `/api/issues/${encodeURIComponent(issueId)}/comments?projectId=${encodeURIComponent(projectId)}`);
      const comments = c?.results ?? c?.data ?? [];
      renderIssueComments(comments);
    } catch (_) { /* comments may not exist */ }
  } catch (err) {
    detail.innerHTML = `<p class="text-sm text-red-500">Failed to load issue: ${err.message}</p>`;
  }
}

function renderIssueDetail(issue) {
  const status = (issue.status ?? 'open').toLowerCase();
  const detail = el('issue-detail');
  detail.innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-4">
      <div class="flex-1">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs font-mono text-slate-500">${issue.identifier ?? '—'}</span>
          <span class="issue-status-badge" style="color:${ISSUE_STATUS_COLOR[status] ?? '#94a3b8'};border-color:${ISSUE_STATUS_COLOR[status] ?? '#94a3b8'}">${status}</span>
        </div>
        <h3 class="text-base font-semibold text-slate-900">${issue.title ?? '(untitled)'}</h3>
      </div>
      <select id="sel-issue-status-change" class="field-input text-xs py-1 w-28" data-id="${issue.id}">
        ${['draft','open','answered','closed','void'].map(s =>
          `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`
        ).join('')}
      </select>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-4 text-xs">
      <div><span class="text-slate-500">Assigned:</span> ${issue.assigned_to_name ?? '—'}</div>
      <div><span class="text-slate-500">Owner:</span> ${issue.owner_name ?? '—'}</div>
      <div><span class="text-slate-500">Created:</span> ${issue.created_at?.slice(0,10) ?? '—'}</div>
      <div><span class="text-slate-500">Due:</span> ${issue.due_date?.slice(0,10) ?? '—'}</div>
      <div><span class="text-slate-500">Type:</span> ${issue.issue_type ?? issue.issue_type_name ?? '—'}</div>
      <div><span class="text-slate-500">Subtype:</span> ${issue.issue_subtype ?? issue.issue_subtype_name ?? '—'}</div>
    </div>

    ${issue.description ? `<div class="text-sm text-slate-700 mb-4 whitespace-pre-wrap">${escapeHtml(issue.description)}</div>` : ''}

    <hr class="my-4 border-slate-200"/>
    <h4 class="text-xs font-semibold text-slate-700 mb-2">Comments</h4>
    <div id="issue-comments" class="space-y-2 mb-3"></div>

    <div class="flex gap-2">
      <input id="inp-issue-comment" class="field-input flex-1 text-sm" placeholder="Add a comment…"/>
      <button id="btn-add-comment" class="btn-secondary text-sm">Send</button>
    </div>
  `;

  el('sel-issue-status-change').addEventListener('change', async e => {
    const newStatus = e.target.value;
    try {
      await api('PATCH', `/api/issues/${encodeURIComponent(issue.id)}?projectId=${encodeURIComponent(el('inp-project-id').value)}`, { status: newStatus });
      toast(`Status → ${newStatus}`);
      // Update list row
      const obj = _issuesState.issues.find(x => x.id === issue.id);
      if (obj) obj.status = newStatus;
      renderIssuesList();
    } catch (err) {
      toast('Status update failed: ' + err.message, 'error');
    }
  });

  el('btn-add-comment').addEventListener('click', async () => {
    const body = el('inp-issue-comment').value.trim();
    if (!body) return;
    try {
      await api('POST', `/api/issues/${encodeURIComponent(issue.id)}/comments?projectId=${encodeURIComponent(el('inp-project-id').value)}`, { body });
      el('inp-issue-comment').value = '';
      const data = await api('GET', `/api/issues/${encodeURIComponent(issue.id)}/comments?projectId=${encodeURIComponent(el('inp-project-id').value)}`);
      renderIssueComments(data?.results ?? data?.data ?? []);
    } catch (err) {
      toast('Comment failed: ' + err.message, 'error');
    }
  });
}

function renderIssueComments(comments) {
  const host = el('issue-comments');
  if (!host) return;
  if (!comments.length) {
    host.innerHTML = '<p class="text-xs text-slate-400">No comments yet.</p>';
    return;
  }
  host.innerHTML = comments.map(c => `
    <div class="bg-slate-50 border border-slate-200 rounded p-2 text-xs">
      <div class="flex items-center justify-between text-slate-500 mb-1">
        <span>${c.created_by_name ?? c.author ?? '—'}</span>
        <span>${(c.created_at ?? '').slice(0,16).replace('T', ' ')}</span>
      </div>
      <div class="text-slate-700 whitespace-pre-wrap">${escapeHtml(c.body ?? '')}</div>
    </div>
  `).join('');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openNewIssueModal() {
  const select = el('sel-issue-type');
  const subSelect = el('sel-issue-subtype');
  select.innerHTML = '<option value="">— select type —</option>';
  subSelect.innerHTML = '<option value="">— select subtype —</option>';

  const types = _issuesState.types ?? [];
  for (const t of types) select.add(new Option(t.title ?? t.name ?? t.id, t.id));
  select.onchange = () => {
    const t = types.find(x => x.id === select.value);
    subSelect.innerHTML = '<option value="">— select subtype —</option>';
    for (const st of (t?.subtypes ?? [])) subSelect.add(new Option(st.title ?? st.name ?? st.id, st.id));
  };

  el('inp-issue-title').value = '';
  el('inp-issue-desc').value  = '';
  el('inp-issue-due').value   = '';
  el('sel-issue-status').value = 'open';
  el('issue-new-modal').classList.remove('hidden');
}

async function createIssue() {
  const title = el('inp-issue-title').value.trim();
  if (!title) { toast('Title required', 'error'); return; }
  const issue = {
    title,
    description: el('inp-issue-desc').value.trim() || undefined,
    issue_subtype_id: el('sel-issue-subtype').value || undefined,
    due_date: el('inp-issue-due').value || undefined,
    status: el('sel-issue-status').value || 'open',
  };
  try {
    const projectId = el('inp-project-id').value.trim();
    await api('POST', `/api/issues?projectId=${encodeURIComponent(projectId)}`, issue);
    el('issue-new-modal').classList.add('hidden');
    toast('Issue created');
    loadIssues();
  } catch (err) {
    toast('Create failed: ' + err.message, 'error');
  }
}

// Initialisation
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Service account (3-legged OAuth) UI
// ─────────────────────────────────────────────────────────────────────────────

async function loadAuthStatus() {
  try {
    const status = await api('GET', '/api/auth/status');
    renderAuthStatus(status);

    // Check URL for post-OAuth redirect result
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      toast('Service account signed in successfully', 'success');
      window.history.replaceState({}, '', '/');
    } else if (params.get('auth') === 'error') {
      toast('Sign-in failed: ' + (params.get('msg') || 'Unknown error'), 'error');
      window.history.replaceState({}, '', '/');
    }
  } catch { /* non-critical */ }
}

function renderAuthStatus(status) {
  const loggedOut = el('sa-logged-out');
  const loggedIn  = el('sa-logged-in');
  const badge     = el('sa-status-badge');
  const callbackEl = el('sa-callback-display');

  // Show callback URL so user knows what to register in APS app settings
  if (callbackEl) {
    callbackEl.textContent = `${window.location.origin}/api/auth/callback`;
  }

  if (!status?.loggedIn) {
    loggedOut?.classList.remove('hidden');
    loggedIn?.classList.add('hidden');
    if (badge) {
      badge.className = 'hidden';
    }
    return;
  }

  loggedOut?.classList.add('hidden');
  loggedIn?.classList.remove('hidden');

  if (badge) {
    badge.textContent = '● Connected';
    badge.className = 'flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-300';
  }

  if (el('sa-account-name') && status.name) el('sa-account-name').textContent = status.name;
  if (el('sa-account-email') && status.email) el('sa-account-email').textContent = status.email;
  if (el('sa-token-expiry') && status.expiresAt) {
    const expires = new Date(status.expiresAt);
    const diffMin = Math.round((expires - Date.now()) / 60_000);
    el('sa-token-expiry').textContent = status.expired
      ? 'Token expired — will auto-refresh on next API call'
      : `Token valid · refreshes in ~${diffMin} min`;
  }
}

async function init() {
  try {
    State.config = await api('GET', '/api/config');
  } catch (e) {
    toast('Could not load configuration — is the server running?', 'error');
    return;
  }

  // Populate all tabs
  populateConnect(State.config);
  populateSettings(State.config);
  renderSearchSets(State.config.searchSets);
  renderClashTests(State.config.clashTests);

  // Reflect connection state if credentials already set
  if (State.config.env.APS_CLIENT_ID && State.config.hasSecret) {
    el('conn-dot').className = 'w-2 h-2 rounded-full flex-shrink-0 bg-slate-500';
    el('conn-label').textContent = 'Credentials loaded';
  }

  // Load service account auth status
  loadAuthStatus();

  // Load capabilities panel
  loadCapabilities();

  // ── Event listeners ──────────────────────────────────────

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Viewer tab
  el('btn-load-viewer-models').addEventListener('click', loadViewerModels);
  el('btn-unload-all-models').addEventListener('click', unloadAllModels);
  el('btn-clear-recent').addEventListener('click', clearRecentModels);
  document.querySelectorAll('.viewer-src-btn').forEach(btn => {
    btn.addEventListener('click', () => setViewerSource(btn.dataset.src));
  });
  el('btn-viewer-home').addEventListener('click', () => {
    if (_viewerState.viewer) _viewerState.viewer.fitToView();
  });
  el('btn-viewer-explode').addEventListener('click', () => {
    if (!_viewerState.viewer) return;
    const current = _viewerState.viewer.getExplodeScale?.() ?? 0;
    _viewerState.viewer.explode(current > 0 ? 0 : 0.5);
  });
  el('btn-show-clashes').addEventListener('click', showAllClashMarkers);
  el('btn-clear-markers').addEventListener('click', clearClashMarkers);
  el('btn-load-clash-results').addEventListener('click', loadClashResultsForViewer);
  el('inp-clash-filter').addEventListener('input', () => renderClashGroups(_viewerState.clashGroups));

  // Coordination space
  el('btn-load-coord-spaces').addEventListener('click', loadCoordinationSpaces);
  el('sel-coord-space').addEventListener('change', onCoordSpaceChange);

  // Saved Views
  el('sel-view').addEventListener('change', onViewSelected);
  el('btn-view-load').addEventListener('click', loadSelectedView);
  el('btn-view-save').addEventListener('click', saveCurrentAsView);
  el('btn-view-delete').addEventListener('click', deleteSelectedView);

  // Initialize viewer source toggle + recents on load
  setViewerSource('space');
  renderRecentModels();
  // Try to populate views list once (silent if unauthenticated)
  reloadViewsList().catch(() => {});

  // Issues tab
  el('btn-load-issues').addEventListener('click', loadIssues);
  el('btn-new-issue').addEventListener('click', openNewIssueModal);
  el('btn-issue-new-close').addEventListener('click', () => el('issue-new-modal').classList.add('hidden'));
  el('btn-issue-cancel').addEventListener('click', () => el('issue-new-modal').classList.add('hidden'));
  el('btn-issue-create').addEventListener('click', createIssue);
  el('inp-issue-search').addEventListener('input', e => {
    _issuesState.filterText = e.target.value;
    renderIssuesList();
  });
  document.querySelectorAll('.issue-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.issue-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _issuesState.filterStatus = pill.dataset.status;
      _issuesState.loaded = false; // re-fetch with new filter
      loadIssues();
    });
  });

  // Coordination tab
  el('btn-coord-refresh').addEventListener('click', () => {
    _coordState.loaded = false;
    loadCoordinationData();
  });
  el('btn-clash-incl-all').addEventListener('click', () => {
    _coordState.clashIncludes = _coordState.models.map(m => m.id);
    renderCoordClashRows();
    saveCoordinationDebounced();
  });
  el('btn-clash-incl-none').addEventListener('click', () => {
    _coordState.clashIncludes = [];
    renderCoordClashRows();
    saveCoordinationDebounced();
  });
  el('btn-clash-incl-disc').addEventListener('click', () => {
    _coordState.clashIncludes = Object.values(_coordState.assignments);
    renderCoordClashRows();
    saveCoordinationDebounced();
  });
  el('sel-align-snap').addEventListener('change', e => {
    _coordState.alignSnap = parseFloat(e.target.value || '1');
    saveCoordinationDebounced();
  });
  el('btn-load-mc-ss').addEventListener('click', loadMcSearchSets);
  el('btn-load-mc-ct').addEventListener('click', loadMcClashTests);
  el('btn-load-wf-results').addEventListener('click', loadWorkflowClashResults);

  // Models tab
  el('btn-load-models').addEventListener('click', loadModels);
  document.querySelectorAll('#models-disc-filter .disc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#models-disc-filter .disc-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _modelsDiscFilter = pill.dataset.disc;
      renderModels();
    });
  });

  // Hub tab
  el('btn-load-hub-projects').addEventListener('click', loadHubProjects);
  el('inp-hub-search').addEventListener('input', () => renderHubProjects(_hubProjects));
  el('sel-hub-sort').addEventListener('change', e => {
    _hubSort = e.target.value;
    renderHubProjects(_hubProjects);
  });
  document.querySelectorAll('.hub-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.hub-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _hubFilter = pill.dataset.filter;
      renderHubProjects(_hubProjects);
    });
  });

  // Connect tab — service account
  el('btn-sa-logout')?.addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    renderAuthStatus({ loggedIn: false });
    toast('Service account signed out');
  });

  // Connect tab
  el('btn-test-conn').addEventListener('click', testConnection);
  el('btn-load-folders').addEventListener('click', loadFolders);
  el('btn-detect-container').addEventListener('click', detectContainer);
  el('btn-save-env').addEventListener('click', saveEnv);
  el('btn-refresh-caps').addEventListener('click', loadCapabilities);
  el('btn-toggle-secret').addEventListener('click', () => {
    const inp = el('inp-client-secret');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Search Sets tab — discipline filter pills
  document.querySelectorAll('.disc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.disc-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      State.ssFilter = pill.dataset.disc;
      renderSearchSets(State.config.searchSets, State.ssFilter);
    });
  });

  // Search Sets tab — toolbar
  el('btn-ss-new').addEventListener('click', () => openSSCreator());
  el('btn-ss-save').addEventListener('click', saveSearchSets);
  el('btn-ss-import').addEventListener('click', () => el('ss-import-file').click());
  el('ss-import-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleNavisworksFile(file);
    e.target.value = ''; // allow re-selecting the same file
  });

  // Editor modal
  el('ss-modal-close').addEventListener('click', closeSSEditor);
  el('btn-ss-cancel').addEventListener('click', closeSSEditor);
  el('btn-ss-save-modal').addEventListener('click', commitSSEditor);
  el('btn-ss-delete').addEventListener('click', deleteCurrentSS);
  el('btn-ss-add-cond').addEventListener('click', () => {
    SSEditor.draft.filter.conditions.push({ property: '', operator: 'equals', value: '' });
    renderConditionRows();
  });
  el('ss-edit-join').addEventListener('change', (e) => {
    el('ss-edit-join-label').textContent = (e.target.value || 'or').toUpperCase();
  });
  el('btn-ss-pull-props').addEventListener('click', openModelPicker);

  // Import preview modal
  el('ss-import-close').addEventListener('click', () => el('ss-import-modal').classList.add('hidden'));
  el('btn-import-cancel').addEventListener('click', () => el('ss-import-modal').classList.add('hidden'));
  el('btn-import-confirm').addEventListener('click', mergeImportedSets);

  // Model picker modal
  el('ss-model-close').addEventListener('click', () => el('ss-model-modal').classList.add('hidden'));
  el('btn-model-cancel').addEventListener('click', () => el('ss-model-modal').classList.add('hidden'));
  el('ss-model-folder').addEventListener('change', (e) => { if (e.target.value) loadFolderModels(e.target.value); });
  el('ss-model-pick').addEventListener('change', (e) => { el('btn-model-pull').disabled = !e.target.value; });
  el('btn-model-pull').addEventListener('click', pullModelProperties);

  // Clash Tests tab
  el('btn-enable-all').addEventListener('click',  () => setAllClashTests(true));
  el('btn-disable-all').addEventListener('click', () => setAllClashTests(false));
  el('btn-save-clashes').addEventListener('click', saveClashConfig);

  // Settings tab
  el('btn-save-settings').addEventListener('click', saveSettings);
  el('set-naming-format').addEventListener('input', updateNamingPreview);

  // Run tab
  el('btn-run').addEventListener('click', runWorkflow);
  el('btn-clear-log').addEventListener('click', () => { el('log-output').innerHTML = ''; });

  // Keyboard shortcut: Cmd/Ctrl+Enter → Run
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && State.currentTab === 'run') {
      runWorkflow();
    }
  });

  // Start on Connect tab
  navigate('connect');
}

document.addEventListener('DOMContentLoaded', init);
