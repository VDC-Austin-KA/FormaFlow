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
};

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
  const projectId = el('inp-project-id').value.trim();
  const folderUrn = el('inp-folder-urn').value.trim();
  if (!projectId) { toast('Set Project ID on the Connect tab first', 'error'); return; }
  if (!folderUrn) { toast('Select a Target Folder on the Connect tab first', 'error'); return; }

  const btn = el('btn-load-viewer-models');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const data = await api('GET',
      `/api/project/folder-contents?projectId=${encodeURIComponent(projectId)}&folderUrn=${encodeURIComponent(folderUrn)}`);
    const isNwcFile = name => /\.(nwc|nwd)$/i.test(name ?? '');
    const allItems = data.items ?? [];
    const models = allItems.filter(i => {
      if (i.type !== 'items') return false;
      if (i.viewerUrn) return true;           // RVT/DWG already translated
      if (isNwcFile(i.name)) return true;      // NWC/NWD — include even without viewerUrn
      return false;
    });

    const list = el('viewer-model-list');
    list.innerHTML = '';

    if (!models.length) {
      list.innerHTML = '<p class="text-xs text-slate-600 px-2 py-3">No viewable models in this folder</p>';
      return;
    }

    const disciplines = new Set();
    models.forEach(m => {
      const disc = guessDiscFromName(m.name);
      m.discipline = disc;
      if (disc) disciplines.add(disc);

      const nwcOnly = !m.viewerUrn && isNwcFile(m.name);
      const item = document.createElement('div');
      item.className = `viewer-model-item${nwcOnly ? ' nwc-only' : ''}`;
      item.dataset.urn = m.viewerUrn ?? '';
      item.dataset.name = m.name;
      item.dataset.disc = disc;
      item.title = nwcOnly ? 'NWC file — not yet translated to SVF2; load into a Navisworks model set to enable 3D viewing' : '';
      item.innerHTML = `
        <div class="disc-dot" style="background:${DISC_COLORS_HEX[disc] ?? '#9ca3af'}"></div>
        <span class="model-name" title="${m.name}">${m.name}</span>
        ${nwcOnly
          ? '<span class="nwc-badge">NWC</span>'
          : '<span class="model-status">▶</span>'}
      `;
      if (!nwcOnly) {
        item.addEventListener('click', () => toggleViewerModel(item, m));
      }
      list.appendChild(item);
    });

    const nwcCount = models.filter(m => !m.viewerUrn && isNwcFile(m.name)).length;
    const viewableCount = models.length - nwcCount;
    renderDiscToggles([...disciplines]);
    toast(`Found ${viewableCount} viewable + ${nwcCount} NWC coordination model(s)`);
  } catch (err) {
    toast('Failed to list models: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Load Models from Folder';
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
    itemEl.querySelector('.model-status').textContent = '▶';
    updateViewerModelCounter();
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
          _viewerState.loadedModels.push({ urn: modelDef.viewerUrn, name: modelDef.name,
            discipline: modelDef.discipline, model });
          itemEl.classList.remove('loading'); itemEl.classList.add('loaded');
          itemEl.querySelector('.model-status').textContent = '✓';
          el('viewer-status-text').textContent = `${modelDef.name} loaded`;
          updateViewerModelCounter();
          resolve();
        },
        (code, msg) => reject(new Error(`Viewer load error ${code}: ${msg}`))
      );
    });
  } catch (err) {
    itemEl.classList.remove('loading'); itemEl.classList.add('error');
    itemEl.querySelector('.model-status').textContent = '✗';
    toast('Load failed: ' + err.message, 'error');
  }
}

function updateViewerModelCounter() {
  const n = _viewerState.loadedModels.length;
  el('viewer-model-count').textContent = n;
  el('viewer-model-counter').classList.toggle('hidden', n === 0);
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

async function loadHubProjects() {
  const btn = el('btn-load-hub-projects');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const data = await api('GET', '/api/hub/projects');
    _hubProjects = data?.data ?? [];
    renderHubProjects(_hubProjects);

    // Stats
    const accCount   = _hubProjects.filter(p => p.attributes?.projectType === 'ACC').length;
    const otherCount = _hubProjects.length - accCount;
    el('hub-stat-total').textContent = _hubProjects.length;
    el('hub-stat-acc').textContent   = accCount;
    el('hub-stat-other').textContent = otherCount;

    const currentProjId = el('inp-project-id').value.trim();
    const current = _hubProjects.find(p => p.id?.replace(/^b\./, '') === currentProjId);
    el('hub-stat-active').textContent = current?.attributes?.name ?? 'None';

    toast(`Loaded ${_hubProjects.length} project(s)`);
  } catch (err) {
    toast('Failed to load hub projects: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Load Projects';
  }
}

function renderHubProjects(projects) {
  const grid = el('hub-project-grid');
  const filter = (el('inp-hub-search')?.value ?? '').toLowerCase();
  const filtered = filter ? projects.filter(p =>
    p.attributes?.name?.toLowerCase().includes(filter)
  ) : projects;

  if (!filtered.length) {
    grid.innerHTML = '<div class="col-span-3 text-center text-slate-400 py-12">No projects match your search</div>';
    return;
  }

  const currentProjId = el('inp-project-id').value.trim();

  grid.innerHTML = filtered.map(p => {
    const rawId = p.id?.replace(/^b\./, '') ?? '';
    const isActive = rawId === currentProjId;
    return `
      <div class="hub-project-card ${isActive ? 'active-project' : ''}" data-project-id="${rawId}">
        <div class="hpc-name" title="${p.attributes?.name ?? ''}">${p.attributes?.name ?? 'Unnamed Project'}</div>
        <div class="hpc-type">${p.attributes?.projectType ?? 'ACC'} · ${p.attributes?.status ?? 'active'}</div>
        <div class="hpc-id">${rawId}</div>
        <div class="hpc-actions">
          <button class="btn-primary text-xs py-1 px-3 ${isActive ? 'opacity-50 cursor-default' : ''}"
            onclick="switchHubProject('${rawId}', '${(p.attributes?.name ?? '').replace(/'/g, '')}')"
            ${isActive ? 'disabled' : ''}>
            ${isActive ? '✓ Active' : 'Use This Project'}
          </button>
        </div>
      </div>
    `;
  }).join('');
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

// Initialisation
// ─────────────────────────────────────────────────────────────────────────────

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

  // Load capabilities panel
  loadCapabilities();

  // ── Event listeners ──────────────────────────────────────

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Viewer tab
  el('btn-load-viewer-models').addEventListener('click', loadViewerModels);
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

  // Hub tab
  el('btn-load-hub-projects').addEventListener('click', loadHubProjects);
  el('inp-hub-search').addEventListener('input', () => renderHubProjects(_hubProjects));

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
