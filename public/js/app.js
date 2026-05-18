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
  stepMap: { auth: 0, modelset: 1, identify: 2, searchsets: 3, results: 4 },
};

// Discipline colour map (matches CSS variables)
const DISC_COLOR = {
  ARCH: '#f59e0b', STRUCT: '#3b82f6', MECH: '#10b981',
  PLUMB: '#06b6d4', ELEC: '#f97316', FP: '#ef4444',
  CIVIL: '#78716c', INT: '#8b5cf6', TECH: '#607D8B', UNKNOWN: '#9ca3af',
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
    e.hint     = err.hint     || null;
    e.apsBody  = err.apsBody  || null;
    e.details  = err.details  || null;   // APS error body from server-side catch
    e.triedUrl = err.triedUrl || null;
    e.status   = res.status;
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
  clashes:    { title: 'Clashes',         sub: 'View clash groups, apply templates, and push as ACC issues' },
  issues:     { title: 'Issues',         sub: 'View, filter, comment, and create ACC project issues' },
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
  if (tab === 'settings') renderSaveBtn(tab);
  // Lazy-init viewer — trigger if never initialized OR if SDK loaded but viewer was lost
  if (tab === 'viewer' && !_viewerState.viewer && !_viewerState.initializing) initViewerTab();
  // Lazy-load coordination data
  if (tab === 'coordination' && !_coordState.loaded) loadCoordinationData();
  // Lazy-load clashes
  if (tab === 'clashes' && !_clashesState.templates.length) _loadClashTemplates();
  // Lazy-load issues + types
  if (tab === 'issues' && !_issuesState.loaded) loadIssues();
  // Auto-load hub projects when navigating to the hub tab (if logged in and not loaded yet)
  if (tab === 'hub' && !_hubProjectsLoaded) _autoLoadHubProjects();
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
  const containerId = el('inp-container-id').value.trim() || State.config?.env?.MC_CONTAINER_ID || '';
  hideCoordSpaceError();
  if (!containerId) { toast('Set MC Container ID first (click Detect)', 'error'); return; }

  const btn = el('btn-load-coord-spaces');
  btn.disabled = true; btn.textContent = '…';

  try {
    const data = await api('GET', `/api/project/modelsets?containerId=${encodeURIComponent(containerId)}`);
    const raw  = data?.data ?? data?.results ?? data?.modelsets ?? data?.modelSets ?? data?.sets ?? null;
    const sets = Array.isArray(raw) ? raw : Array.isArray(data) ? data : [];
    _coordSpaces = sets;

    const sels = [el('sel-coord-space'), el('sel-coord-space-mc'), el('sel-viewer-coord-space')].filter(Boolean);
    const previousValue = sels[0]?.value;

    sels.forEach(sel => {
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
    });

    // Show/hide the viewer inline picker depending on whether there are spaces
    const viewerPicker = el('viewer-space-picker');
    if (viewerPicker) viewerPicker.classList.toggle('hidden', sets.length === 0);

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

      // Auto-select the first space when nothing was selected before
      if (!previousValue) {
        const firstId = sets[0].id ?? sets[0].modelSetId;
        sels.forEach(sel => { if (sel) sel.value = firstId; });
        await onCoordSpaceChange();
      }
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
      const steps = [
        'Your project hasn\'t been onboarded to ACC Model Coordination yet — open the MC app once in ACC web to enable',
        'The Container ID is wrong — for ACC v3 projects it equals the Project ID (without the "b." prefix)',
        'Stale MC_MODELSET_API_BASE / MC_CLASH_API_BASE env var — remove them so code defaults take effect',
      ];
      if (err.details) steps.push(`Autodesk responded: ${typeof err.details === 'string' ? err.details : JSON.stringify(err.details)}`);
      showCoordSpaceError(
        '404 Not Found — Container does not exist on the MC API',
        'The Container ID resolved is not registered with Model Coordination. Possible reasons:',
        steps,
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

async function onCoordSpaceChange(e) {
  const id = e?.target?.value || el('sel-coord-space')?.value || el('sel-coord-space-mc')?.value;
  if (!id) return;

  // Sync all selectors
  [el('sel-coord-space'), el('sel-coord-space-mc')].forEach(sel => {
    if (sel && sel.value !== id) sel.value = id;
  });

  const name = getActiveCoordSpaceName();
  showCoordSpaceInfo(`Active: ${name}`);

  try {
    await api('POST', '/api/config/env', { MC_MODEL_SET_ID: id });
    if (State.config?.env) State.config.env.MC_MODEL_SET_ID = id;
    toast(`Coordination space "${name}" active`);
    
    // Refresh relevant data
    reloadViewsList().catch(() => {});
    
    // If on coordination tab, reload immediately
    if (State.currentTab === 'coordination') {
      _coordState.loaded = false;
      loadCoordinationData();
    }
    
    // If viewer is set to 'space', reload model list
    if (_viewerState.source === 'space') {
      loadViewerModels();
    }
  } catch (err) {
    toast('Failed to save selection: ' + err.message, 'error');
  }
}

function getActiveCoordSpaceId() {
  const sel1 = el('sel-coord-space');
  const sel2 = el('sel-coord-space-mc');
  const val1 = (sel1 && sel1.value && !sel1.value.includes('select')) ? sel1.value : null;
  const val2 = (sel2 && sel2.value && !sel2.value.includes('select')) ? sel2.value : null;
  return val1 || val2 || State.config?.env?.MC_MODEL_SET_ID || '';
}

function getActiveCoordSpaceName() {
  const sel1 = el('sel-coord-space');
  const sel2 = el('sel-coord-space-mc');
  if (sel1?.selectedIndex > 0) return sel1.options[sel1.selectedIndex].text;
  if (sel2?.selectedIndex > 0) return sel2.options[sel2.selectedIndex].text;
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

      // Auto-persist so MC_CONTAINER_ID is available to all backend routes
      const savePayload = { MC_CONTAINER_ID: id };
      // If the server found a working MC base URL, persist it too
      if (data.workingBaseUrl) {
        savePayload.MC_MODELSET_API_BASE = data.workingBaseUrl;
      }
      try {
        await api('POST', '/api/config/env', savePayload);
        if (State.config?.env) State.config.env.MC_CONTAINER_ID = id;
      } catch (_) { /* best-effort persist */ }

      if (data.warning) {
        errPanel.className = 'mt-2 p-3 rounded text-sm bg-amber-900/40 border border-amber-700 text-amber-200';
        errPanel.textContent = `⚠ ${data.warning}`;
        errPanel.classList.remove('hidden');
        toast(`Container ID filled in (unverified — see warning below)`, 'error');
      } else {
        errPanel.classList.add('hidden');
        toast(`Container detected: ${id}`);
      }

      // Auto-load coordination spaces now that the container is known
      loadCoordinationSpaces();
    } else {
      toast('No containers found — ensure your app is provisioned in ACC Admin', 'error');
    }
  } catch (err) {
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

// Virtual "folder" id used to surface the active Coordination Space documents
// at the top of the folder picker — these are the same models the workflow
// classifies, so they almost always have a discipline already assigned.
const COORD_SPACE_VFOLDER = '__coord_space__';
const TARGET_FOLDER_VLABEL = '📌 Target Folder (Connect tab)';

async function openModelPicker() {
  el('ss-model-modal').classList.remove('hidden');
  const status = el('ss-model-status');
  const folderSel = el('ss-model-folder');
  status.textContent = 'Loading models…';

  const accountId = State.config.env.ACC_ACCOUNT_ID;
  const projectId = State.config.env.ACC_PROJECT_ID;
  const targetFolder = State.config.env.TARGET_FOLDER_URN || '';
  const hasCoordSpace = !!getActiveCoordSpaceId();

  if (!accountId || !projectId) {
    status.textContent = 'Set ACC Account ID and Project ID on the Connect tab first.';
    return;
  }

  // Build the folder dropdown — lead with the coordination space and the
  // target folder so the user doesn't have to navigate from the project root.
  folderSel.innerHTML = '';
  if (hasCoordSpace) {
    folderSel.add(new Option('📦 Coordination Space (discipline-assigned)', COORD_SPACE_VFOLDER));
  }
  if (targetFolder) {
    folderSel.add(new Option(TARGET_FOLDER_VLABEL, targetFolder));
  }
  folderSel.add(new Option('— or browse all project folders —', ''));

  try {
    const data = await api('GET', `/api/project/folders?accountId=${encodeURIComponent(accountId)}&projectId=${encodeURIComponent(projectId)}`);
    for (const f of (data?.data ?? [])) {
      const id = f.id;
      // Skip the duplicate target-folder entry — it's already the second option
      if (id === targetFolder) continue;
      folderSel.add(new Option(f.attributes?.name || id, id));
    }
  } catch (err) {
    status.textContent = 'Could not load folder list: ' + err.message;
  }

  // Auto-select the most useful starting point
  let initial = '';
  if (hasCoordSpace)        initial = COORD_SPACE_VFOLDER;
  else if (targetFolder)    initial = targetFolder;

  if (initial) {
    folderSel.value = initial;
    await loadFolderModels(initial);
  } else {
    status.textContent = 'Pick a folder, or set a Target Folder / load a Coordination Space on the Connect tab to skip this step.';
  }
}

async function loadFolderModels(folderUrn) {
  const sel = el('ss-model-pick');
  const status = el('ss-model-status');
  const pullBtn = el('btn-model-pull');
  sel.innerHTML = '<option value="">— loading —</option>';
  sel.disabled = true;
  pullBtn.disabled = true;

  // Virtual folder: pull the active coordination space documents and label them
  // by discipline (from per-model overrides → coord-tab assignments → filename guess).
  if (folderUrn === COORD_SPACE_VFOLDER) {
    try {
      const docs = await fetchCoordSpaceModels();
      const overrides = (typeof _coordState !== 'undefined' && _coordState?.modelDisciplines) || {};
      const labeled = docs.map(d => {
        const disc = overrides[d.id] ?? overrides[d.rawUrn] ?? overrides[d.viewerUrn] ?? d.discipline ?? 'UNKNOWN';
        return { ...d, disc };
      });
      labeled.sort((a, b) => (a.disc || '').localeCompare(b.disc || '') || a.name.localeCompare(b.name));
      sel.innerHTML = labeled.length
        ? '<option value="">— pick a model —</option>'
        : '<option value="">— coordination space has no documents (run Refresh from Space) —</option>';
      for (const m of labeled) {
        const label = m.disc && m.disc !== 'UNKNOWN' ? `[${m.disc}] ${m.name}` : m.name;
        const opt = new Option(label, m.viewerUrn || m.id);
        opt.dataset.urn = m.viewerUrn || '';
        sel.add(opt);
      }
      sel.disabled = !labeled.length;
      status.textContent = labeled.length ? `${labeled.length} discipline-assigned model(s) from coordination space.` : '';
    } catch (err) {
      sel.innerHTML = '<option value="">— error —</option>';
      status.textContent = 'Could not load coordination space models: ' + err.message;
    }
    return;
  }

  if (!folderUrn) {
    sel.innerHTML = '<option value="">— select a folder above —</option>';
    status.textContent = '';
    return;
  }

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
  const value = pick.value;
  if (!value) return;
  const status = el('ss-model-status');
  status.innerHTML = 'Extracting properties <span class="spinner-dot"></span><span class="spinner-dot"></span><span class="spinner-dot"></span>';

  // Coordination-space models carry a base64 derivative URN directly; folder
  // models carry an item id and need a tip-version lookup server-side.
  const opt = pick.options[pick.selectedIndex];
  const derivUrn = opt?.dataset?.urn || '';
  const projectId = State.config.env.ACC_PROJECT_ID;

  const qs = derivUrn
    ? `urn=${encodeURIComponent(derivUrn)}`
    : `projectId=${encodeURIComponent(projectId)}&itemId=${encodeURIComponent(value)}`;

  try {
    const data = await api('GET', `/api/models/properties?${qs}`);
    SSEditor.properties = data?.properties ?? [];
    ensureSharedPropsList();
    updatePropHint();
    status.textContent = `✓ ${SSEditor.properties.length} propertie(s) loaded from ${opt?.text || 'model'}.`;
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

    // Build side A/B labels and search-set hints for the description row
    const sideA = t.sideA?.label ?? (t.requiredDisciplines?.[0] ?? 'A');
    const sideB = t.sideB?.label ?? (t.requiredDisciplines?.[1] ?? 'B');
    const ssA   = (t.sideA?.searchSetIds ?? []).join(', ') || 'auto';
    const ssB   = (t.sideB?.searchSetIds ?? []).join(', ') || 'auto';

    const row = document.createElement('tr');
    row.dataset.testId = t.id;
    row.innerHTML = `
      <td class="text-slate-400 font-mono text-xs align-top">${t.priority}</td>
      <td class="align-top">
        <div class="font-medium text-slate-800 font-mono text-xs">${escapeHtml(t.name)}</div>
        ${t.displayName ? `<div class="text-xs text-slate-500 mt-0.5">${escapeHtml(t.displayName)}</div>` : ''}
      </td>
      <td class="align-top">${discs}</td>
      <td class="align-top"><span class="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-600 font-medium">${t.clashType}</span></td>
      <td class="align-top"><input class="clash-tol-input" type="number" step="0.001" min="0" value="${t.tolerance}" data-test-id="${t.id}" data-field="tolerance"/></td>
      <td class="text-center align-top">
        ${t.subTests?.length ? `<button class="text-xs text-brand hover:underline" data-expand="${t.id}">${t.subTests.length} ▾</button>` : '<span class="text-slate-300">—</span>'}
      </td>
      <td class="text-center align-top">
        <label class="toggle-switch">
          <input type="checkbox" ${t.enabled ? 'checked' : ''} data-test-id="${t.id}" data-field="enabled"/>
          <span class="toggle-knob"></span>
        </label>
      </td>
    `;
    tbody.appendChild(row);

    // Description row — always visible (the user said tests were unexplainable)
    if (t.notes || t.sideA || t.sideB) {
      const descRow = document.createElement('tr');
      descRow.className = 'desc-row';
      descRow.dataset.parentId = t.id;
      descRow.innerHTML = `
        <td></td>
        <td colspan="6" class="text-xs text-slate-600 pb-2">
          ${t.notes ? `<div class="mb-1 italic">${escapeHtml(t.notes)}</div>` : ''}
          <div class="grid grid-cols-2 gap-3 text-[11px] text-slate-500">
            <div><span class="font-semibold text-slate-700">Side A — ${escapeHtml(sideA)}:</span> <span class="font-mono">${escapeHtml(ssA)}</span></div>
            <div><span class="font-semibold text-slate-700">Side B — ${escapeHtml(sideB)}:</span> <span class="font-mono">${escapeHtml(ssB)}</span></div>
          </div>
        </td>
      `;
      tbody.appendChild(descRow);
    }

    // Sub-tests (hidden by default)
    if (t.subTests?.length) {
      for (const sub of t.subTests) {
        const subRow = document.createElement('tr');
        subRow.className = 'sub-row';
        subRow.dataset.parentId = t.id;
        subRow.style.display = 'none';
        subRow.innerHTML = `
          <td></td>
          <td colspan="2" class="font-mono text-xs text-slate-500">↳ ${escapeHtml(sub.name)}</td>
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
  if (message.includes('Step 6')) return { step: 'results',    state: 'active' };
  if (message.includes('✓ APS auth'))   return { step: 'auth',       state: 'done' };
  if (message.includes('✓ Model set'))  return { step: 'modelset',   state: 'done' };
  if (message.includes('Disciplines'))  return { step: 'identify',   state: 'done' };
  if (message.includes('Search Sets'))  return { step: 'searchsets', state: 'done' };
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
  ELEC:'#f97316', FP:'#ef4444',    CIVIL:'#78716c', INT:'#8b5cf6',
  TECH:'#607D8B', UNKNOWN:'#9ca3af',
};

const _viewerState = {
  sdkLoaded: false,
  viewer: null,
  initializing: false, // true while initViewerTab() is in progress
  loadedModels: [],   // { urn, name, discipline, model }
  clashGroups: [],
  activeGroup: null,
  source: 'space',    // 'space' | 'folder'
  // Captured from the FIRST loaded model so subsequent models share the
  // same coordinate origin. Without this, multi-model loads drift apart
  // by tens or hundreds of metres because each model gets its own offset.
  globalOffset: null,
};

const RECENT_MODELS_KEY   = 'formaflow.recentModels';
const RECENT_MODELS_LIMIT = 10;
const DISC_PATTERNS_KEY   = 'formaflow.discPatterns';

// ─────────────────────────────────────────────────────────────────────────────
// Learned discipline patterns — persisted across sessions in localStorage.
// Key: normalized model name segment (no numbers, extension stripped).
// Value: discipline code ('ARCH', 'STRUCT', etc.)
// ─────────────────────────────────────────────────────────────────────────────

function _loadDiscPatterns() {
  try { return JSON.parse(localStorage.getItem(DISC_PATTERNS_KEY) || '{}'); }
  catch { return {}; }
}

function _saveDiscPattern(modelName, disc) {
  if (!modelName || !disc || disc === 'UNKNOWN') return;
  const key = _normalizeNameForPattern(modelName);
  if (!key) return;
  const patterns = _loadDiscPatterns();
  patterns[key] = disc;
  localStorage.setItem(DISC_PATTERNS_KEY, JSON.stringify(patterns));
}

function _normalizeNameForPattern(name = '') {
  // Strip file extension, numbers, and common separators to get the stable part
  return name
    .replace(/\.\w+$/, '')          // remove extension
    .replace(/[-_\s]+\d+[-_\s]*/g, '_') // collapse number sequences into _
    .replace(/[^A-Za-z_]/g, '')     // keep only letters and underscores
    .toUpperCase()
    .slice(0, 40);
}

function _lookupLearnedDisc(modelName) {
  const key = _normalizeNameForPattern(modelName);
  if (!key) return null;
  const patterns = _loadDiscPatterns();
  // Exact match first
  if (patterns[key]) return patterns[key];
  // Partial match: any stored key that is a substring of key or vice versa
  for (const [k, v] of Object.entries(patterns)) {
    if (k.length >= 4 && (key.includes(k) || k.includes(key))) return v;
  }
  return null;
}

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
    ? 'Load Discipline Selection' : 'Load from Folder';

  // Federation loader is only meaningful for coordination spaces.
  el('btn-load-federation')?.classList.toggle('hidden', src !== 'space');

  const infoEl    = el('viewer-active-space');
  const pickerEl  = el('viewer-space-picker');
  const pickerSel = el('sel-viewer-coord-space');

  if (src === 'space') {
    const hasSpaces = pickerSel && pickerSel.options.length > 1; // more than the placeholder
    if (hasSpaces) {
      // Show the inline picker, sync its selection, hide the plain label
      pickerEl?.classList.remove('hidden');
      infoEl?.classList.add('hidden');
      const activeId = getActiveCoordSpaceId();
      if (activeId && pickerSel.querySelector(`option[value="${activeId}"]`)) pickerSel.value = activeId;
    } else {
      // No spaces loaded yet — show the warning label
      pickerEl?.classList.add('hidden');
      infoEl?.classList.remove('hidden');
      const name = getActiveCoordSpaceName();
      infoEl.textContent = name ? `📐 ${name}` : '⚠ No coordination space selected — use Connect tab';
      infoEl.title = name || '';
    }
  } else {
    pickerEl?.classList.add('hidden');
    infoEl?.classList.add('hidden');
  }
}

async function unloadAllModels() {
  if (!_viewerState.viewer || !_viewerState.loadedModels.length) return;
  const count = _viewerState.loadedModels.length;
  for (const m of _viewerState.loadedModels) {
    try { _viewerState.viewer.unloadModel(m.model); } catch (_) {}
  }
  _viewerState.loadedModels = [];
  // Reset the captured offset — the next federation load starts fresh.
  _viewerState.globalOffset = null;
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
    if (modelSetId) {
      const qs = new URLSearchParams({ modelSetId });
      if (containerId) qs.set('containerId', containerId);
      const resp = await api('GET', `/api/mc/space-documents?${qs}`);
      docs = resp?.documents ?? [];
    }

    // Build a list of items to load. MC view modelIds can be document UUIDs,
    // version URNs, derivative URNs, or urn:-prefixed strings — try all formats.
    const targets = [];
    const seen = new Set();
    for (const id of v.modelIds ?? []) {
      const stripped = id.replace(/^urn:/i, '');
      const lineageIdMatch = id.match(/dm\.lineage:([^?&:/]+)/);
      const lineageId = lineageIdMatch?.[1];
      const doc = docs.find(d =>
        d.id === id || d.id === stripped ||
        d.rawUrn === id || d.rawUrn === stripped ||
        d.derivativeUrn === id || d.derivativeUrn === stripped ||
        d.viewerUrn === id || d.viewerUrn === stripped ||
        (d.lineageUrn && (d.lineageUrn === id || d.lineageUrn.replace(/^urn:/i, '') === stripped)) ||
        (lineageId && d.rawUrn && d.rawUrn.includes(lineageId))
      );
      if (doc?.viewerUrn && !seen.has(doc.viewerUrn)) {
        seen.add(doc.viewerUrn);
        targets.push({ name: doc.name, viewerUrn: doc.viewerUrn, discipline: guessDiscFromName(doc.name) });
      }
    }

    // If still nothing (modelIds empty or MC view only uses document names),
    // log a clear message so the user knows WHY it failed.
    if (!targets.length && (v.modelIds?.length ?? 0) > 0) {
      const tried = v.modelIds.join(', ');
      toast(`No loadable models found for view "${v.name}" — IDs tried: ${tried.slice(0, 80)}`, 'error');
      el('viewer-status-text').textContent = '';
      return;
    }
    if (!targets.length) {
      toast('This view has no model references — save a view with loaded models to populate it', 'error');
      el('viewer-status-text').textContent = '';
      return;
    }

    // Load them sequentially — call loadModelToViewer directly (not toggleViewerModel,
    // which requires a real sidebar item DOM element with .model-status child)
    let loaded = 0;
    for (const t of targets) {
      try {
        el('viewer-status-text').textContent = `Loading ${t.name}…`;
        await loadModelToViewer(t);
        loaded++;
        // Sync sidebar item state if it exists
        const item = document.querySelector(`.viewer-model-item[data-urn="${t.viewerUrn}"]`);
        if (item) {
          item.classList.remove('loading'); item.classList.add('loaded');
          const st = item.querySelector('.model-status');
          if (st) st.textContent = '✓';
        }
      } catch (err) {
        console.warn('loadSelectedView: model load failed for', t.name, err);
      }
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

    if (loaded) {
      toast(`View "${v.name}" — ${loaded} model(s) loaded`);
      el('viewer-status-text').textContent = `View "${v.name}" — ${loaded} model(s)`;
      updateViewerModelCounter();
      el('btn-unload-all-models').classList.toggle('hidden', _viewerState.loadedModels.length === 0);
      setTimeout(() => { try { _viewerState.viewer?.fitToView?.(); } catch (_) {} }, 500);
    } else {
      toast(`No models could be loaded for view "${v.name}" — derivatives may not be ready`, 'error');
      el('viewer-status-text').textContent = '';
    }
    // Show issue pushpin markers for the models just loaded
    showIssuePushpinsInViewer().catch(() => {});
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
  if (modelSetId) {
    try {
      const qs = new URLSearchParams({ modelSetId });
      if (containerId) qs.set('containerId', containerId);
      const resp = await api('GET', `/api/mc/space-documents?${qs}`);
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
  if (_viewerState.initializing) return; // prevent duplicate init
  _viewerState.initializing = true;
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
            reject(e);
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
  } finally {
    _viewerState.initializing = false;
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

    // For coordination space source: load the discipline-selected models directly into the 3D viewer
    if (_viewerState.source === 'space' && _viewerState.viewer) {
      const includes = _coordState.clashIncludes;
      // Build a Set of included viewerUrns by cross-referencing _coordState.models
      // (fetchSpaceViewerModels returns models without id, so we can't use m.id directly)
      const includedUrns = new Set(
        _coordState.models
          .filter(cm => !includes.length || includes.includes(cm.id))
          .map(cm => cm.viewerUrn)
          .filter(Boolean)
      );
      const toLoad = merged.filter(m => {
        if (!m.viewerUrn) return false;
        if (!includes.length || !includedUrns.size) return true; // nothing selected → load all
        return includedUrns.has(m.viewerUrn);
      });
      let loadedCount = 0;
      for (const m of toLoad) {
        if (_viewerState.loadedModels.find(lm => lm.urn === m.viewerUrn)) continue;
        try { await loadModelToViewer(m); loadedCount++; } catch (_) {}
      }
      if (loadedCount) {
        updateViewerModelCounter();
        el('btn-unload-all-models').classList.toggle('hidden', _viewerState.loadedModels.length === 0);
        toast(`Loaded ${loadedCount} discipline-selected model(s) into viewer`);
        setTimeout(() => {
          try { _viewerState.viewer.navigation.fitBounds(true); } catch (_) {}
        }, 500);
      }
    }
  } catch (err) {
    toast('Failed to list models: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = _viewerState.source === 'space' ? 'Load Discipline Selection' : 'Load from Folder';
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
  if (!modelSetId)  { toast('Pick a Coordination Space on the Connect tab first', 'error'); return null; }
  const containerId = el('inp-container-id').value.trim();
  const qs = new URLSearchParams({ modelSetId });
  if (containerId) qs.set('containerId', containerId);
  const data = await api('GET', `/api/mc/space-documents?${qs}`);
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

/**
 * Load every model in the active coordination space sequentially.
 * Uses the same code path as a manual toggle, so the captured globalOffset
 * is reused across all loads — that is what makes models snap into a single
 * federated view (the equivalent of an NWF in Navisworks / a Forma view).
 */
async function loadFederation() {
  if (!_viewerState.viewer) {
    toast('Open the 3D Viewer tab first', 'error');
    return;
  }
  const btn = el('btn-load-federation');
  if (btn) { btn.disabled = true; }
  const originalText = btn?.textContent ?? 'Load Federation';
  if (btn) { btn.textContent = 'Loading…'; }
  el('viewer-status-text').textContent = 'Loading federation…';

  try {
    // Fetch the documents for the active coordination space (already
    // server-normalised via toArray()).
    const docs = await fetchSpaceViewerModels();
    if (!docs?.length) {
      toast('No documents found in the active coordination space', 'error');
      return;
    }

    const loadable = docs.filter(d => d.viewerUrn);
    if (!loadable.length) {
      toast('No translated models in this space — Revit/IFC models must be published & translated in ACC first', 'error');
      return;
    }

    let loaded = 0;
    let failed = 0;
    for (const d of loadable) {
      // Skip models already loaded (allow incremental loads)
      if (_viewerState.loadedModels.find(m => m.urn === d.viewerUrn)) continue;
      if (btn) { btn.textContent = `Loading ${loaded + 1}/${loadable.length}…`; }
      el('viewer-status-text').textContent = `Loading ${d.name} (${loaded + 1}/${loadable.length})`;
      try {
        await new Promise((resolve, reject) => {
          Autodesk.Viewing.Document.load(
            `urn:${d.viewerUrn}`,
            async (doc) => {
              const geometry = doc.getRoot().getDefaultGeometry();
              const loadOpts = {
                keepCurrentModels: true,
                loadAsHidden: false,
                ...(_viewerState.globalOffset ? { globalOffset: _viewerState.globalOffset } : {}),
                applyRefPoint: true,
              };
              const model = await _viewerState.viewer.loadDocumentNode(doc, geometry, loadOpts);
              if (!_viewerState.globalOffset) {
                const off = model.getData?.()?.globalOffset;
                if (off && (off.x || off.y || off.z)) {
                  _viewerState.globalOffset = { x: off.x, y: off.y, z: off.z };
                }
              }
              const finalDisc = getUserDiscipline(d) || guessDiscFromName(d.name);
              _viewerState.loadedModels.push({
                urn: d.viewerUrn, name: d.name, discipline: finalDisc, model,
              });
              loaded++;
              resolve();
            },
            (code, msg) => reject(new Error(`Viewer load error ${code}: ${msg}`)),
          );
        });

        // Mark the matching list item as loaded so the sidebar reflects state
        const item = document.querySelector(`.viewer-model-item[data-urn="${d.viewerUrn}"]`);
        if (item) {
          item.classList.add('loaded');
          const status = item.querySelector('.model-status');
          if (status) status.textContent = '✓';
        }
      } catch (err) {
        failed++;
        console.warn('Federation load failed for', d.name, err);
      }
    }

    updateViewerModelCounter();
    el('btn-unload-all-models').classList.toggle('hidden', _viewerState.loadedModels.length === 0);
    el('viewer-status-text').textContent = `${loaded} loaded${failed ? `, ${failed} failed` : ''}`;
    toast(`Federation: ${loaded} model(s) loaded${failed ? `, ${failed} failed` : ''}`);

    // Fit all loaded models in view
    setTimeout(() => {
      try { _viewerState.viewer.navigation.fitBounds(true); } catch (_) {}
    }, 500);
  } catch (err) {
    toast('Federation load failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
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
  // Fall back to user-learned pattern from previous explicit assignments
  return _lookupLearnedDisc(name) ?? 'UNKNOWN';
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
    await loadModelToViewer(modelDef);
    itemEl.classList.remove('loading'); itemEl.classList.add('loaded');
    const statusEl = itemEl.querySelector('.model-status');
    if (statusEl) statusEl.textContent = '✓';
    el('viewer-status-text').textContent = `${modelDef.name} loaded`;
  } catch (err) {
    itemEl.classList.remove('loading'); itemEl.classList.add('error');
    const statusEl = itemEl.querySelector('.model-status');
    if (statusEl) statusEl.textContent = '✗';
    toast('Load failed: ' + err.message, 'error');
  }
}

/** Standalone loader for a single model (no UI dependencies) */
async function loadModelToViewer(modelDef) {
  if (!_viewerState.viewer) throw new Error('Viewer not initialized');
  
  // Skip if already loaded
  if (_viewerState.loadedModels.find(m => m.urn === modelDef.viewerUrn)) return;

  return new Promise((resolve, reject) => {
    Autodesk.Viewing.Document.load(
      `urn:${modelDef.viewerUrn}`,
      async (doc) => {
        const geometry = doc.getRoot().getDefaultGeometry();
        const loadOpts = {
          keepCurrentModels: true,
          loadAsHidden: false,
          ...(_viewerState.globalOffset ? { globalOffset: _viewerState.globalOffset } : {}),
          applyRefPoint: true,
        };
        const model = await _viewerState.viewer.loadDocumentNode(doc, geometry, loadOpts);
        
        if (!_viewerState.globalOffset) {
          const off = model.getData?.()?.globalOffset;
          if (off && (off.x || off.y || off.z)) {
            _viewerState.globalOffset = { x: off.x, y: off.y, z: off.z };
          }
        }
        
        const finalDisc = getUserDiscipline(modelDef) || modelDef.discipline || guessDiscFromName(modelDef.name);
        _viewerState.loadedModels.push({ urn: modelDef.viewerUrn, name: modelDef.name, discipline: finalDisc, model });
        
        updateViewerModelCounter();
        el('btn-unload-all-models').classList.remove('hidden');
        saveRecentModel(modelDef);
        
        // Post-load tasks
        const matchedItem = _coordState.models.find(cm => cm.viewerUrn === modelDef.viewerUrn);
        if (matchedItem?.id) maybeApplyAlignmentToViewer(matchedItem.id);
        showIssuePushpinsInViewer().catch(() => {});
        
        resolve(model);
      },
      (code, msg) => reject(new Error(`Viewer load error ${code}: ${msg}`))
    );
  });
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
    _viewerState.clashReportProvenance = data?.provenance ?? null;
    renderClashProvenanceBanner(_viewerState.clashReportProvenance, groups);
    renderClashGroups(groups);
    toast(`Loaded ${groups.length} clash group(s)`);
  } catch (err) {
    toast('Failed to load clash results: ' + err.message, 'error');
  }
}

/**
 * Render a banner above the clash-group list that surfaces the data's
 * provenance. Three states:
 *   - api-grouped → green "verbatim from Forma" banner (or hidden)
 *   - legacy-fallback → amber "FormaFlow bucketed raw clashes" banner
 *   - synthetic-discipline-pair / mixed → red "these are placeholders" banner
 *     with the recovery hint inline.
 */
function renderClashProvenanceBanner(reportProvenance, groups) {
  const host = el('viewer-clash-provenance');
  if (!host) return;

  // If the report has no provenance object, infer from the groups
  const groupSources = new Set(groups.map(g => g.provenance?.source ?? (g.synthetic ? 'synthetic-discipline-pair' : 'unknown')));
  const isSynthetic  = groupSources.has('synthetic-discipline-pair') || (reportProvenance?.synthetic === true);
  const isFallback   = groupSources.has('legacy-fallback');
  const isApi        = groupSources.has('api-grouped');

  let level = 'ok', title = '', body = '', hint = '';
  if (isSynthetic && !isApi) {
    level = 'error';
    title = '⚠ Placeholder data — NOT real clashes';
    body  = 'These groups were generated structurally because the Forma API returned no real clashes. Every group has 0 members and no point coordinates.';
    hint  = reportProvenance?.recoveryHints?.[0]
      ?? 'Configure a Saved Clash Check in Forma with a Group-clashes-by hierarchy. See docs/forma-rules-and-grouping-guide.md §2.';
  } else if (isSynthetic && isApi) {
    level = 'warn';
    title = '⚠ Mixed data — some groups are placeholders';
    body  = 'Some discipline pairs returned real clashes; others returned nothing and were filled with placeholders. The "🤖 auto" badge is disabled on placeholders.';
    hint  = 'Check the rules document for the empty pairs — likely missing a Side A/B in the active Saved Clash Check.';
  } else if (isFallback) {
    level = 'warn';
    title = 'Legacy grouping — Forma returned raw clashes, not groups';
    body  = 'FormaFlow bucketed these by Level + System Classification client-side. Forma\'s "Group clashes by" hierarchy is empty for this model set.';
    hint  = 'Open Forma → Clashes panel → click "Group clashes by" → add Level, System Classification, Category → Save clash check.';
  } else if (isApi) {
    // Real data — no banner needed (keep UI quiet on the happy path)
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  } else {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const STYLES = {
    error: { bg: 'bg-red-900/40',    border: 'border-red-700/60',    text: 'text-red-200',    icon: 'text-red-300' },
    warn:  { bg: 'bg-amber-900/40',  border: 'border-amber-700/60',  text: 'text-amber-200',  icon: 'text-amber-300' },
    ok:    { bg: 'bg-emerald-900/40', border: 'border-emerald-700/60', text: 'text-emerald-200', icon: 'text-emerald-300' },
  };
  const s = STYLES[level];
  host.innerHTML = `
    <div class="${s.bg} border ${s.border} ${s.text} text-xs px-3 py-2 leading-relaxed">
      <div class="font-semibold ${s.icon} mb-0.5">${title}</div>
      <div class="opacity-90">${escapeHtml(body)}</div>
      ${hint ? `<div class="mt-1 opacity-80"><b>Fix:</b> ${escapeHtml(hint)}</div>` : ''}
      <button id="btn-run-readiness" class="mt-1.5 underline opacity-80 hover:opacity-100">Run readiness check →</button>
    </div>
  `;
  host.classList.remove('hidden');
  el('btn-run-readiness')?.addEventListener('click', runReadinessCheckAndShow);
}

async function runReadinessCheckAndShow() {
  try {
    const modelSetId = window._appState?.modelSetId
      ?? el('inp-clash-model-set')?.value
      ?? prompt('Model Set ID to check?');
    if (!modelSetId) return;
    toast('Running readiness check…');
    const data = await api('GET', `/api/debug/readiness?modelSetId=${encodeURIComponent(modelSetId)}`);
    const lines = (data.checks ?? []).map(c =>
      `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}${c.fix ? `\n    Fix: ${c.fix}` : ''}`
    ).join('\n');
    alert(`Verdict: ${data.verdict}\n\n${lines}\n\nNext step: ${data.nextStep ?? '—'}`);
  } catch (err) {
    toast('Readiness check failed: ' + err.message, 'error');
  }
}

function renderClashGroups(groups) {
  const list = el('viewer-clash-list');
  const filter = (el('inp-clash-filter').value ?? '').toLowerCase();
  const filtered = filter ? groups.filter(g => g.name?.toLowerCase().includes(filter)) : groups;

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `
      <div class="p-4 text-xs text-slate-400 space-y-2">
        <div class="text-center text-slate-300 font-medium">No clash groups match the filter</div>
        <div class="text-slate-500 leading-relaxed">
          A <b class="text-slate-300">clash group</b> is one batch of intersections that share the same
          property values (e.g. same level, same system). Names come straight from the Forma "Clashes" panel
          and read like a breadcrumb: <code class="text-amber-400">Level&nbsp;3 &gt; Supply&nbsp;Air &gt; Ducts</code>.
        </div>
      </div>`;
    return;
  }

  // Build discipline summary chips (sum clash counts by discipline pair)
  const discCounts = {};
  filtered.forEach(g => {
    const pair = (g.disciplineA && g.disciplineB)
      ? `${g.disciplineA}×${g.disciplineB}`
      : (g.disciplines?.[0] ?? 'UNKNOWN');
    discCounts[pair] = (discCounts[pair] ?? 0) + (g.clashes?.length ?? g.count ?? g.clashCount ?? 0);
  });
  const chips = el('clash-disc-chips');
  chips.innerHTML = Object.entries(discCounts).map(([d, n]) => {
    const headDisc = d.split('×')[0];
    return `<span class="clash-disc-chip" style="background:${DISC_COLORS_HEX[headDisc] ?? '#9ca3af'}" data-disc="${d}">${d} ${n}</span>`;
  }).join('');
  chips.classList.remove('hidden');

  let totalClashes = 0;
  filtered.forEach(g => {
    const count = g.clashes?.length ?? g.count ?? g.clashCount ?? 0;
    totalClashes += count;

    // Hierarchy breadcrumb from `groupingValues` (Stage 3 — matches ACC UI labels)
    const breadcrumb = Array.isArray(g.groupingValues) && g.groupingValues.length
      ? g.groupingValues.map(v => `<span>${escapeHtml(String(v))}</span>`).join('<span class="cg-bc-sep">›</span>')
      : '';

    // Discipline pair badge (Stage 3 inference)
    const pairBadge = (g.disciplineA || g.disciplineB)
      ? `<span class="cg-pair" title="Discipline pair (inferred)">${g.disciplineA ?? '?'} × ${g.disciplineB ?? '?'}</span>`
      : '';

    // Auto-assign candidate (Stage 5)
    const autoBadge = g.autoAssignCandidate
      ? `<span class="cg-badge cg-badge-auto" title="High priority — eligible for automatic Issue creation">🤖 auto</span>`
      : '';

    // Collapsed-from indicator (Stage 4)
    const collapsedBadge = Array.isArray(g.collapsedFrom) && g.collapsedFrom.length
      ? `<span class="cg-badge cg-badge-collapsed" title="Rolled up from ${g.collapsedFrom.length} sub-groups by Family:Type">⤴ ${g.collapsedFrom.length}</span>`
      : '';

    // Verbatim-from-ACC marker (Stage 3)
    const verbatimMark = g.nameSource === 'api'
      ? `<span class="cg-verbatim" title="Group name read verbatim from the Forma Clashes panel">∥</span>`
      : '';

    const div = document.createElement('div');
    div.className = 'clash-group-item';
    div.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="cg-name" title="${escapeHtml(g.name ?? '')}">${verbatimMark}${escapeHtml(g.name ?? 'Unnamed Group')}</span>
        <span class="cg-count" title="${count} clash${count === 1 ? '' : 'es'} in this group">${count}</span>
      </div>
      ${breadcrumb ? `<div class="cg-breadcrumb">${breadcrumb}</div>` : ''}
      <div class="cg-meta">
        ${pairBadge}
        ${g.testName ? `<span class="cg-test" title="Source clash test">${escapeHtml(g.testName)}</span>` : ''}
        ${autoBadge}
        ${collapsedBadge}
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
  const viewer = _viewerState.viewer;
  const THREE = Autodesk.Viewing.Private.THREE;
  const SCENE = 'clash-markers';

  if (viewer.overlays.hasScene(SCENE)) {
    viewer.overlays.clearScene(SCENE);
  } else {
    viewer.overlays.addScene(SCENE);
  }

  const clashes = group.clashes ?? [];
  const members = Array.isArray(group.members) ? group.members : [];
  let hasPoints = false;
  const positions = [];
  const dbIds = new Set();

  // 1. Per-clash markers
  clashes.forEach(clash => {
    if (clash?.objectIdA != null) dbIds.add(clash.objectIdA);
    if (clash?.objectIdB != null) dbIds.add(clash.objectIdB);
    if (!clash.point) return;
    hasPoints = true;
    positions.push(new THREE.Vector3(clash.point.x, clash.point.y, clash.point.z));
    const geo = new THREE.SphereGeometry(0.2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.85 });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(clash.point.x, clash.point.y, clash.point.z);
    viewer.overlays.addMesh(sphere, SCENE);
  });

  // 2. From `members` array (returned by GET /modelsets/{m}/clashes/grouped)
  members.forEach(m => {
    if (m?.objectId != null) dbIds.add(m.objectId);
  });

  // 3. Isolate the involved objects so the user can SEE what's clashing
  if (dbIds.size > 0) {
    try {
      viewer.isolate([...dbIds]);
      viewer.fitToView([...dbIds]);
    } catch (_) {
      // isolate fails silently if model not fully loaded — keep camera markers
    }
  } else if (hasPoints && positions.length) {
    // No dbIds → fall back to clash-point bounding box
    const box = new THREE.Box3().setFromPoints(positions);
    viewer.navigation.fitBounds(false, box, true);
  }

  // 4. Detail panel — show WHAT clashed, WHERE, and WHY
  renderClashGroupDetailPanel(group, [...dbIds]);

  toast(`Showing ${clashes.length || members.length || group.clashCount || 0} clash(es) — ${group.name ?? 'group'}`);
}

/**
 * Render a side-panel detail card for the active clash group.
 * Shows the breadcrumb, discipline pair, test source, member object IDs,
 * and any auto-assign / collapsed-from state.
 */
function renderClashGroupDetailPanel(group, dbIds) {
  const host = el('viewer-clash-detail');
  if (!host) return; // detail panel not present yet — graceful no-op

  const breadcrumb = Array.isArray(group.groupingValues) && group.groupingValues.length
    ? group.groupingValues.map(v => escapeHtml(String(v))).join(' › ')
    : '(no hierarchy reported)';

  const count = group.clashCount ?? group.count ?? group.clashes?.length ?? 0;
  const memberCount = Array.isArray(group.members) ? group.members.length : (dbIds?.length ?? 0);

  host.innerHTML = `
    <div class="space-y-2 p-3 text-xs">
      <div class="flex items-center justify-between">
        <div class="font-semibold text-slate-100 truncate" title="${escapeHtml(group.name ?? '')}">
          ${group.nameSource === 'api' ? '<span class="cg-verbatim" title="Verbatim from Forma">∥</span>' : ''}
          ${escapeHtml(group.name ?? 'Unnamed Group')}
        </div>
        <span class="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 font-mono">${count} 💥</span>
      </div>
      <div class="text-slate-400 leading-snug">
        <div class="text-slate-500 uppercase text-[10px] tracking-wide mb-0.5">Hierarchy</div>
        <div class="text-amber-300 font-mono">${breadcrumb}</div>
      </div>
      ${(group.disciplineA || group.disciplineB) ? `
      <div class="text-slate-400">
        <div class="text-slate-500 uppercase text-[10px] tracking-wide mb-0.5">Disciplines</div>
        <div><b>${group.disciplineA ?? '?'}</b> vs <b>${group.disciplineB ?? '?'}</b></div>
      </div>` : ''}
      ${group.testName ? `
      <div class="text-slate-400">
        <div class="text-slate-500 uppercase text-[10px] tracking-wide mb-0.5">Source clash test</div>
        <div class="font-mono">${escapeHtml(group.testName)}</div>
      </div>` : ''}
      <div class="text-slate-400">
        <div class="text-slate-500 uppercase text-[10px] tracking-wide mb-0.5">Objects involved</div>
        <div>${memberCount} element${memberCount === 1 ? '' : 's'} ${dbIds.length ? `<span class="text-slate-500">(isolated in viewer)</span>` : ''}</div>
      </div>
      ${group.autoAssignCandidate ? `
      <div class="bg-emerald-900/40 border border-emerald-700/50 rounded px-2 py-1.5">
        <div class="text-emerald-300 font-medium">🤖 Auto-assign candidate</div>
        <div class="text-emerald-400/80 text-[11px]">Priority within threshold — will be linked to a new ACC Issue when the workflow runs with <code>autoAssign.enabled=true</code>.</div>
      </div>` : ''}
      ${Array.isArray(group.collapsedFrom) && group.collapsedFrom.length ? `
      <div class="bg-blue-900/40 border border-blue-700/50 rounded px-2 py-1.5">
        <div class="text-blue-300 font-medium">⤴ Rolled up from ${group.collapsedFrom.length} sub-groups</div>
        <div class="text-blue-400/80 text-[11px]">Collapsed by Family:Type to keep the report readable.</div>
      </div>` : ''}
    </div>`;
  host.classList.remove('hidden');
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
// Issue Pushpin Markers in Viewer
// ─────────────────────────────────────────────────────────────────────────────

const ISSUE_OVERLAY_SCENE  = 'issue-markers';
const ISSUE_MARKER_COLOR   = 0xf59e0b;   // amber — distinct from clash red
const ISSUE_MARKER_RADIUS  = 0.25;

// Stored so we can navigate to issues from marker clicks
let _issuePushpins = [];
let _issueMarkersShown = false;

/**
 * Fetch issues that have 3D pushpin locations and display them as amber
 * spheres in the viewer. Called automatically after each model load and
 * after a view is loaded. Results are filtered to the currently loaded models.
 */
async function showIssuePushpinsInViewer() {
  if (!_viewerState.viewer || !_viewerState.loadedModels.length) return;
  const projectId = el('inp-project-id')?.value?.trim();
  if (!projectId) return;

  try {
    const qs = new URLSearchParams({ projectId });
    // Send loaded viewer URNs so the server can filter by linkedDocumentId
    const urns = _viewerState.loadedModels.map(m => m.urn).join(',');
    if (urns) qs.set('urns', urns);

    const data = await api('GET', `/api/issues/with-location?${qs}`);
    const issues = data?.issues ?? [];
    _issuePushpins = issues;

    if (!issues.length) return;
    _renderIssuePushpins(issues);
  } catch {
    // Silent — issue markers are best-effort
  }
}

function _renderIssuePushpins(issues) {
  if (!_viewerState.viewer) return;
  const THREE = Autodesk?.Viewing?.Private?.THREE;
  if (!THREE) return;

  if (_viewerState.viewer.overlays.hasScene(ISSUE_OVERLAY_SCENE)) {
    _viewerState.viewer.overlays.clearScene(ISSUE_OVERLAY_SCENE);
  } else {
    _viewerState.viewer.overlays.addScene(ISSUE_OVERLAY_SCENE);
  }

  issues.forEach(issue => {
    const { x, y, z } = issue.location;
    const geo  = new THREE.SphereGeometry(ISSUE_MARKER_RADIUS, 8, 8);
    const mat  = new THREE.MeshBasicMaterial({ color: ISSUE_MARKER_COLOR, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.userData = { issueId: issue.id, issueTitle: issue.title };
    _viewerState.viewer.overlays.addMesh(mesh, ISSUE_OVERLAY_SCENE);
  });

  _issueMarkersShown = true;
  toast(`Showing ${issues.length} issue location(s) in viewer`, 'info');
  updateIssuePushpinBadge();
}

function clearIssuePushpins() {
  if (!_viewerState.viewer) return;
  if (_viewerState.viewer.overlays.hasScene(ISSUE_OVERLAY_SCENE)) {
    _viewerState.viewer.overlays.clearScene(ISSUE_OVERLAY_SCENE);
  }
  _issueMarkersShown = false;
  updateIssuePushpinBadge();
}

function updateIssuePushpinBadge() {
  const badge = el('issue-marker-count');
  if (!badge) return;
  if (_issueMarkersShown && _issuePushpins.length) {
    badge.textContent = _issuePushpins.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/** Navigate viewer camera to a specific issue pushpin by id */
function flyToIssuePushpin(issueId) {
  if (!_viewerState.viewer) return;
  const issue = _issuePushpins.find(i => i.id === issueId);
  if (!issue) return;
  const THREE = Autodesk?.Viewing?.Private?.THREE;
  if (!THREE) return;
  const { x, y, z } = issue.location;
  const center = new THREE.Vector3(x, y, z);
  const box = new THREE.Box3(
    new THREE.Vector3(x - 3, y - 3, z - 3),
    new THREE.Vector3(x + 3, y + 3, z + 3),
  );
  _viewerState.viewer.navigation.fitBounds(false, box, true);
  toast(`Navigating to: ${issue.title ?? issue.identifier ?? 'issue'}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub — multi-project manager
// ─────────────────────────────────────────────────────────────────────────────

let _hubProjects = [];
let _hubFilter = 'all';
let _hubSort   = 'name';
let _hubProjectsLoaded = false; // true once successfully fetched at least once

// Auto-load hub projects silently (no UI spinner required — grid shows skeleton)
async function _autoLoadHubProjects() {
  const status = await api('GET', '/api/auth/status').catch(() => null);
  if (!status?.loggedIn) return; // not logged in yet
  loadHubProjects();
}

// Update the Connect tab "active project" card based on current inp-project-id
function _refreshConnectProjectCard() {
  const projectId   = el('inp-project-id')?.value?.trim() ?? '';
  const activeCard  = el('connect-active-project');
  const noProject   = el('connect-no-project');
  const nameEl      = el('connect-project-name');
  const idEl        = el('connect-project-id-display');

  if (!projectId) {
    activeCard?.classList.add('hidden');
    noProject?.classList.remove('hidden');
    return;
  }

  noProject?.classList.add('hidden');
  activeCard?.classList.remove('hidden');

  // Find display name from loaded projects
  const proj = _hubProjects.find(p => (p.id ?? '').replace(/^b\./, '') === projectId);
  if (nameEl) nameEl.textContent = proj?.attributes?.name ?? projectId;
  if (idEl)   idEl.textContent   = projectId;
}

async function loadHubProjects() {
  const btn = el('btn-load-hub-projects');
  const errorEl = el('hub-error');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
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

    // If hub ID was auto-discovered, persist it so future calls don't need to re-discover
    if (data?._hubId) {
      const currentAccId = el('inp-account-id')?.value?.trim();
      if (!currentAccId) {
        el('inp-account-id').value = data._hubId;
        try {
          await api('POST', '/api/config/env', { ACC_ACCOUNT_ID: data._hubId });
          if (State.config?.env) State.config.env.ACC_ACCOUNT_ID = data._hubId;
        } catch { /* non-critical */ }
      }
    }

    renderHubProjects(_hubProjects);

    const accCount   = _hubProjects.filter(p => (p.attributes?.projectType ?? '').toUpperCase().includes('ACC')).length;
    const otherCount = _hubProjects.length - accCount;
    el('hub-stat-total').textContent = _hubProjects.length;
    el('hub-stat-acc').textContent   = accCount;
    el('hub-stat-other').textContent = otherCount;

    const currentProjId = el('inp-project-id').value.trim();
    const current = _hubProjects.find(p => p.id?.replace(/^b\./, '') === currentProjId);
    el('hub-stat-active').textContent = current?.attributes?.name ?? 'None';

    _hubProjectsLoaded = true;
    _refreshConnectProjectCard();
    toast(`Loaded ${_hubProjects.length} project(s)`);
  } catch (err) {
    grid.innerHTML = '';
    errorEl.classList.remove('hidden');
    el('hub-error-msg').textContent = `Failed to load hub projects: ${err.message}`;
    el('hub-error-hint').textContent = err.status === 403
      ? 'Tip: Your APS app may not be authorized for this ACC hub. An ACC Account Admin needs to add your Client ID under Account Admin → Settings → Custom Integrations.'
      : err.status === 401
      ? 'Tip: Sign in with Autodesk on the Connect tab.'
      : '';
    toast('Failed to load hub projects', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
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

async function switchHubProject(projectId, projectName) {
  // Populate Connect-tab fields
  el('inp-project-id').value   = projectId;
  // For ACC v3, MC Container ID equals the Project ID
  el('inp-container-id').value = projectId;
  // Reset folder since it's project-specific
  el('inp-folder-urn').value   = '';
  el('folder-urn-row').classList.add('hidden');
  const folderTree = el('folder-tree');
  if (folderTree) folderTree.innerHTML = '';
  el('folder-tree-container')?.classList.add('hidden');
  const nameSpan = el('selected-folder-name');
  if (nameSpan) { nameSpan.textContent = 'No folder selected'; nameSpan.className = 'text-sm text-slate-500 flex-1 truncate'; }
  el('hub-stat-active').textContent = projectName;
  renderHubProjects(_hubProjects);
  _refreshConnectProjectCard();

  // Persist project + container IDs, then jump straight to coordination
  try {
    await api('POST', '/api/config/env', { ACC_PROJECT_ID: projectId, MC_CONTAINER_ID: projectId });
    if (State.config?.env) {
      State.config.env.ACC_PROJECT_ID  = projectId;
      State.config.env.MC_CONTAINER_ID = projectId;
    }
    toast(`"${projectName}" activated — loading coordination spaces…`);
    navigate('coordination');
    await loadCoordinationSpaces();
  } catch (err) {
    toast(`Switched to "${projectName}" — loading coordination…`, 'warn');
    navigate('coordination');
    await loadCoordinationSpaces().catch(() => {});
  }
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
  CIVIL: 'Civil / Site', INT: 'Interiors', TECH: 'Technology / ICT', UNKNOWN: 'Unknown',
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
        // Learn this name→discipline mapping for future auto-assignment
        _saveDiscPattern(m.name, newDisc);
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

const COORD_DISC_KEYS = ['ARCH','STRUCT','MECH','PLUMB','ELEC','FP','CIVIL','INT','TECH'];

// ─── Level filter state ────────────────────────────────────────────────────
const _levelFilter = {
  refModelId: null,   // ID of model being used as level reference
  level: null,        // selected level name (null = no filter)
  matchedIds: new Set(), // model IDs confirmed to contain this level
};

let _discSearchText = ''; // live search text for discipline assignment filter

async function loadCoordinationData() {
  el('coord-empty').classList.add('hidden');
  el('coord-sections').classList.add('hidden');

  try {
    const spaceId = getActiveCoordSpaceId();
    const [persisted, modelsResp, viewsResp] = await Promise.all([
      api('GET', '/api/coordination/assignments').catch(() => ({})),
      fetchCoordSpaceModels(),
      spaceId ? api('GET', `/api/mc/modelsets/${spaceId}/views`).catch(() => ({ data: [] })) : { data: [] }
    ]);

    _coordState.assignments      = persisted?.assignments      ?? {};
    _coordState.clashIncludes    = persisted?.clashIncludes    ?? [];
    _coordState.alignments       = persisted?.alignments       ?? {};
    _coordState.alignSnap        = persisted?.alignSnap        ?? 1.0;
    _coordState.modelDisciplines = persisted?.modelDisciplines ?? {};
    _coordState.models           = modelsResp ?? [];

    // Populate Views dropdown
    const vSel = el('sel-coord-view');
    if (vSel) {
      const views = viewsResp?.data ?? [];
      vSel.innerHTML = '<option value="">- select a view (optional) -</option>';
      for (const v of views) {
        vSel.add(new Option(v.name, v.id));
      }
      // Sync changes to viewer tab sel-view (MC views appear there with "mc:" prefix)
      vSel.addEventListener('change', () => {
        const rawId = vSel.value;
        const viewerSel = el('sel-view');
        if (!viewerSel || !rawId) return;
        const mcId = `mc:${rawId}`;
        if (viewerSel.querySelector(`option[value="${mcId}"]`)) {
          viewerSel.value = mcId;
          onViewSelected();
        }
      });
    }

    // Apply persisted overrides on top of guesses
    for (const m of _coordState.models) {
      const ud = getUserDiscipline(m);
      if (ud) m.discipline = ud;
    }

    if (!_coordState.models.length) {
      const hasSpace = !!getActiveCoordSpaceId();
      const emptyMsg = el('coord-empty').querySelector('p.text-slate-500');
      const emptyHint = el('coord-empty').querySelector('p.text-slate-400');
      if (hasSpace && emptyMsg) {
        emptyMsg.textContent = 'No model documents found in this coordination space';
        if (emptyHint) emptyHint.innerHTML = 'The coordination space returned 0 documents. Verify models have been added to the space in ACC, then click <strong>Refresh from Space</strong>.';
      }
      el('coord-empty').classList.remove('hidden');
      _coordState.loaded = true;
      return;
    }

    // Default clashIncludes: prefer discipline-assigned/detected models only.
    // This implements "Disciplines Only" as the default selection mode.
    if (!_coordState.clashIncludes.length) {
      const withDisc = _coordState.models.filter(m => {
        const disc = getUserDiscipline(m) || guessDiscFromName(m.name);
        return disc && disc !== 'UNKNOWN';
      });
      _coordState.clashIncludes = withDisc.length
        ? withDisc.map(m => m.id)
        : _coordState.models.map(m => m.id); // all models as fallback if none detected
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
  if (!modelSetId) return [];
  const containerId = el('inp-container-id').value.trim() || State.config?.env?.MC_CONTAINER_ID;
  const qs = new URLSearchParams({ modelSetId });
  if (containerId) qs.set('containerId', containerId);
  const data = await api('GET', `/api/mc/space-documents?${qs}`);
  return (data?.documents ?? []).map(d => ({
    id:         d.id,
    name:       d.name,
    rawUrn:     d.rawUrn,
    viewerUrn:  d.viewerUrn,
    discipline: guessDiscFromName(d.name),
    version:    d.version, // Ensure version is captured for view matching
  }));
}

async function loadViewIntoViewer() {
  const viewId  = el('sel-coord-view')?.value;
  const spaceId = getActiveCoordSpaceId();
  if (!viewId)  { toast('Select a view first', 'error'); return; }
  if (!spaceId) { toast('Select a Coordination Space first', 'error'); return; }

  const btn     = el('btn-load-view');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  // containerId is needed by buildMcClient on the server — pass it if we have it
  const containerId = el('inp-container-id')?.value?.trim() || State.config?.env?.MC_CONTAINER_ID || '';

  try {
    // Fetch view definition from MC API — v3 format uses definition[].lineageUrn
    const qs = new URLSearchParams({ modelSetId: spaceId });
    if (containerId) qs.set('containerId', containerId);
    const raw  = await api('GET', `/api/mc/modelsets/${spaceId}/views/${viewId}?${qs}`);
    // MC API may return the view wrapped: { modelSetView: {...} } or directly
    const view = raw?.modelSetView ?? raw;
    const viewName = view?.name ?? viewId;

    // Extract document identifiers: prefer v3 definition[].lineageUrn, fall back to modelIds
    const lineageUrns = (view?.definition ?? []).map(d => d.lineageUrn).filter(Boolean);
    const legacyIds   = view?.modelIds ?? view?.documentIds ?? [];
    const allRefs     = [...new Set([...lineageUrns, ...legacyIds])];

    // Fetch all documents in the coordination space to resolve viewerUrns
    const docsQs = new URLSearchParams({ modelSetId: spaceId });
    if (containerId) docsQs.set('containerId', containerId);
    const spaceResp = await api('GET', `/api/mc/space-documents?${docsQs}`);
    const docs = spaceResp?.documents ?? [];

    const targets = [];
    const seen    = new Set();

    const findDoc = (ref) => {
      const bare = ref.replace(/^urn:/i, '');
      // Extract lineage ID from urn:adsk.xxx:dm.lineage:{lineageId}
      const lineageIdMatch = ref.match(/dm\.lineage:([^?&:/]+)/);
      const lineageId = lineageIdMatch?.[1];
      return docs.find(d => {
        if (d.id === ref || d.id === bare) return true;
        if (d.rawUrn === ref || d.rawUrn === bare) return true;
        if (d.derivativeUrn === ref || d.derivativeUrn === bare) return true;
        if (d.lineageUrn && (d.lineageUrn === ref || d.lineageUrn.replace(/^urn:/i,'') === bare)) return true;
        if (d.rawUrn && d.rawUrn.includes(bare)) return true;
        if (bare && d.rawUrn && bare.includes(d.rawUrn.split('?')[0])) return true;
        // Match by lineage ID embedded in rawUrn as vf.{lineageId}
        if (lineageId && d.rawUrn && d.rawUrn.includes(lineageId)) return true;
        return false;
      });
    };

    for (const ref of allRefs) {
      const doc = findDoc(ref);
      if (doc?.viewerUrn && !seen.has(doc.viewerUrn)) {
        seen.add(doc.viewerUrn);
        targets.push({ name: doc.name, viewerUrn: doc.viewerUrn });
      }
    }

    // If no match from refs, load all docs (the view covers the full space)
    if (!targets.length) {
      for (const doc of docs) {
        if (doc.viewerUrn && !seen.has(doc.viewerUrn)) {
          seen.add(doc.viewerUrn);
          targets.push({ name: doc.name, viewerUrn: doc.viewerUrn });
        }
      }
    }

    if (!targets.length) {
      toast('No loadable models found in this view — models may not be translated yet in ACC', 'error');
      return;
    }

    toast(`Loading "${viewName}" — ${targets.length} model(s)…`);

    // Navigate to viewer tab and ensure the viewer is initialised
    navigate('viewer');

    // Sync selected view in viewer-tab sel-view to the same view (MC views have "mc:" prefix there)
    const viewerSel = el('sel-view');
    if (viewerSel && viewId) {
      const mcId = `mc:${viewId}`;
      if (viewerSel.querySelector(`option[value="${mcId}"]`)) {
        viewerSel.value = mcId;
        onViewSelected();
      }
    }

    if (!_viewerState.viewer) {
      // initViewerTab() was called by navigate(); wait for the viewer object to be ready
      await new Promise(resolve => {
        const t = setInterval(() => { if (_viewerState.viewer) { clearInterval(t); resolve(); } }, 200);
        setTimeout(() => { clearInterval(t); resolve(); }, 15_000);
      });
    }

    // Unload anything currently in the viewer
    if (_viewerState.viewer && _viewerState.loadedModels.length) {
      try {
        _viewerState.loadedModels.forEach(lm => _viewerState.viewer.unloadModel(lm.model));
      } catch (_) {}
      _viewerState.loadedModels = [];
      _viewerState.globalOffset = null;
    }

    // Load each model sequentially so the global offset propagates
    let loaded = 0;
    for (const t of targets) {
      try { await loadModelToViewer(t); loaded++; } catch (_) {}
    }

    if (loaded) {
      toast(`View "${viewName}" — ${loaded} model(s) loaded`);
      try {
        setTimeout(() => _viewerState.viewer?.fitToView?.(), 800);
      } catch (_) {}
    } else {
      toast('Models in view could not be loaded — check that derivatives are ready in ACC', 'error');
    }
  } catch (err) {
    toast('Failed to load view: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Load View'; }
  }
}

function renderCoordinationTab() {
  _refreshLevelRefSelect();
  // Auto-select ARCH model as level reference if none chosen yet
  if (!_levelFilter.refModelId) {
    const archId = _coordState.assignments['ARCH'];
    if (archId) {
      _levelFilter.refModelId = archId;
      const sel = el('sel-level-ref-model');
      if (sel) sel.value = archId;
      loadLevelOptions(archId);
    }
  }
  renderCoordDisciplineRows();
  renderCoordClashRows();
  renderCoordAlignRows();
}

function renderCoordDisciplineRows() {
  const host = el('coord-disc-rows');
  host.innerHTML = '';

  const searchText = _discSearchText.toLowerCase().trim();

  // Sort all models alphabetically — always show every model in discipline dropdowns;
  // the level filter only drives the level name picker, not which models appear here
  const allSorted = [..._coordState.models].sort((a, b) => a.name.localeCompare(b.name));

  for (const disc of COORD_DISC_KEYS) {
    const assignedId = _coordState.assignments[disc] ?? '';

    // Models that auto-match this discipline (guessed or learned)
    const isSuggested = (m) =>
      m.discipline === disc || _lookupLearnedDisc(m.name) === disc;

    // Apply search filter only (level filter does not narrow discipline dropdowns)
    const afterSearch = searchText
      ? allSorted.filter(m =>
          m.name.toLowerCase().includes(searchText) || m.id === assignedId)
      : allSorted;

    // Split into suggested (pinned first) and others
    const suggested = afterSearch.filter(m => isSuggested(m));
    const others    = afterSearch.filter(m => !isSuggested(m));

    const buildOpt = (m, star) => {
      const label = star ? `★ ${m.name}` : m.name;
      const suffix = star ? ' (suggested)' : '';
      return `<option value="${m.id}"${assignedId === m.id ? ' selected' : ''} title="${m.name}${suffix}">${label}</option>`;
    };

    const divider = (suggested.length && others.length)
      ? '<option disabled>──────────────────</option>' : '';

    const optHtml = [
      `<option value="">— unassigned —</option>`,
      ...suggested.map(m => buildOpt(m, true)),
      divider,
      ...others.map(m => buildOpt(m, false)),
    ].join('');

    const candidateCount = _coordState.models.filter(m => isSuggested(m)).length;
    const filteredCount = afterSearch.length;
    const countLabel = searchText
      ? `${filteredCount} shown`
      : (candidateCount ? `${candidateCount} suggested` : 'no suggestions');

    const row = document.createElement('div');
    row.className = 'coord-disc-row';
    row.innerHTML = `
      <div class="disc-dot flex-shrink-0" style="background:${DISC_COLOR[disc]}"></div>
      <div class="coord-disc-label">${DISC_LABEL[disc] ?? disc}</div>
      <select class="field-input text-sm flex-1 max-w-2xl" data-disc="${disc}">${optHtml}</select>
      <span class="text-xs text-slate-400 w-28 text-right whitespace-nowrap">${countLabel}</span>
    `;

    row.querySelector('select').addEventListener('change', e => {
      const id = e.target.value;
      if (id) {
        _coordState.assignments[disc] = id;
        const m = _coordState.models.find(x => x.id === id);
        if (m) {
          _saveDiscPattern(m.name, disc);
          // If ARCH is newly assigned and no level ref yet, pre-select it
          if (disc === 'ARCH' && !_levelFilter.refModelId) {
            _levelFilter.refModelId = id;
            _refreshLevelRefSelect();
            loadLevelOptions(id);
          }
        }
      } else {
        delete _coordState.assignments[disc];
      }
      saveCoordinationDebounced();
    });

    host.appendChild(row);
  }

  // No-match state
  if (searchText && !host.querySelector('select option[value]:not([value=""])')) {
    host.innerHTML = `<p class="text-sm text-slate-400 py-3 text-center">No models match "<em>${searchText}</em>"</p>`;
  }
}

// ─── Level filter helpers ──────────────────────────────────────────────────

function _refreshLevelRefSelect() {
  const sel = el('sel-level-ref-model');
  if (!sel) return;
  sel.innerHTML = '<option value="">— reference model (auto: ARCH) —</option>';
  for (const m of [..._coordState.models].sort((a, b) => a.name.localeCompare(b.name))) {
    const opt = new Option(m.name, m.id);
    if (m.id === _levelFilter.refModelId) opt.selected = true;
    sel.add(opt);
  }
}

async function loadLevelOptions(modelId) {
  const model = _coordState.models.find(m => m.id === modelId);
  if (!model?.viewerUrn) return;

  const pickSel  = el('sel-level-pick');
  const loadingEl = el('level-filter-loading');
  if (!pickSel) return;

  pickSel.disabled = true;
  pickSel.innerHTML = '<option value="">Loading…</option>';
  if (loadingEl) loadingEl.classList.remove('hidden');

  try {
    const data = await api('GET', `/api/models/levels?urn=${encodeURIComponent(model.viewerUrn)}`);
    const levels = data?.levels ?? [];
    pickSel.innerHTML = '<option value="">— pick a level —</option>';
    for (const lv of levels) pickSel.add(new Option(lv, lv));
    if (_levelFilter.level && levels.includes(_levelFilter.level)) {
      pickSel.value = _levelFilter.level;
    }
    pickSel.disabled = false;
    if (loadingEl) loadingEl.classList.add('hidden');
  } catch (err) {
    pickSel.innerHTML = '<option value="">— failed to load levels —</option>';
    pickSel.disabled = true;
    if (loadingEl) loadingEl.classList.add('hidden');
    toast('Could not load levels: ' + err.message, 'error');
  }
}

async function applyLevelFilter(levelName) {
  const badge  = el('level-filter-badge');
  const clearBtn = el('btn-level-filter-clear');

  if (!levelName) {
    _levelFilter.level = null;
    _levelFilter.matchedIds = new Set();
    if (badge)    { badge.textContent = ''; badge.classList.add('hidden'); }
    if (clearBtn) clearBtn.classList.add('hidden');
    renderCoordDisciplineRows();
    return;
  }

  _levelFilter.level = levelName;
  // For each model, check if it has this level via the API
  const matchedIds = new Set();
  const norm = levelName.trim().toLowerCase();

  // Fetch levels for all models in parallel (cap to avoid hammering API)
  const models = _coordState.models.filter(m => m.viewerUrn);
  const results = await Promise.allSettled(
    models.map(m =>
      api('GET', `/api/models/levels?urn=${encodeURIComponent(m.viewerUrn)}`)
        .then(d => ({ id: m.id, levels: d?.levels ?? [] }))
    )
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { id, levels } = r.value;
      if (levels.some(lv => lv.trim().toLowerCase() === norm)) matchedIds.add(id);
    }
  }

  _levelFilter.matchedIds = matchedIds;
  const count = matchedIds.size;

  if (badge) {
    badge.textContent = `${count} model${count === 1 ? '' : 's'} on "${levelName}"`;
    badge.classList.remove('hidden');
  }
  if (clearBtn) clearBtn.classList.remove('hidden');

  renderCoordDisciplineRows();
  if (!count) toast(`No models found with level "${levelName}"`, 'error');
  else toast(`Filtered to ${count} model(s) with level "${levelName}"`);
}

// ─── Create Model Set View ─────────────────────────────────────────────────

function openCreateViewModal() {
  const modal = el('create-view-modal');
  if (!modal) return;

  el('create-view-name').value = '';
  el('create-view-desc').value = '';

  const list = el('create-view-models');
  list.innerHTML = '';

  const discAssigned = new Set(Object.values(_coordState.assignments).filter(Boolean));
  const sorted = [..._coordState.models].sort((a, b) => a.name.localeCompare(b.name));

  for (const m of sorted) {
    const isDisc  = discAssigned.has(m.id);
    const label   = document.createElement('label');
    label.className = 'flex items-center gap-2 py-1 px-2 rounded hover:bg-slate-100 cursor-pointer';
    label.innerHTML = `
      <input type="checkbox" class="cv-model-cb" data-id="${m.id}" data-raw-urn="${m.rawUrn ?? ''}" ${isDisc ? 'checked' : ''}>
      <div class="disc-dot flex-shrink-0" style="background:${DISC_COLOR[m.discipline] ?? '#9ca3af'}"></div>
      <span class="truncate text-sm" title="${m.name}">${m.name}</span>
      ${isDisc ? '<span class="text-[10px] font-semibold text-emerald-600 ml-auto flex-shrink-0">DISC</span>' : ''}
    `;
    list.appendChild(label);
  }

  modal.classList.remove('hidden');
  el('create-view-name').focus();
}

function closeCreateViewModal() {
  el('create-view-modal')?.classList.add('hidden');
}

async function submitCreateView() {
  const name = el('create-view-name').value.trim();
  if (!name) { toast('View name is required', 'error'); return; }

  const spaceId = getActiveCoordSpaceId();
  if (!spaceId) { toast('No coordination space selected', 'error'); return; }

  const checked = [...document.querySelectorAll('.cv-model-cb:checked')];
  if (!checked.length) { toast('Select at least one model', 'error'); return; }

  const btn = el('btn-create-view-submit');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const documents = checked.map(cb => ({
      modelId: cb.dataset.id,
      rawUrn:  cb.dataset.rawUrn,
    }));

    const body = {
      name,
      description: el('create-view-desc').value.trim() || undefined,
      documents,
    };

    const result = await api('POST', `/api/mc/modelsets/${spaceId}/views`, body);
    const newViewId   = result?.id ?? result?.viewId;
    const newViewName = result?.name ?? name;

    toast(`View "${newViewName}" created`);
    closeCreateViewModal();

    // Refresh the view dropdown
    const viewsData = await api('GET', `/api/mc/modelsets/${spaceId}/views`).catch(() => ({ data: [] }));
    const vSel = el('sel-coord-view');
    if (vSel && viewsData?.data) {
      const cur = vSel.value;
      vSel.innerHTML = '<option value="">- select a view (optional) -</option>';
      for (const v of viewsData.data) vSel.add(new Option(v.name, v.id));
      if (newViewId) vSel.value = newViewId;
      else vSel.value = cur;
    }
  } catch (err) {
    toast('Failed to create view: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Create View';
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
  const subEl  = el('mc-ss-sub');
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
  const subEl   = el('mc-ss-sub');
  const data    = _mcState.searchSets;

  if (!data) return;

  // v3 unified-rules container: /rules returned instead of /searchsets
  if (data.apiSurface === 'rules') {
    if (subEl) subEl.textContent = 'v3 clash rules document for this coordination space.';
    const rules = data.rules;
    if (!rules) {
      listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">Rules document returned no data.</p>';
      return;
    }
    const docKeys  = Object.keys(rules.documentRules ?? {});
    const fileKeys = Object.keys(rules.fileRules ?? {});
    const total    = docKeys.length + fileKeys.length;
    countEl.textContent = `${total} rule${total !== 1 ? 's' : ''}`;
    countEl.classList.toggle('hidden', total === 0);

    const clashInfo = `clashType: ${rules.clashType ?? '—'}, disabled: ${!!rules.clashDisabled}`;
    const docRows = docKeys.map(k => `
      <div class="mc-row">
        <div class="mc-row-main"><span class="mc-row-name">${escapeHtml(k)}</span><span class="mc-row-sub">document rule</span></div>
        <div class="mc-row-meta"><span class="mc-badge">Doc</span></div>
      </div>`).join('');
    const fileRows = fileKeys.map(k => `
      <div class="mc-row">
        <div class="mc-row-main"><span class="mc-row-name">${escapeHtml(k)}</span><span class="mc-row-sub">file rule</span></div>
        <div class="mc-row-meta"><span class="mc-badge">File</span></div>
      </div>`).join('');

    listEl.innerHTML = `
      <div class="mc-row" style="background:#f0f9ff;border-bottom:1px solid #bae6fd">
        <div class="mc-row-main">
          <span class="text-xs text-blue-700 font-medium">v3 rules model — ${clashInfo}</span>
        </div>
      </div>
      ${total === 0
        ? '<p class="text-slate-400 text-sm text-center py-4">Rules document exists but contains no rules yet. Use <strong>Import from Library</strong> to populate.</p>'
        : docRows + fileRows}`;
    return;
  }

  // Legacy /searchsets response
  const sets = data?.data?.searchSets ?? data?.data?.data ?? data?.data ?? (Array.isArray(data?.data) ? data.data : []);

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
    ${groups.slice(0, 100).map((g, gi) => {
      const sev   = (g.severity ?? g.clashSeverity ?? 'none').toLowerCase();
      const count = g.clashCount ?? g.count ?? '';
      const name  = _resolveGroupName(g, gi);
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

  listEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  groups.slice(0, 200).forEach((g, gi) => {
    const cnt  = g.clashCount ?? g.count ?? g.clashes?.length ?? 0;
    const disc = [g.disciplineA, g.disciplineB].filter(Boolean).join(' × ') || (g.disciplines ?? []).join(' × ') || '';
    const breadcrumb = Array.isArray(g.groupingValues) && g.groupingValues.length
      ? g.groupingValues.map(v => escapeHtml(String(v))).join(' › ')
      : '';
    const autoBadge = g.autoAssignCandidate
      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200" title="High priority — auto-assign candidate">🤖 auto</span>`
      : '';
    const collapsedBadge = Array.isArray(g.collapsedFrom) && g.collapsedFrom.length
      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200" title="Rolled up from ${g.collapsedFrom.length} sub-groups">⤴ ${g.collapsedFrom.length}</span>`
      : '';
    const verbatimMark = g.nameSource === 'api'
      ? `<span class="text-slate-400 text-xs mr-1" title="Name verbatim from Forma">∥</span>`
      : '';
    const prov = (g.provenance?.source ?? '');
    const provBadge = prov === 'synthetic-discipline-pair'
      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200" title="Placeholder — no real clashes returned">synthetic</span>`
      : prov === 'legacy-fallback'
      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200" title="Client-grouped fallback">legacy</span>`
      : '';

    const row = document.createElement('div');
    row.className = 'mc-group-row';
    row.innerHTML = `
      <div>
        <div class="flex items-center gap-1 flex-wrap">
          ${verbatimMark}<span class="mc-group-name">${escapeHtml(_resolveGroupName(g, gi))}</span>
        </div>
        ${breadcrumb ? `<div class="text-xs text-amber-700 font-mono mt-0.5">${breadcrumb}</div>` : ''}
        ${g.testName ? `<span class="mc-row-sub">${escapeHtml(g.testName)}</span>` : ''}
        <div class="flex flex-wrap gap-1 mt-1">${autoBadge}${collapsedBadge}${provBadge}</div>
      </div>
      <span class="text-xs text-slate-500 self-start">${escapeHtml(disc)}</span>
      <span class="text-xs text-slate-600 self-start">${cnt !== 0 ? cnt : '—'}</span>
    `;
    fragment.appendChild(row);
  });
  listEl.appendChild(fragment);
  if (groups.length > 200) {
    const more = document.createElement('p');
    more.className = 'text-xs text-slate-400 px-2 py-1';
    more.textContent = `… and ${groups.length - 200} more groups`;
    listEl.appendChild(more);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clashes tab — view MC clash groups, apply templates, push as ACC Issues
// ─────────────────────────────────────────────────────────────────────────────

const _clashesState = {
  loaded: false,
  groups: [],           // flat list of clash group objects (all tests combined)
  tests: [],            // list of { id, name } for the filter dropdown
  templates: [],        // loaded from /api/config/clash-issue-templates
  selected: new Set(),  // set of group IDs currently checked
  assignments: {},      // groupId → { company, assignee, dueDate, title }
  filterTestId: '',
  filterText: '',
  companies: [],        // { id, name, trade } from ACC hub
  members: [],          // { id, name, email } from ACC project
  spaceModels: [],      // { name, viewerUrn, lineageUrn } from space-documents
  levels: [],           // string[] — level names from last-loaded model
};

// ── Naming engine ─────────────────────────────────────────────────────────────

function _abbrevLevel(s = '') {
  const m = s.match(/level\s*(\d+)/i);
  if (m) return 'L' + m[1].padStart(2, '0');
  if (/ground/i.test(s)) return 'GF';
  if (/roof/i.test(s))   return 'RF';
  if (/mezz/i.test(s))   return 'MEZ';
  const bm = s.match(/basement\s*(\d*)/i);
  if (bm) return 'B' + (bm[1] || '1').padStart(2, '0');
  return s.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'L';
}

const _DISC_LETTER = {
  ARCH:'A', ARCHITECTURE:'A', ARCHITECTURAL:'A',
  STRUCT:'S', STRC:'S', STRUCTURE:'S', STRUCTURAL:'S',
  MECH:'M', MECHANICAL:'M', MEP:'M',
  PLUMB:'P', PLUMBING:'P',
  ELEC:'E', ELECTRICAL:'E',
  FP:'F', FIRE:'F',
  CIVIL:'C', INT:'I', INTERIOR:'I', HVAC:'H',
};

function _abbrevTest(name = '') {
  return name.split(/\s+vs\.?\s+/i).map(p => {
    const k = p.trim().toUpperCase().replace(/\s+/g, '');
    return _DISC_LETTER[k] ?? p.trim().slice(0, 2).toUpperCase();
  }).join('_vs_');
}

function _abbrevSel(s = '') {
  const words = s.trim().split(/\s+/);
  if (words.length > 1) return words.map(w => w[0]).join('').toUpperCase().slice(0, 5);
  return s.toUpperCase().replace(/[AEIOU]/g, '').slice(0, 4) || s.slice(0, 3).toUpperCase();
}

function _applyNamingPattern(patternId, ctx, customPattern) {
  const L   = _abbrevLevel(ctx.level || '');
  const T   = _abbrevTest(ctx.testName || '');
  const A   = _abbrevSel(ctx.selA || '');
  const B   = _abbrevSel(ctx.selB || '');
  const D   = (ctx.discipline || '').toUpperCase().slice(0, 4) || 'UNK';
  const seq = String(ctx.sequence || 1).padStart(3, '0');

  switch (patternId) {
    case 'level-test-sel': {
      const parts = [];
      if (L) parts.push(L);
      if (T) parts.push(T);
      if (A && B) parts.push(`${A}vs${B}`);
      else if (A) parts.push(A);
      return parts.join('_') || 'Clash';
    }
    case 'test-disc-seq': {
      const parts = [];
      if (T) parts.push(T);
      if (D && D !== 'UNK') parts.push(D);
      parts.push(seq);
      return parts.join('_');
    }
    case 'custom': {
      return (customPattern || '{T}_{seq}')
        .replace(/\{L\}/g, L)
        .replace(/\{T\}/g, T)
        .replace(/\{A\}/g, A)
        .replace(/\{B\}/g, B)
        .replace(/\{D\}/g, D)
        .replace(/\{seq\}/g, seq);
    }
    default:
      return [L, T].filter(Boolean).join('_') || 'Clash';
  }
}

function _namingPreview(patternId, customPattern) {
  return _applyNamingPattern(patternId, {
    level: 'Level 1', testName: 'ARCH vs STRC',
    selA: 'Walls', selB: 'Conduits',
    discipline: 'STRUCT', sequence: 3,
  }, customPattern);
}

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadClashGroups() {
  const btn = el('btn-load-clash-groups');
  btn.disabled = true; btn.textContent = 'Loading…';
  el('clashes-error').classList.add('hidden');

  const list = el('clashes-list');
  list.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Loading clash groups…</div>';

  try {
    // Load templates first (silent)
    if (!_clashesState.templates.length) await _loadClashTemplates();

    const modelSetId = getActiveCoordSpaceId();
    if (!modelSetId) {
      list.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Select a Coordination Space on the Coordination tab first</div>';
      return;
    }

    // Fetch clash tests to populate the filter dropdown
    let tests = [];
    try {
      const tr = await api('GET', `/api/mc/clash-tests?modelSetId=${encodeURIComponent(modelSetId)}`);
      tests = tr?.tests ?? tr?.data ?? (Array.isArray(tr) ? tr : []);
    } catch (_) {}
    _clashesState.tests = tests;
    _populateTestFilter(tests);

    // Build a testId→name lookup for enriching groups below
    const testNameById = Object.fromEntries(tests.map(t => [t.id ?? t.testId ?? t.clashTestId, t.name ?? t.id ?? t.testId]));

    const groups = [];

    // PRIMARY: model-set-wide grouped clashes endpoint (Stage 3 data — all tests, all groups)
    // This is the same source the workflow uses; returns groups with groupingValues, name, etc.
    let primaryOk = false;
    try {
      const r = await api('GET', `/api/mc/clash-groups?modelSetId=${encodeURIComponent(modelSetId)}`);
      const raw = r?.groups ?? r?.clashGroups ?? r?.data ?? (Array.isArray(r) ? r : []);
      if (raw.length) {
        raw.forEach(g => {
          const tid = g.clashTestId ?? g.testId ?? g._testId;
          groups.push({ ...g, _testId: tid ?? '', _testName: testNameById[tid] ?? tid ?? '', _type: 'grouped' });
        });
        primaryOk = true;
      }
    } catch (_) {}

    // SECONDARY: per-test assigned (linked to ACC Issues) and closed (resolved) groups
    // These complement the primary source with status/linkage info the grouped endpoint omits
    for (const test of tests) {
      const testId = test.id ?? test.testId ?? test.clashTestId;
      if (!testId) continue;
      try {
        const r = await api('GET', `/api/mc/clash-groups/assigned?testId=${encodeURIComponent(testId)}&modelSetId=${encodeURIComponent(modelSetId)}`);
        const grps = r?.groups ?? r?.data ?? r?.clashGroups ?? (Array.isArray(r) ? r : []);
        // Merge: if a group already exists from primary source, enrich its _type; else add it
        grps.forEach(g => {
          const gId = g.id ?? g.groupId ?? g.clashGroupId;
          const existing = gId ? groups.find(x => (x.id ?? x.groupId ?? x.clashGroupId) === gId) : null;
          if (existing) { existing._type = 'assigned'; }
          else { groups.push({ ...g, _testId: testId, _testName: test.name ?? testId, _type: 'assigned' }); }
        });
      } catch (_) {}
      try {
        const r = await api('GET', `/api/mc/clash-groups/closed?testId=${encodeURIComponent(testId)}&modelSetId=${encodeURIComponent(modelSetId)}`);
        const grps = r?.groups ?? r?.data ?? r?.clashGroups ?? (Array.isArray(r) ? r : []);
        grps.forEach(g => {
          const gId = g.id ?? g.groupId ?? g.clashGroupId;
          const existing = gId ? groups.find(x => (x.id ?? x.groupId ?? x.clashGroupId) === gId) : null;
          if (existing) { existing._type = 'closed'; }
          else { groups.push({ ...g, _testId: testId, _testName: test.name ?? testId, _type: 'closed' }); }
        });
      } catch (_) {}
    }

    // FALLBACK: if both primary and per-test sources returned nothing, try model-set-wide assigned
    if (!groups.length) {
      try {
        const r = await api('GET', `/api/mc/clash-groups/assigned?modelSetId=${encodeURIComponent(modelSetId)}`);
        const grps = r?.groups ?? r?.data ?? (Array.isArray(r) ? r : []);
        grps.forEach(g => groups.push({ ...g, _type: 'assigned' }));
      } catch (_) {}
    }

    _clashesState.groups = groups;
    _clashesState.selected.clear();
    _clashesState.loaded = true;
    renderClashGroupsList();

    const badge = el('badge-clashes');
    badge.textContent = groups.length;
    badge.classList.toggle('hidden', !groups.length);

    if (!groups.length) {
      list.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">No clash groups found. Run coordination clash tests first, then return here.</div>';
    }
  } catch (err) {
    list.innerHTML = '';
    el('clashes-error').classList.remove('hidden');
    el('clashes-error-msg').textContent = `Failed to load clash groups: ${err.message}`;
    el('clashes-error-hint').textContent = err.status === 403
      ? 'Tip: Sign in with a 3-legged service account on the Connect tab.'
      : err.status === 404
      ? 'Tip: No clash data found for this coordination space.'
      : '';
  } finally {
    btn.disabled = false; btn.textContent = 'Load Clash Groups';
  }
}

function _populateTestFilter(tests) {
  const sel = el('sel-clashes-test');
  sel.innerHTML = '<option value="">All Clash Tests</option>';
  tests.forEach(t => {
    const id   = t.id ?? t.testId ?? t.clashTestId;
    const name = t.name ?? id;
    sel.add(new Option(name, id));
  });
}

function _filteredGroups() {
  let groups = _clashesState.groups;
  if (_clashesState.filterTestId) {
    groups = groups.filter(g => g._testId === _clashesState.filterTestId);
  }
  if (_clashesState.filterText) {
    const q = _clashesState.filterText.toLowerCase();
    groups = groups.filter((g, gi) =>
      _resolveGroupName(g, gi).toLowerCase().includes(q) ||
      (g._testName ?? '').toLowerCase().includes(q)
    );
  }
  return groups;
}

function _isGuidOrBase64(str) {
  if (!str) return true;
  const s = str.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (s.length >= 20 && /^[A-Za-z0-9+/=_-]+$/.test(s) && !s.includes(' ')) return true;
  return false;
}

function _resolveGroupName(g, idx) {
  const raw = g.name ?? g.groupName ?? '';
  if (!raw || _isGuidOrBase64(raw)) {
    const testName = g._testName ?? '';
    return testName ? `${testName} · Group ${idx + 1}` : `Group ${idx + 1}`;
  }
  return raw;
}

// ─── Smart Clash Grouping (Sherlock/Distill-style) ────────────────────────────

const _smartGroupState = {
  groups: [],   // derived smart groups
  raw: [],      // raw clashes from the test
};

// Determine clash severity classification: 'real' | 'soft' | 'interface'
function _classifyClash(c) {
  const dist     = c.distance ?? c.penetrationDepth ?? c.clearance ?? null;
  const status   = (c.status ?? c.clashStatus ?? '').toLowerCase();
  const type     = (c.clashType ?? c.type ?? '').toLowerCase();

  // Soft / duplicate: zero or negative penetration, or explicitly soft
  if (type === 'soft' || type === 'clearance') return 'soft';
  if (status === 'approved' || status === 'resolved') return 'interface';
  if (dist !== null && dist <= 0) return 'soft';

  // Valid interface: structural member connections (beam/column touching)
  const a = (c.elementACategory ?? c.categoryA ?? c.objectAName ?? '').toLowerCase();
  const b = (c.elementBCategory ?? c.categoryB ?? c.objectBName ?? '').toLowerCase();
  const structPairs = ['beam', 'column', 'brace', 'footing', 'slab', 'wall', 'plate'];
  const aIsStruct = structPairs.some(p => a.includes(p));
  const bIsStruct = structPairs.some(p => b.includes(p));
  if (aIsStruct && bIsStruct) return 'interface';

  return 'real';
}

// Extract a short element category label from a clash element name/category
function _shortCategory(name = '') {
  const n = name.toLowerCase();
  if (n.includes('duct'))      return 'Duct';
  if (n.includes('pipe'))      return 'Pipe';
  if (n.includes('conduit'))   return 'Conduit';
  if (n.includes('cable'))     return 'Cable Tray';
  if (n.includes('beam'))      return 'Beam';
  if (n.includes('column'))    return 'Column';
  if (n.includes('wall'))      return 'Wall';
  if (n.includes('slab'))      return 'Slab';
  if (n.includes('stair'))     return 'Stair';
  if (n.includes('handrail') || n.includes('railing')) return 'Railing';
  if (n.includes('sprink') || n.includes('fire')) return 'FP Pipe';
  if (n.includes('equipment') || n.includes('equip')) return 'Equipment';
  if (n.includes('fitting'))   return 'Fitting';
  if (n.includes('hanger'))    return 'Hanger';
  // Fall back to up to 2 words capitalized
  const words = name.replace(/[^a-zA-Z\s]/g, ' ').trim().split(/\s+/).slice(0, 2);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Element';
}

// Build a smart group name: "L05 · MECH vs STRC · Pipe vs Beam"
function _buildSmartGroupName(levelAbbrev, testName, catA, catB) {
  const parts = [];
  if (levelAbbrev) parts.push(levelAbbrev);
  // Test name gives the discipline pair (already formatted as "ARCH vs STRC")
  const testPart = testName ? _abbrevTest(testName) || testName : '';
  if (testPart) parts.push(testPart);
  if (catA && catB && catA !== catB) parts.push(`${catA} / ${catB}`);
  else if (catA) parts.push(catA);
  return parts.join(' · ') || 'Clash Group';
}

async function runSmartGroupAnalysis() {
  const testSel = el('sel-clashes-test');
  const modelSetId = getActiveCoordSpaceId();

  if (!modelSetId) { toast('Select a Coordination Space first', 'error'); return; }

  const panel = el('smart-group-panel');
  const listEl = el('smart-group-list');
  const statsEl = el('smart-group-stats');
  const btn = el('btn-smart-group');
  const countEl = el('smart-group-count');

  panel.classList.remove('hidden');
  listEl.innerHTML = '<div class="p-8 text-center text-purple-400 text-sm">Analyzing clashes…</div>';
  statsEl.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Analyzing…';

  try {
    // Determine which tests to analyze
    const testId   = testSel?.value ?? '';
    const tests    = testId
      ? [_clashesState.tests.find(t => (t.id ?? t.testId) === testId)].filter(Boolean)
      : _clashesState.tests.slice(0, 5); // cap at 5 tests to avoid hammering API

    if (!tests.length && !_clashesState.tests.length) {
      // Load tests first
      const tr = await api('GET', `/api/mc/clash-tests?modelSetId=${encodeURIComponent(modelSetId)}`);
      const all = tr?.tests ?? (Array.isArray(tr) ? tr : []);
      _clashesState.tests = all;
      tests.push(...all.slice(0, 5));
    }

    if (!tests.length) {
      listEl.innerHTML = '<div class="p-6 text-center text-purple-400 text-sm">No clash tests found. Run tests in ACC first.</div>';
      return;
    }

    // Collect all raw clashes across tests
    const rawClashes = [];
    for (const test of tests) {
      const tid  = test.id ?? test.testId;
      const vi   = test.versionIndex ?? _mcState.clashTests?.versionIndex ?? '';
      if (!tid) continue;
      try {
        // Try to get individual clashes (raw clash items)
        const data = await api('GET',
          `/api/mc/clash-groups?modelSetId=${encodeURIComponent(modelSetId)}&testId=${encodeURIComponent(tid)}&versionIndex=${encodeURIComponent(vi)}`
        );
        const groups = data?.clashGroups ?? data?.data ?? data?.groups ?? (Array.isArray(data) ? data : []);
        for (const g of groups) {
          const clashes = g.clashes ?? [];
          for (const c of clashes) {
            rawClashes.push({ ...c, _testId: tid, _testName: test.name ?? tid, _groupId: g.id ?? g.groupId });
          }
          // If no individual clashes, treat the group itself as a clash item
          if (!clashes.length) {
            rawClashes.push({ ...g, _testId: tid, _testName: test.name ?? tid, _isSynthetic: true });
          }
        }
      } catch (_) {}
    }

    if (!rawClashes.length) {
      listEl.innerHTML = '<div class="p-6 text-center text-purple-400 text-sm">No clash data found. Groups may not have detailed clash items.</div>';
      return;
    }

    _smartGroupState.raw = rawClashes;

    // Group by: level + testId + catA + catB
    const buckets = new Map();
    for (const c of rawClashes) {
      const level  = c.level ?? c.levelName ?? c.floorName ?? '';
      const lAbbr  = level ? _abbrevLevel(level) : 'UNK';
      const catA   = _shortCategory(c.elementACategory ?? c.categoryA ?? c.objectAName ?? c.selectionAName ?? '');
      const catB   = _shortCategory(c.elementBCategory ?? c.categoryB ?? c.objectBName ?? c.selectionBName ?? '');
      const [sortedA, sortedB] = catA <= catB ? [catA, catB] : [catB, catA];
      const key = `${lAbbr}|${c._testId}|${sortedA}|${sortedB}`;

      if (!buckets.has(key)) {
        buckets.set(key, {
          key, lAbbr, level, testId: c._testId, testName: c._testName,
          catA: sortedA, catB: sortedB,
          clashes: [], real: 0, soft: 0, interface: 0,
        });
      }
      const bucket = buckets.get(key);
      bucket.clashes.push(c);
      const cls = _classifyClash(c);
      bucket[cls]++;
    }

    // Convert to array, sort by level then test
    const smartGroups = [...buckets.values()].sort((a, b) => {
      const la = parseInt(a.lAbbr.replace(/\D/g, '')) || 999;
      const lb = parseInt(b.lAbbr.replace(/\D/g, '')) || 999;
      if (la !== lb) return la - lb;
      return (a.testName ?? '').localeCompare(b.testName ?? '');
    });

    _smartGroupState.groups = smartGroups;

    const totalReal = smartGroups.reduce((s, g) => s + g.real, 0);
    const totalSoft = smartGroups.reduce((s, g) => s + g.soft, 0);
    const totalIface = smartGroups.reduce((s, g) => s + g.interface, 0);

    el('sg-count-real').textContent = totalReal;
    el('sg-count-soft').textContent = totalSoft;
    el('sg-count-interface').textContent = totalIface;
    statsEl.classList.remove('hidden');
    countEl.textContent = `· ${smartGroups.length} smart groups`;

    const hasSoft = totalSoft > 0;
    el('btn-smart-approve-all')?.classList.toggle('hidden', !hasSoft);

    // Render smart groups
    listEl.innerHTML = '';
    for (const g of smartGroups) {
      const name  = _buildSmartGroupName(g.lAbbr, g.testName, g.catA, g.catB);
      const total = g.clashes.length;
      const classification = g.real > 0 ? 'real' : g.soft > total / 2 ? 'soft' : 'interface';
      const COLOR = { real: '#ef4444', soft: '#f59e0b', interface: '#94a3b8' };
      const LABEL = { real: 'Real', soft: 'Soft/Dup', interface: 'Interface' };

      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 px-4 py-2.5 hover:bg-purple-50 transition-colors';
      row.innerHTML = `
        <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${COLOR[classification]}"></div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-slate-800 truncate">${escapeHtml(name)}</p>
          <p class="text-xs text-slate-500">${escapeHtml(g.testName)} · ${g.level || 'Unknown Level'}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${g.real      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">${g.real} real</span>` : ''}
          ${g.soft      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">${g.soft} soft</span>` : ''}
          ${g.interface ? `<span class="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">${g.interface} iface</span>` : ''}
          <span class="text-xs px-2 py-0.5 rounded-full font-semibold" style="background:${COLOR[classification]}22;color:${COLOR[classification]};border:1px solid ${COLOR[classification]}44">${LABEL[classification]}</span>
        </div>
      `;
      listEl.appendChild(row);
    }

    toast(`Smart analysis: ${smartGroups.length} groups from ${rawClashes.length} clashes`);
  } catch (err) {
    listEl.innerHTML = `<div class="p-6 text-center text-red-400 text-sm">${escapeHtml(err.message)}</div>`;
    toast('Smart group analysis failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Smart Group';
  }
}

function _getGroupPreviewName(g, tpl, seq) {
  if (!tpl) return null;
  const id = g.id ?? g.groupId ?? g.clashGroupId;
  if (_clashesState.assignments[id]?.title) return _clashesState.assignments[id].title;
  return _applyNamingPattern(tpl.namingPatternId, {
    level:      tpl.location,
    testName:   g._testName ?? '',
    selA:       g.selectionAName ?? g.modelAName ?? '',
    selB:       g.selectionBName ?? g.modelBName ?? '',
    discipline: g.discipline ?? g.disciplines?.[0] ?? '',
    sequence:   seq,
  }, tpl.customPattern);
}

function renderClashGroupsList() {
  const list = el('clashes-list');
  const groups = _filteredGroups();

  el('clashes-count').textContent = `${groups.length}${groups.length !== _clashesState.groups.length ? ` of ${_clashesState.groups.length}` : ''}`;

  if (!groups.length && _clashesState.loaded) {
    list.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">No groups match the current filter</div>';
    _updateSelectionBar();
    return;
  }

  // Get the active template for preview names
  const activeTplId = el('sel-apply-template')?.value;
  const activeTpl   = activeTplId ? _clashesState.templates.find(t => t.id === activeTplId) : null;

  list.innerHTML = '';
  let previewSeq = 0;
  groups.forEach((g, idx) => {
    const id        = g.id ?? g.groupId ?? g.clashGroupId ?? String(idx);
    const name      = _resolveGroupName(g, idx);
    const cnt       = g.clashCount ?? g.count ?? g.clashes?.length ?? '—';
    const testName  = g._testName ?? '';
    const type      = g._type ?? '';
    const assign    = _clashesState.assignments[id];
    const isChecked = _clashesState.selected.has(id);

    previewSeq++;
    const previewName = _getGroupPreviewName(g, activeTpl, previewSeq);

    const TYPE_COLOR = { grouped: '#8b5cf6', assigned: '#3b82f6', closed: '#64748b' };
    const typeColor  = TYPE_COLOR[type] ?? '#9ca3af';

    // Stage 3/4/5 enrichments
    const breadcrumb = Array.isArray(g.groupingValues) && g.groupingValues.length
      ? g.groupingValues.map(v => escapeHtml(String(v))).join(' › ')
      : '';
    const pairText = (g.disciplineA || g.disciplineB)
      ? `${g.disciplineA ?? '?'} × ${g.disciplineB ?? '?'}`
      : '';
    const autoBadge = g.autoAssignCandidate
      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200" title="High priority — eligible for automatic Issue creation">🤖 auto</span>`
      : '';
    const collapsedBadge = Array.isArray(g.collapsedFrom) && g.collapsedFrom.length
      ? `<span class="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200" title="Rolled up from ${g.collapsedFrom.length} sub-groups by Family:Type">⤴ ${g.collapsedFrom.length}</span>`
      : '';
    const verbatimMark = g.nameSource === 'api'
      ? `<span class="text-slate-400 text-xs" title="Group name read verbatim from the Forma Clashes panel">∥</span>`
      : '';

    const row = document.createElement('div');
    row.className = `px-3 py-2.5 hover:bg-slate-50 transition-colors${isChecked ? ' bg-blue-50' : ''}`;
    row.dataset.groupId = id;
    row.innerHTML = `
      <div class="flex items-start gap-2">
        <input type="checkbox" class="clash-group-chk mt-0.5 w-3.5 h-3.5 rounded flex-shrink-0 cursor-pointer"
          data-id="${id}" ${isChecked ? 'checked' : ''}/>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            ${verbatimMark}
            <span class="text-sm font-medium text-slate-800 truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="text-xs px-1.5 py-0.5 rounded font-mono"
              style="background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44">${type}</span>
            <span class="text-xs text-slate-400 font-mono">${cnt !== '—' ? cnt + ' 💥' : ''}</span>
            ${autoBadge}
            ${collapsedBadge}
          </div>
          ${breadcrumb ? `<p class="text-xs text-amber-700 font-mono truncate mt-0.5" title="Property hierarchy from the active Saved Clash Check">${breadcrumb}</p>` : ''}
          ${pairText || testName ? `<p class="text-xs text-slate-500 truncate mt-0.5">
            ${pairText ? `<span class="font-medium">${pairText}</span>` : ''}
            ${pairText && testName ? `<span class="text-slate-300 mx-1">·</span>` : ''}
            ${testName ? `${escapeHtml(testName)}` : ''}
          </p>` : ''}
          ${previewName && !assign ? `<p class="text-xs font-mono text-amber-600 mt-0.5" title="Issue name preview">→ ${escapeHtml(previewName)}</p>` : ''}
          ${assign ? `
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            ${assign.company ? `<span class="bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-1.5 py-0.5">🏢 ${escapeHtml(assign.company)}</span>` : ''}
            ${assign.assignee ? `<span class="bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5">👤 ${escapeHtml(assign.assignee)}</span>` : ''}
            ${assign.dueDate ? `<span class="bg-slate-50 text-slate-600 border border-slate-200 rounded px-1.5 py-0.5">📅 ${assign.dueDate}</span>` : ''}
            ${assign.title ? `<span class="bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 font-mono truncate max-w-48" title="${escapeHtml(assign.title)}">${escapeHtml(assign.title)}</span>` : ''}
          </div>` : ''}
        </div>
      </div>
    `;

    row.querySelector('.clash-group-chk').addEventListener('change', e => {
      if (e.target.checked) _clashesState.selected.add(id);
      else _clashesState.selected.delete(id);
      row.classList.toggle('bg-blue-50', e.target.checked);
      _updateSelectionBar();
    });

    list.appendChild(row);
  });

  _updateSelectionBar();
}

function _updateSelectionBar() {
  const n = _clashesState.selected.size;
  const bar = el('clashes-action-bar');
  const label = el('clashes-selected-label');
  bar.classList.toggle('hidden', n === 0);
  label.classList.toggle('hidden', n === 0);
  if (n > 0) {
    el('clashes-sel-count').textContent = `${n} group${n !== 1 ? 's' : ''} selected`;
    label.textContent = `${n} selected`;
  }
  // Sync select-all checkbox
  const all = el('chk-clashes-all');
  const groups = _filteredGroups();
  all.checked = groups.length > 0 && groups.every(g => {
    const id = g.id ?? g.groupId ?? g.clashGroupId;
    return _clashesState.selected.has(id);
  });
  all.indeterminate = !all.checked && n > 0;
}

// ── Templates ─────────────────────────────────────────────────────────────────

async function _loadClashTemplates() {
  try {
    const data = await api('GET', '/api/config/clash-issue-templates');
    _clashesState.templates = data?.templates ?? [];
    renderClashTemplatesList();
    _populateTemplateSelect();
  } catch (_) {}
}

function renderClashTemplatesList() {
  const host = el('templates-list');
  if (!_clashesState.templates.length) {
    host.innerHTML = '<div class="p-4 text-center text-slate-400 text-xs">No templates yet — click + New to create one</div>';
    return;
  }
  host.innerHTML = '';
  _clashesState.templates.forEach(t => {
    const preview = _namingPreview(t.namingPatternId, t.customPattern);
    const div = document.createElement('div');
    div.className = 'p-3 rounded-lg border border-slate-200 bg-slate-50 hover:border-brand/40 hover:bg-blue-50/50 transition-colors';
    div.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-slate-800">${escapeHtml(t.name)}</p>
          ${t.description ? `<p class="text-xs text-slate-500 truncate">${escapeHtml(t.description)}</p>` : ''}
          <div class="flex flex-wrap gap-1 mt-1.5 text-xs">
            ${t.companyName ? `<span class="bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-600">🏢 ${escapeHtml(t.companyName)}</span>` : ''}
            ${t.assigneeName ? `<span class="bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-600">👤 ${escapeHtml(t.assigneeName)}</span>` : ''}
            <span class="bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-600">📅 +${t.dueDateOffsetDays}d</span>
            <span class="bg-white border border-brand/30 rounded px-1.5 py-0.5 text-brand font-mono">${escapeHtml(preview)}</span>
          </div>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button class="btn-template-edit text-xs text-brand hover:text-brand-dark px-2 py-1 rounded hover:bg-blue-100" data-id="${t.id}">Edit</button>
          <button class="btn-template-del text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50" data-id="${t.id}">×</button>
        </div>
      </div>
    `;
    div.querySelector('.btn-template-edit').addEventListener('click', () => openTemplateEditor(t.id));
    div.querySelector('.btn-template-del').addEventListener('click', () => deleteTemplate(t.id));
    host.appendChild(div);
  });
}

function _populateTemplateSelect() {
  const sel = el('sel-apply-template');
  const current = sel.value;
  sel.innerHTML = '<option value="">— choose template —</option>';
  _clashesState.templates.forEach(t => sel.add(new Option(t.name, t.id)));
  if (current && sel.querySelector(`option[value="${current}"]`)) sel.value = current;
}

// ── Template editor modal ─────────────────────────────────────────────────────

// ── Discipline inference from model file name ─────────────────────────────────

function _inferDisciplineFromName(name = '') {
  const n = name.toUpperCase();
  const patterns = [
    { re: /[-_.](ARCH|ARCHITECTURAL|AR)[-_.]/, abbrev: 'A',  disc: 'ARCH' },
    { re: /[-_.](STRC|STRUCT|STR|ST)[-_.]/, abbrev: 'S',  disc: 'STRC' },
    { re: /[-_.](MECH|MEP|MEC|ME)[-_.]/, abbrev: 'M',  disc: 'MECH' },
    { re: /[-_.](PLMB|PLUMB|PL)[-_.]/, abbrev: 'P',  disc: 'PLMB' },
    { re: /[-_.](ELEC|ELE|EL)[-_.]/, abbrev: 'E',  disc: 'ELEC' },
    { re: /[-_.](FP|FIRE|FIREPROT)[-_.]/, abbrev: 'FP', disc: 'FP' },
    { re: /[-_.](CIVIL|CIV|CV)[-_.]/, abbrev: 'C',  disc: 'CIVIL' },
    { re: /[-_.](LSCP|LAND|LA)[-_.]/, abbrev: 'LA', disc: 'LSCP' },
    { re: /[-_.](INT|INTR|ID)[-_.]/, abbrev: 'I',  disc: 'INT' },
    // Single-letter with delimiter — check after multi-letter to avoid false positives
    { re: /[-_](A)[-_.]/, abbrev: 'A', disc: 'ARCH' },
    { re: /[-_](S)[-_.]/, abbrev: 'S', disc: 'STRC' },
    { re: /[-_](M)[-_.]/, abbrev: 'M', disc: 'MECH' },
    { re: /[-_](P)[-_.]/, abbrev: 'P', disc: 'PLMB' },
    { re: /[-_](E)[-_.]/, abbrev: 'E', disc: 'ELEC' },
    { re: /[-_](C)[-_.]/, abbrev: 'C', disc: 'CIVIL' },
  ];
  for (const { re, abbrev, disc } of patterns) {
    if (re.test(n)) return { abbrev, disc };
  }
  // Fallback: keyword anywhere in name
  if (n.includes('ARCH')) return { abbrev: 'A', disc: 'ARCH' };
  if (n.includes('STRU') || n.includes('STRC')) return { abbrev: 'S', disc: 'STRC' };
  if (n.includes('MECH') || n.includes('MEP')) return { abbrev: 'M', disc: 'MECH' };
  if (n.includes('ELEC')) return { abbrev: 'E', disc: 'ELEC' };
  if (n.includes('PLUM')) return { abbrev: 'P', disc: 'PLMB' };
  if (n.includes('FIRE') || n.includes('SPRINK')) return { abbrev: 'FP', disc: 'FP' };
  const stem = name.replace(/\.[^.]+$/, '').trim();
  return { abbrev: (stem.slice(0, 2) || '??').toUpperCase(), disc: 'UNKN' };
}

// ── Template editor data loaders ──────────────────────────────────────────────

async function _loadCompaniesForEditor() {
  if (_clashesState.companies.length) { _populateCompanyDatalist(_clashesState.companies); return; }
  el('companies-loading')?.classList.remove('hidden');
  try {
    // Pass accountId if available client-side; server falls back to ACC_ACCOUNT_ID env var
    const accountId = State.config?.env?.ACC_ACCOUNT_ID || el('inp-account-id')?.value?.trim() || '';
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const data = await api('GET', `/api/hub/companies${qs}`);
    _clashesState.companies = data?.companies ?? [];
    _populateCompanyDatalist(_clashesState.companies);
  } catch { /* non-critical */ } finally {
    el('companies-loading')?.classList.add('hidden');
  }
}

function _populateCompanyDatalist(companies) {
  const dl = el('company-suggestions');
  if (!dl) return;
  dl.innerHTML = '';
  companies.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    if (c.trade) opt.title = c.trade;
    dl.appendChild(opt);
  });
}

async function _loadMembersForEditor() {
  if (_clashesState.members.length) { _populateMemberDatalist(_clashesState.members); return; }
  try {
    // Pass projectId if available client-side; server falls back to ACC_PROJECT_ID env var
    const projectId = State.config?.env?.ACC_PROJECT_ID || el('inp-project-id')?.value?.trim() || '';
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const data = await api('GET', `/api/hub/members${qs}`);
    _clashesState.members = data?.members ?? [];
    _populateMemberDatalist(_clashesState.members);
  } catch { /* non-critical */ }
}

function _populateMemberDatalist(members) {
  const dl = el('member-suggestions');
  if (!dl) return;
  dl.innerHTML = '';
  members.forEach(m => {
    const opt = document.createElement('option');
    // Use "Name <email>" format so the datalist shows names but captures identity
    opt.value = m.name && m.email ? `${m.name} <${m.email}>` : (m.name ?? m.email ?? '');
    dl.appendChild(opt);
  });
}

async function _loadSpaceModelsForEditor() {
  // Prefer: already-loaded viewer models → coord clashIncludes → all space docs
  const loadedModels = _viewerState.loadedModels.map(lm => ({ name: lm.name, viewerUrn: lm.urn }));
  const coordModels  = _coordState.models
    .filter(m => m.viewerUrn && (!_coordState.clashIncludes.length || _coordState.clashIncludes.includes(m.id)))
    .map(m => ({ name: m.name, viewerUrn: m.viewerUrn }));

  if (loadedModels.length) {
    _clashesState.spaceModels = loadedModels;
    _populateModelPicker(_clashesState.spaceModels);
    _updateDiscPreview();
    _updateNamingPreviews();
    return;
  }

  if (coordModels.length) {
    _clashesState.spaceModels = coordModels;
    _populateModelPicker(_clashesState.spaceModels);
    _updateDiscPreview();
    _updateNamingPreviews();
    return;
  }

  // Fall back to space documents API
  const modelSetId = getActiveCoordSpaceId();
  if (!modelSetId) return;
  try {
    const containerId = el('inp-container-id')?.value?.trim() || '';
    const qs = new URLSearchParams({ modelSetId });
    if (containerId) qs.set('containerId', containerId);
    const data = await api('GET', `/api/mc/space-documents?${qs}`);
    _clashesState.spaceModels = (data?.documents ?? []).filter(d => d.viewerUrn).map(d => ({ name: d.name, viewerUrn: d.viewerUrn }));
    _populateModelPicker(_clashesState.spaceModels);
    _updateDiscPreview();
    _updateNamingPreviews();
  } catch { /* non-critical */ }
}

function _populateModelPicker(models) {
  const sel = el('template-model-picker');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— pick a model to browse levels —</option>';
  models.forEach(m => sel.add(new Option(m.name, m.viewerUrn)));
  if (current && sel.querySelector(`option[value="${CSS.escape(current)}"]`)) sel.value = current;
}

function _updateDiscPreview() {
  const previewEl = el('template-disc-preview');
  if (!previewEl) return;
  const models = _clashesState.spaceModels;
  if (!models.length) {
    previewEl.innerHTML = '<span class="italic">Open a coordination space to populate model names.</span>';
    return;
  }
  const chips = models.map(m => {
    const { abbrev } = _inferDisciplineFromName(m.name);
    return `<span class="inline-flex items-center gap-1 bg-slate-100 rounded px-2 py-0.5 mr-1 mb-1 text-xs">
      <span class="font-mono font-bold text-brand">${abbrev}</span>
      <span class="text-slate-600">${escapeHtml(m.name.replace(/\.[^.]+$/, ''))}</span>
    </span>`;
  });
  previewEl.innerHTML = chips.join('');
}

async function _loadLevelsForModel(viewerUrn) {
  if (!viewerUrn) return;
  el('levels-loading')?.classList.remove('hidden');
  try {
    const data = await api('GET', `/api/models/levels?urn=${encodeURIComponent(viewerUrn)}`);
    _clashesState.levels = data?.levels ?? [];
    const dl = el('level-suggestions');
    if (dl) {
      dl.innerHTML = '';
      _clashesState.levels.forEach(l => {
        const opt = document.createElement('option'); opt.value = l; dl.appendChild(opt);
      });
    }
    toast(_clashesState.levels.length ? `${_clashesState.levels.length} levels available` : 'No Level property found in this model', _clashesState.levels.length ? 'success' : 'warn');
  } catch (err) {
    toast('Could not load levels: ' + err.message, 'error');
  } finally {
    el('levels-loading')?.classList.add('hidden');
  }
}

// ── Template editor modal ─────────────────────────────────────────────────────

function openTemplateEditor(templateId) {
  const t = templateId ? _clashesState.templates.find(x => x.id === templateId) : null;
  el('template-modal-title').textContent = t ? 'Edit Template' : 'New Clash Template';
  el('template-edit-id').value          = t?.id ?? '';
  el('template-edit-name').value        = t?.name ?? '';
  el('template-edit-desc').value        = t?.description ?? '';
  el('template-edit-company').value     = t?.companyName ?? '';
  el('template-edit-assignee').value    = t?.assigneeName ?? '';
  el('template-edit-location').value    = t?.location ?? '';
  el('template-edit-due').value         = t?.dueDateOffsetDays ?? 14;
  el('template-edit-custom-pattern').value = t?.customPattern ?? '';

  const atType = t?.assigneeType ?? 'company';
  document.querySelector(`input[name="template-assignee-type"][value="${atType}"]`).checked = true;
  _updateAssigneeRows(atType);

  const namingId = t?.namingPatternId ?? 'level-test-sel';
  const radioEl = document.querySelector(`input[name="template-naming"][value="${namingId}"]`);
  if (radioEl) radioEl.checked = true;

  el('btn-template-delete').classList.toggle('hidden', !t);

  // Load real project data for autocomplete and previews (non-blocking).
  // Always refresh model list so it reflects currently-loaded viewer models.
  _clashesState.spaceModels = [];
  _loadCompaniesForEditor();
  _loadMembersForEditor();
  _loadSpaceModelsForEditor();

  _updateNamingPreviews();
  el('template-modal').classList.remove('hidden');
}

function _updateAssigneeRows(type) {
  el('template-company-row').classList.toggle('hidden', type !== 'company');
  el('template-individual-row').classList.toggle('hidden', type !== 'individual');
}

function _updateNamingPreviews() {
  const custom = el('template-edit-custom-pattern').value;
  const level  = el('template-edit-location')?.value?.trim() || 'Level 1';

  // Use actual test name from loaded tests, or infer from space model names
  let testName = 'ARCH vs STRC';
  if (_clashesState.tests.length) {
    testName = _clashesState.tests[0].name ?? testName;
  } else if (_clashesState.spaceModels.length >= 2) {
    const discA = _inferDisciplineFromName(_clashesState.spaceModels[0].name).abbrev;
    const discB = _inferDisciplineFromName(_clashesState.spaceModels[1].name).abbrev;
    if (discA && discB && discA !== discB) testName = `${discA} vs ${discB}`;
  }

  const ctx = { level, testName, selA: 'Walls', selB: 'Conduits', discipline: 'STRUCT', sequence: 3 };
  el('tpl-preview-1').textContent     = '→ ' + _applyNamingPattern('level-test-sel', ctx, '');
  el('tpl-preview-2').textContent     = '→ ' + _applyNamingPattern('test-disc-seq',  ctx, '');
  el('tpl-preview-custom').textContent = custom ? '→ ' + _applyNamingPattern('custom', ctx, custom) : '';
}

async function saveTemplate() {
  const name = el('template-edit-name').value.trim();
  if (!name) { toast('Template name required', 'error'); return; }

  const atType = document.querySelector('input[name="template-assignee-type"]:checked')?.value ?? 'company';
  const namingId = document.querySelector('input[name="template-naming"]:checked')?.value ?? 'level-test-sel';

  const id = el('template-edit-id').value || `tmpl-${Date.now()}`;
  const tpl = {
    id,
    name,
    description:      el('template-edit-desc').value.trim(),
    assigneeType:     atType,
    companyName:      atType === 'company'     ? el('template-edit-company').value.trim()  : '',
    assigneeName:     atType === 'individual'  ? el('template-edit-assignee').value.trim() : '',
    location:         el('template-edit-location').value.trim(),
    dueDateOffsetDays: parseInt(el('template-edit-due').value, 10) || 14,
    namingPatternId:  namingId,
    customPattern:    namingId === 'custom' ? el('template-edit-custom-pattern').value.trim() : '',
  };

  const existing = _clashesState.templates.find(x => x.id === id);
  if (existing) Object.assign(existing, tpl);
  else _clashesState.templates.push(tpl);

  await _saveTemplates();
  el('template-modal').classList.add('hidden');
  toast(`Template "${name}" saved`);
  renderClashTemplatesList();
  _populateTemplateSelect();
}

async function deleteTemplate(id) {
  _clashesState.templates = _clashesState.templates.filter(t => t.id !== id);
  await _saveTemplates();
  renderClashTemplatesList();
  _populateTemplateSelect();
  el('template-modal').classList.add('hidden');
  toast('Template deleted');
}

async function _saveTemplates() {
  try {
    await api('PUT', '/api/config/clash-issue-templates', { templates: _clashesState.templates });
  } catch (err) {
    toast('Could not save templates: ' + err.message, 'error');
  }
}

// ── Apply template to selected groups ────────────────────────────────────────

function applyTemplateToSelected() {
  const templateId = el('sel-apply-template').value;
  const tpl = _clashesState.templates.find(t => t.id === templateId);
  if (!tpl) { toast('Select a template first', 'error'); return; }

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (tpl.dueDateOffsetDays || 14));
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  let seq = 0;
  const groups = _filteredGroups();
  for (const g of groups) {
    const id = g.id ?? g.groupId ?? g.clashGroupId;
    if (!_clashesState.selected.has(id)) continue;
    seq++;
    const title = _applyNamingPattern(tpl.namingPatternId, {
      level:      tpl.location,
      testName:   g._testName ?? '',
      selA:       g.selectionAName ?? g.modelAName ?? '',
      selB:       g.selectionBName ?? g.modelBName ?? '',
      discipline: g.discipline ?? g.disciplines?.[0] ?? '',
      sequence:   seq,
    }, tpl.customPattern);

    _clashesState.assignments[id] = {
      company:  tpl.companyName,
      assignee: tpl.assigneeName,
      dueDate:  dueDateStr,
      title,
      templateId: tpl.id,
    };
  }

  renderClashGroupsList();
  toast(`Template "${tpl.name}" applied to ${_clashesState.selected.size} group(s)`);
}

// ── Push as ACC Issues ────────────────────────────────────────────────────────

function openPushPreview() {
  const selectedGroups = _filteredGroups().filter(g => {
    const id = g.id ?? g.groupId ?? g.clashGroupId;
    return _clashesState.selected.has(id);
  });

  if (!selectedGroups.length) { toast('Select clash groups first', 'error'); return; }

  const previewList = el('push-preview-list');
  previewList.innerHTML = '';

  let warned = false;
  selectedGroups.forEach((g, gi) => {
    const id     = g.id ?? g.groupId ?? g.clashGroupId;
    const assign = _clashesState.assignments[id];
    const title  = assign?.title ?? _resolveGroupName(g, gi);

    if (!assign && !warned) {
      warned = true;
    }

    const row = document.createElement('div');
    row.className = 'px-3 py-2 flex flex-col gap-1';
    row.innerHTML = `
      <p class="font-semibold text-slate-800">${escapeHtml(title)}</p>
      <div class="flex flex-wrap gap-2 text-xs text-slate-500">
        <span>Test: ${escapeHtml(g._testName ?? '—')}</span>
        <span>Clashes: ${g.clashCount ?? g.count ?? '—'}</span>
        ${assign?.company ? `<span class="text-emerald-600">🏢 ${escapeHtml(assign.company)}</span>` : '<span class="text-amber-500">⚠ No company</span>'}
        ${assign?.dueDate ? `<span>📅 ${assign.dueDate}</span>` : ''}
      </div>
    `;
    previewList.appendChild(row);
  });

  el('push-progress').classList.add('hidden');
  el('btn-push-confirm').disabled = false;
  el('push-preview-modal').classList.remove('hidden');
}

async function confirmPushIssues() {
  const projectId = el('inp-project-id')?.value.trim();
  if (!projectId) { toast('Set Project ID on the Connect tab first', 'error'); return; }

  const selectedGroups = _filteredGroups().filter(g => {
    const id = g.id ?? g.groupId ?? g.clashGroupId;
    return _clashesState.selected.has(id);
  });

  el('btn-push-confirm').disabled = true;
  const progress = el('push-progress');
  const bar = el('push-progress-bar');
  const label = el('push-progress-label');
  progress.classList.remove('hidden');

  let done = 0;
  const total = selectedGroups.length;
  const errors = [];

  // Load issue types once
  let issueTypeId = null;
  let issueSubtypeId = null;
  try {
    const types = await api('GET', `/api/issues/types?projectId=${encodeURIComponent(projectId)}`);
    const typeList = types?.results ?? types?.data ?? [];
    const clashType = typeList.find(t => /clash/i.test(t.title ?? t.name ?? '')) ?? typeList[0];
    issueTypeId = clashType?.id;
    issueSubtypeId = clashType?.subtypes?.[0]?.id;
  } catch (_) {}

  for (const [gi, g] of selectedGroups.entries()) {
    const id     = g.id ?? g.groupId ?? g.clashGroupId;
    const assign = _clashesState.assignments[id];
    const title  = assign?.title ?? _resolveGroupName(g, gi);

    try {
      const body = {
        title,
        description: `Clash group from test: ${g._testName ?? ''}. Group ID: ${id}. Clashes: ${g.clashCount ?? '—'}.`,
        status: 'open',
        due_date: assign?.dueDate ?? undefined,
        assigned_to_name: assign?.assignee || assign?.company || undefined,
        issue_subtype_id: issueSubtypeId ?? undefined,
      };
      await api('POST', `/api/issues?projectId=${encodeURIComponent(projectId)}`, body);
    } catch (err) {
      errors.push(`${title}: ${err.message}`);
    }

    done++;
    const pct = Math.round((done / total) * 100);
    bar.style.width = `${pct}%`;
    label.textContent = `${done} / ${total}`;
  }

  if (errors.length) {
    toast(`${done - errors.length} pushed, ${errors.length} failed`, 'error');
  } else {
    toast(`${done} issue${done !== 1 ? 's' : ''} created in ACC`, 'success');
    el('push-preview-modal').classList.add('hidden');
    _clashesState.selected.clear();
    renderClashGroupsList();
    _issuesState.loaded = false; // force reload when issues tab is next visited
  }
  el('btn-push-confirm').disabled = false;
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

    // Attachments/screenshots — best-effort
    try {
      const a = await api('GET', `/api/issues/${encodeURIComponent(issueId)}/attachments?projectId=${encodeURIComponent(projectId)}`);
      const attachments = a?.results ?? a?.data ?? (Array.isArray(a) ? a : []);
      renderIssueAttachments(attachments);
    } catch (_) { /* attachments may not exist or be enabled */ }
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

    ${_issuePushpins.some(p => p.id === issue.id) ? `
    <div class="mb-3">
      <button id="btn-fly-to-issue" class="btn-secondary text-xs py-1 px-3" data-id="${issue.id}">
        📍 Show in 3D Viewer
      </button>
    </div>` : ''}

    <hr class="my-4 border-slate-200"/>
    <div id="issue-attachments-section" class="hidden mb-4">
      <h4 class="text-xs font-semibold text-slate-700 mb-2">Photos &amp; Screenshots</h4>
      <div id="issue-attachments" class="flex flex-wrap gap-2"></div>
    </div>
    <h4 class="text-xs font-semibold text-slate-700 mb-2">Comments</h4>
    <div id="issue-comments" class="space-y-2 mb-3"></div>

    <div class="flex gap-2">
      <input id="inp-issue-comment" class="field-input flex-1 text-sm" placeholder="Add a comment…"/>
      <button id="btn-add-comment" class="btn-secondary text-sm">Send</button>
    </div>
  `;

  el('btn-fly-to-issue')?.addEventListener('click', e => {
    flyToIssuePushpin(e.currentTarget.dataset.id);
  });

  el('sel-issue-status-change')?.addEventListener('change', async e => {
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

  el('btn-add-comment')?.addEventListener('click', async () => {
    const body = el('inp-issue-comment')?.value.trim();
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

function renderIssueAttachments(attachments) {
  const section = el('issue-attachments-section');
  const host    = el('issue-attachments');
  if (!section || !host) return;
  const images = attachments.filter(a => {
    const mime = (a.mimeType ?? a.mime_type ?? a.contentType ?? '').toLowerCase();
    const name = (a.name ?? a.fileName ?? a.file_name ?? '').toLowerCase();
    return mime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp)$/.test(name);
  });
  if (!images.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  host.innerHTML = images.map(a => {
    const url  = a.url ?? a.signedUrl ?? a.downloadUrl ?? a.href ?? '';
    const name = escapeHtml(a.name ?? a.fileName ?? 'Attachment');
    return url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${name}"
           class="block w-24 h-24 rounded-lg border border-slate-200 overflow-hidden hover:border-brand transition-colors">
           <img src="${escapeHtml(url)}" alt="${name}" class="w-full h-full object-cover"/>
         </a>`
      : `<div class="w-24 h-24 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center text-xs text-slate-400 p-1 text-center">${name}</div>`;
  }).join('');
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
// ─────────────────────────────────────────────────────────────────────────────
// Project Access — grant APS app project-admin via ACC Admin API
// ─────────────────────────────────────────────────────────────────────────────

function paResult(msg, type = 'info') {
  const el_ = el('pa-result');
  if (!el_) return;
  el_.classList.remove('hidden',
    'bg-emerald-50','border-emerald-300','text-emerald-900',
    'bg-red-50','border-red-300','text-red-900',
    'bg-amber-50','border-amber-300','text-amber-900',
    'bg-blue-50','border-blue-300','text-blue-900');
  const map = {
    success: ['bg-emerald-50','border-emerald-300','text-emerald-900'],
    error:   ['bg-red-50','border-red-300','text-red-900'],
    warn:    ['bg-amber-50','border-amber-300','text-amber-900'],
    info:    ['bg-blue-50','border-blue-300','text-blue-900'],
  };
  el_.classList.add(...(map[type] ?? map.info));
  el_.textContent = msg;
}

function updatePaBadge(status) {
  const badge = el('pa-status-badge');
  if (!badge) return;
  if (status === 'ok') {
    badge.textContent = '● MC Access OK';
    badge.className = 'text-xs font-semibold px-2.5 py-1 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-300';
  } else if (status === 'forbidden') {
    badge.textContent = '● No Access';
    badge.className = 'text-xs font-semibold px-2.5 py-1 rounded-full border bg-red-50 text-red-700 border-red-300';
  } else {
    badge.textContent = '● Unknown';
    badge.className = 'text-xs font-semibold px-2.5 py-1 rounded-full border bg-slate-100 text-slate-600 border-slate-300';
  }
  badge.classList.remove('hidden');
}

async function checkMcAccess() {
  const btn = el('btn-check-mc-access');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  paResult('Checking MC API access…', 'info');
  try {
    const modelSetId  = getActiveCoordSpaceId();
    const containerId = el('inp-container-id')?.value?.trim();
    const qs = new URLSearchParams();
    if (modelSetId)  qs.set('modelSetId',  modelSetId);
    if (containerId) qs.set('containerId', containerId);
    const data = await api('GET', `/api/admin/check-mc-access?${qs}`);
    updatePaBadge(data.status);
    if (data.ok) {
      paResult('✓ MC API is accessible with current credentials.', 'success');
    } else if (data.status === 'forbidden') {
      paResult('✗ 403 Forbidden — the app does not have project-level MC access. Click Grant Project Access to fix this.', 'warn');
    } else {
      paResult(`✗ ${data.message}`, 'error');
    }
  } catch (err) {
    paResult('Check failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check MC Access';
  }
}

async function loadAccountAdmins() {
  const btn = el('btn-load-admins');
  const sel = el('sel-admin-user');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const accountId = el('inp-account-id')?.value?.trim() || '';
    if (!accountId) { paResult('Set Account ID first', 'warn'); return; }
    const data = await api('GET', `/api/admin/account-admins?accountId=${encodeURIComponent(accountId)}`);
    const users = data.users ?? [];
    if (!users.length) {
      sel.innerHTML = '<option value="">No admins found</option>';
      paResult('No account admins returned — ensure account:read scope and Account ID are correct.', 'warn');
      return;
    }
    sel.innerHTML = '<option value="">— select your account —</option>' +
      users.map(u => `<option value="${escapeHtml(u.id ?? u.autodeskId ?? '')}">${escapeHtml(u.name || u.email || u.id)}</option>`).join('');
    paResult(`Found ${users.length} account admin(s). Select yourself and click Grant Project Access.`, 'info');
  } catch (err) {
    sel.innerHTML = '<option value="">Error loading</option>';
    paResult('Failed to load admins: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load Admins';
  }
}

async function grantProjectAccess() {
  const btn = el('btn-grant-access');
  btn.disabled = true;
  btn.textContent = 'Granting…';
  paResult('Attempting to grant project access…', 'info');

  try {
    const projectId = el('inp-project-id')?.value?.trim() || '';
    const accountId = el('inp-account-id')?.value?.trim() || '';
    const adminUserId = el('sel-admin-user')?.value || '';

    if (!projectId) { paResult('Set Project ID first', 'warn'); return; }

    const data = await api('POST', '/api/admin/grant-project-access', { projectId, accountId, adminUserId });

    if (data.ok) {
      updatePaBadge('ok');
      paResult(`✓ ${data.message}`, 'success');
      toast('Project access granted — try Check MC Access to verify', 'success');
    } else {
      // If service-accounts failed and no admin selected, show the admin picker
      el('pa-admin-row').classList.remove('hidden');
      paResult(`First strategy failed — select your admin account above and try again.\n${data.message}`, 'warn');
    }
  } catch (err) {
    // Surface the User-Id picker on failure
    el('pa-admin-row').classList.remove('hidden');
    paResult(`Failed: ${err.message}. Select your admin account above and try again.`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Grant Project Access';
  }
}

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
      toast('Signed in with Autodesk successfully');
      window.history.replaceState({}, '', '/');
      // Go straight to Hub Projects so the user can pick a project
      navigate('hub');
      loadHubProjects();
    } else if (params.get('auth') === 'error') {
      toast('Sign-in failed: ' + (params.get('msg') || 'Unknown error'), 'error');
      window.history.replaceState({}, '', '/');
    } else if (status?.loggedIn && !_hubProjectsLoaded) {
      // Already logged in from a previous session — auto-load hub projects in background
      loadHubProjects();
      // Also auto-load coordination spaces if a project is already configured
      const projectId = el('inp-project-id')?.value?.trim() ?? State.config?.env?.ACC_PROJECT_ID ?? '';
      if (projectId) {
        loadCoordinationSpaces().catch(() => {});
      }
    }

    return status;
  } catch { return null; /* non-critical */ }
}

function renderAuthStatus(status) {
  // New simplified UI elements
  const heroEl      = el('connect-login-hero');
  const loggedInEl  = el('connect-logged-in');
  const callbackEl  = el('sa-callback-display');
  const capsSection = el('capabilities-section');

  if (callbackEl) {
    callbackEl.textContent = State.config?.callbackUrl ?? `${window.location.origin}/api/auth/callback`;
  }

  // Legacy hidden elements (keep functional for JS that references them)
  el('sa-logged-out')?.classList.add('hidden');
  el('sa-logged-in')?.classList.add('hidden');

  if (!status?.loggedIn) {
    heroEl?.classList.remove('hidden');
    loggedInEl?.classList.add('hidden');
    capsSection?.classList.add('hidden');

    // Update hub empty message
    const hubMsg = el('hub-empty-msg');
    if (hubMsg) hubMsg.textContent = 'Sign in with Autodesk on the Connect tab to see your projects';
    return;
  }

  // Logged in — show dashboard view
  heroEl?.classList.add('hidden');
  loggedInEl?.classList.remove('hidden');
  capsSection?.classList.remove('hidden');

  const badge = el('sa-status-badge');
  if (badge) {
    badge.textContent = '● Connected';
    badge.className = 'text-xs font-semibold px-2.5 py-1 rounded-full border bg-emerald-100 text-emerald-700 border-emerald-300';
    badge.classList.remove('hidden');
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

  // Update active project display
  _refreshConnectProjectCard();

  // Railway persistence
  const persistEl = el('sa-railway-persist');
  const envOkEl   = el('sa-railway-ok');
  if (status.envVarSet) {
    persistEl?.classList.add('hidden');
    envOkEl?.classList.remove('hidden');
  } else if (status.refreshToken) {
    persistEl?.classList.remove('hidden');
    envOkEl?.classList.add('hidden');
    const tokenValueEl = el('sa-refresh-token-value');
    if (tokenValueEl) tokenValueEl.textContent = status.refreshToken;
  }
}

async function init() {
  try {
    State.config = await api('GET', '/api/config');
  } catch (e) {
    toast('Could not load configuration — is the server running?', 'error');
    return;
  }

  // Guard against null config (server returned 200 with non-JSON body, e.g. cold start)
  if (!State.config || !State.config.env) {
    toast('Invalid configuration response — please refresh', 'error');
    return;
  }

  // Populate all tabs — wrapped in try-catch so a bad config value can't kill all of init()
  try { populateConnect(State.config); } catch (e) { console.error('[init] populateConnect failed:', e); }
  try { populateSettings(State.config); } catch (e) { console.error('[init] populateSettings failed:', e); }

  // Reflect connection state if credentials already set
  if (State.config.env.APS_CLIENT_ID && State.config.hasSecret) {
    const connDotEl = el('conn-dot');
    if (connDotEl) connDotEl.className = 'w-2 h-2 rounded-full flex-shrink-0 bg-slate-500';
    const connLabelEl = el('conn-label');
    if (connLabelEl) connLabelEl.textContent = 'Credentials loaded';
  }

  // Load service account auth status (await so we know whether user is logged in)
  const _initAuthStatus = await loadAuthStatus();

  // Load capabilities panel
  loadCapabilities();

  // ── Event listeners ──────────────────────────────────────

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Viewer tab
  el('btn-load-viewer-models')?.addEventListener('click', loadViewerModels);
  el('btn-load-federation')?.addEventListener('click', loadFederation);
  el('btn-unload-all-models')?.addEventListener('click', unloadAllModels);
  el('btn-clear-recent')?.addEventListener('click', clearRecentModels);
  document.querySelectorAll('.viewer-src-btn').forEach(btn => {
    btn.addEventListener('click', () => setViewerSource(btn.dataset.src));
  });
  el('btn-viewer-home')?.addEventListener('click', () => {
    if (_viewerState.viewer) _viewerState.viewer.fitToView();
  });
  el('btn-viewer-explode')?.addEventListener('click', () => {
    if (!_viewerState.viewer) return;
    const current = _viewerState.viewer.getExplodeScale?.() ?? 0;
    _viewerState.viewer.explode(current > 0 ? 0 : 0.5);
  });
  el('btn-show-clashes')?.addEventListener('click', showAllClashMarkers);
  el('btn-clear-markers')?.addEventListener('click', clearClashMarkers);
  el('btn-load-clash-results')?.addEventListener('click', loadClashResultsForViewer);
  el('btn-show-issue-markers')?.addEventListener('click', () => {
    if (_issueMarkersShown) { clearIssuePushpins(); }
    else { showIssuePushpinsInViewer(); }
  });
  el('btn-clear-issue-markers')?.addEventListener('click', clearIssuePushpins);
  el('inp-clash-filter')?.addEventListener('input', () => renderClashGroups(_viewerState.clashGroups));

  // Coordination space
  el('btn-load-coord-spaces')?.addEventListener('click', loadCoordinationSpaces);
  el('btn-load-coord-spaces-mc')?.addEventListener('click', loadCoordinationSpaces);
  el('sel-coord-space')?.addEventListener('change', onCoordSpaceChange);
  el('sel-coord-space-mc')?.addEventListener('change', onCoordSpaceChange);

  // Saved Views
  el('sel-view')?.addEventListener('change', onViewSelected);
  el('btn-view-load')?.addEventListener('click', loadSelectedView);
  el('btn-view-save')?.addEventListener('click', saveCurrentAsView);
  el('btn-view-delete')?.addEventListener('click', deleteSelectedView);

  // Initialize viewer source toggle + recents on load
  setViewerSource('space');
  renderRecentModels();
  // Try to populate views list once (silent if unauthenticated)
  reloadViewsList().catch(() => {});

  // Clashes tab
  el('btn-load-clash-groups')?.addEventListener('click', loadClashGroups);
  el('btn-smart-group')?.addEventListener('click', runSmartGroupAnalysis);
  el('btn-smart-group-close')?.addEventListener('click', () => el('smart-group-panel')?.classList.add('hidden'));
  el('btn-smart-approve-all')?.addEventListener('click', () => {
    // Mark all soft/interface groups as approved in local state (visual only until pushed)
    for (const g of _smartGroupState.groups) {
      if (g.soft > 0 || g.interface > 0) {
        g._approved = true;
      }
    }
    toast(`Marked soft/interface clashes as approved (not yet pushed to ACC)`);
  });
  el('btn-new-template')?.addEventListener('click', () => openTemplateEditor(null));
  el('btn-apply-template')?.addEventListener('click', applyTemplateToSelected);
  el('btn-push-issues')?.addEventListener('click', openPushPreview);
  el('btn-template-save')?.addEventListener('click', saveTemplate);
  el('btn-template-cancel')?.addEventListener('click', () => el('template-modal')?.classList.add('hidden'));
  el('btn-template-modal-close')?.addEventListener('click', () => el('template-modal')?.classList.add('hidden'));
  el('btn-template-delete')?.addEventListener('click', () => {
    const id = el('template-edit-id')?.value;
    if (id) deleteTemplate(id);
  });
  el('btn-push-confirm')?.addEventListener('click', confirmPushIssues);
  el('btn-push-cancel')?.addEventListener('click', () => el('push-preview-modal')?.classList.add('hidden'));
  el('btn-push-preview-close')?.addEventListener('click', () => el('push-preview-modal')?.classList.add('hidden'));
  el('chk-clashes-all')?.addEventListener('change', e => {
    const groups = _filteredGroups();
    groups.forEach(g => {
      const id = g.id ?? g.groupId ?? g.clashGroupId;
      if (e.target.checked) _clashesState.selected.add(id);
      else _clashesState.selected.delete(id);
    });
    renderClashGroupsList();
  });
  el('sel-clashes-test')?.addEventListener('change', e => {
    _clashesState.filterTestId = e.target.value;
    renderClashGroupsList();
  });
  el('inp-clashes-search')?.addEventListener('input', e => {
    _clashesState.filterText = e.target.value;
    renderClashGroupsList();
  });
  document.querySelectorAll('input[name="template-assignee-type"]').forEach(r => {
    r.addEventListener('change', e => _updateAssigneeRows(e.target.value));
  });
  document.querySelectorAll('input[name="template-naming"]').forEach(r => {
    r.addEventListener('change', _updateNamingPreviews);
  });
  el('template-edit-custom-pattern')?.addEventListener('input', _updateNamingPreviews);
  // Live preview updates as the user types a level/location
  el('template-edit-location')?.addEventListener('input', _updateNamingPreviews);
  // Level picker: load levels from the selected model
  el('btn-load-levels')?.addEventListener('click', () => {
    const urn = el('template-model-picker')?.value;
    if (!urn) { toast('Pick a model first', 'error'); return; }
    _loadLevelsForModel(urn);
  });
  // Clash group naming preview refreshes when template selection changes
  el('sel-apply-template')?.addEventListener('change', renderClashGroupsList);

  // Issues tab
  el('btn-load-issues')?.addEventListener('click', loadIssues);
  el('btn-new-issue')?.addEventListener('click', openNewIssueModal);
  el('btn-issue-new-close')?.addEventListener('click', () => el('issue-new-modal')?.classList.add('hidden'));
  el('btn-issue-cancel')?.addEventListener('click', () => el('issue-new-modal')?.classList.add('hidden'));
  el('btn-issue-create')?.addEventListener('click', createIssue);
  el('inp-issue-search')?.addEventListener('input', e => {
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
  el('btn-coord-refresh')?.addEventListener('click', () => {
    _coordState.loaded = false;
    loadCoordinationData();
  });
  el('btn-load-view')?.addEventListener('click', loadViewIntoViewer);
  el('btn-create-view')?.addEventListener('click', openCreateViewModal);

  // Discipline search bar
  el('disc-search')?.addEventListener('input', e => {
    _discSearchText = e.target.value;
    const clearBtn = el('btn-disc-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !_discSearchText);
    renderCoordDisciplineRows();
  });
  el('btn-disc-search-clear')?.addEventListener('click', () => {
    _discSearchText = '';
    const inp = el('disc-search');
    if (inp) inp.value = '';
    el('btn-disc-search-clear')?.classList.add('hidden');
    renderCoordDisciplineRows();
  });

  // Level filter — reference model selector
  el('sel-level-ref-model')?.addEventListener('change', e => {
    const modelId = e.target.value;
    _levelFilter.refModelId = modelId || null;
    _levelFilter.level = null;
    _levelFilter.matchedIds = new Set();
    const pickSel = el('sel-level-pick');
    if (pickSel) { pickSel.innerHTML = '<option value="">— pick a level —</option>'; pickSel.disabled = !modelId; }
    el('level-filter-badge')?.classList.add('hidden');
    el('btn-level-filter-clear')?.classList.add('hidden');
    renderCoordDisciplineRows();
    if (modelId) loadLevelOptions(modelId);
  });

  // Level filter — level picker
  el('sel-level-pick')?.addEventListener('change', async e => {
    await applyLevelFilter(e.target.value || null);
  });

  // Level filter — clear
  el('btn-level-filter-clear')?.addEventListener('click', () => {
    _levelFilter.level = null;
    _levelFilter.matchedIds = new Set();
    const pickSel = el('sel-level-pick');
    if (pickSel) pickSel.value = '';
    el('level-filter-badge')?.classList.add('hidden');
    el('btn-level-filter-clear')?.classList.add('hidden');
    renderCoordDisciplineRows();
  });

  // Create view modal
  el('create-view-close')?.addEventListener('click', closeCreateViewModal);
  el('btn-create-view-cancel')?.addEventListener('click', closeCreateViewModal);
  el('btn-create-view-submit')?.addEventListener('click', submitCreateView);
  el('btn-cv-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.cv-model-cb').forEach(cb => { cb.checked = true; });
  });
  el('btn-cv-select-none')?.addEventListener('click', () => {
    document.querySelectorAll('.cv-model-cb').forEach(cb => { cb.checked = false; });
  });
  el('btn-cv-select-disc')?.addEventListener('click', () => {
    const discIds = new Set(Object.values(_coordState.assignments).filter(Boolean));
    document.querySelectorAll('.cv-model-cb').forEach(cb => {
      cb.checked = discIds.has(cb.dataset.id);
    });
  });
  el('create-view-modal')?.addEventListener('click', e => {
    if (e.target === el('create-view-modal')) closeCreateViewModal();
  });

  el('btn-clash-incl-all')?.addEventListener('click', () => {
    _coordState.clashIncludes = _coordState.models.map(m => m.id);
    renderCoordClashRows();
    saveCoordinationDebounced();
  });
  el('btn-clash-incl-none')?.addEventListener('click', () => {
    _coordState.clashIncludes = [];
    renderCoordClashRows();
    saveCoordinationDebounced();
  });
  el('btn-clash-incl-disc')?.addEventListener('click', () => {
    _coordState.clashIncludes = Object.values(_coordState.assignments);
    renderCoordClashRows();
    saveCoordinationDebounced();
  });
  el('sel-align-snap')?.addEventListener('change', e => {
    _coordState.alignSnap = parseFloat(e.target.value || '1');
    saveCoordinationDebounced();
  });
  el('btn-load-mc-ss')?.addEventListener('click', loadMcSearchSets);
  el('btn-load-mc-ct')?.addEventListener('click', loadMcClashTests);
  el('btn-load-wf-results')?.addEventListener('click', loadWorkflowClashResults);

  el('btn-import-mc-ss')?.addEventListener('click', async () => {
    const modelSetId = getActiveCoordSpaceId();
    if (!modelSetId) { toast('Select a Coordination Space first', 'error'); return; }
    const btn = el('btn-import-mc-ss');
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const data = await api('POST', `/api/mc/search-sets/import?modelSetId=${encodeURIComponent(modelSetId)}`, {});
      if (data.apiSurface === 'rules') {
        // Store the rules for schema inspection, refresh the display
        _mcState.searchSets = { apiSurface: 'rules', rules: data.currentRules };
        renderMcSearchSets();
        toast('v3 rules model — rules document loaded. Schema visible below; full import coming once schema is confirmed.', 'warn');
      } else {
        toast(`Imported: ${data.created} created, ${data.skipped} skipped, ${data.failed} failed`, data.failed ? 'warn' : 'success');
        await loadMcSearchSets();
      }
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Import from Library';
    }
  });

  // Viewer sidebar — inline coord space picker syncs to all other space selectors
  el('sel-viewer-coord-space')?.addEventListener('change', e => {
    const id = e.target.value;
    ['sel-coord-space', 'sel-coord-space-mc'].forEach(selId => {
      const sel = el(selId);
      if (sel && sel.querySelector(`option[value="${id}"]`)) sel.value = id;
    });
    setViewerSource(_viewerState.source); // refresh label / picker state
    if (_viewerState.source === 'space') loadViewerModels();
  });

  // Models tab
  el('btn-load-models')?.addEventListener('click', loadModels);
  document.querySelectorAll('#models-disc-filter .disc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#models-disc-filter .disc-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _modelsDiscFilter = pill.dataset.disc;
      renderModels();
    });
  });

  // Hub tab
  el('btn-load-hub-projects')?.addEventListener('click', loadHubProjects);
  el('inp-hub-search')?.addEventListener('input', () => renderHubProjects(_hubProjects));
  el('sel-hub-sort')?.addEventListener('change', e => {
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

  el('btn-copy-refresh-token')?.addEventListener('click', () => {
    const val = el('sa-refresh-token-value')?.textContent ?? '';
    if (!val) return;
    navigator.clipboard.writeText(val).then(
      () => toast('Refresh token copied — paste it as APS_REFRESH_TOKEN in your Railway dashboard', 'success'),
      () => { el('sa-refresh-token-value')?.select?.(); toast('Select the token value and copy manually', 'warn'); }
    );
  });

  // Connect tab — project access
  el('btn-check-mc-access')?.addEventListener('click', checkMcAccess);
  el('btn-grant-access')?.addEventListener('click', grantProjectAccess);
  el('btn-load-admins')?.addEventListener('click', loadAccountAdmins);

  // Connect tab
  el('btn-test-conn')?.addEventListener('click', testConnection);
  el('btn-load-folders')?.addEventListener('click', loadFolders);
  el('btn-detect-container')?.addEventListener('click', detectContainer);
  el('btn-save-env')?.addEventListener('click', saveEnv);
  el('btn-refresh-caps')?.addEventListener('click', loadCapabilities);
  el('btn-toggle-secret')?.addEventListener('click', () => {
    const inp = el('inp-client-secret');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });


  // Settings tab
  el('btn-save-settings')?.addEventListener('click', saveSettings);
  el('set-naming-format')?.addEventListener('input', updateNamingPreview);

  // Run tab
  el('btn-run')?.addEventListener('click', runWorkflow);
  el('btn-clear-log')?.addEventListener('click', () => { if (el('log-output')) el('log-output').innerHTML = ''; });

  // Keyboard shortcut: Cmd/Ctrl+Enter → Run
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && State.currentTab === 'run') {
      runWorkflow();
    }
  });

  // Start on Hub Projects if already signed in, otherwise Connect tab
  if (_initAuthStatus?.loggedIn) {
    navigate('hub');
    loadHubProjects();
  } else {
    navigate('connect');
  }
}

document.addEventListener('DOMContentLoaded', init);
