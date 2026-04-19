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
    throw new Error(err.error || res.statusText);
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
  connect:    { title: 'Connect',      sub: 'Configure APS credentials and ACC project' },
  models:     { title: 'Models',       sub: 'View and override automatically identified disciplines' },
  searchsets: { title: 'Search Sets',  sub: 'Toggle and preview reusable property-based filters' },
  clashtests: { title: 'Clash Tests',  sub: 'Enable, disable, and fine-tune clash test pairs' },
  settings:   { title: 'Settings',     sub: 'Workflow options, naming conventions, and output' },
  run:        { title: 'Run Workflow', sub: 'Execute the full automated coordination workflow' },
};

function navigate(tab) {
  State.currentTab = tab;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  const meta = TAB_META[tab] || {};
  el('tab-title').textContent = meta.title || tab;
  el('tab-sub').textContent = meta.sub || '';
  el('header-actions').innerHTML = '';
  if (tab === 'clashtests' || tab === 'searchsets' || tab === 'settings') renderSaveBtn(tab);
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
    // Try to pre-populate the select
    const sel = el('sel-folder');
    if (sel.options.length <= 1) {
      const opt = new Option(cfg.env.TARGET_FOLDER_URN.split(':').pop(), cfg.env.TARGET_FOLDER_URN);
      sel.add(opt);
      sel.value = cfg.env.TARGET_FOLDER_URN;
    }
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
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const data = await api('GET', `/api/project/folders?accountId=${encodeURIComponent(accountId)}&projectId=${encodeURIComponent(projectId)}`);
    const folders = data?.data ?? [];
    const sel = el('sel-folder');
    sel.innerHTML = '<option value="">— select a folder —</option>';
    for (const f of folders) {
      const name = f.attributes?.name || f.id;
      const urn  = f.links?.webView?.href || f.id;
      const opt  = new Option(name, f.id);
      opt.dataset.urn = f.id;
      sel.add(opt);
    }
    if (!folders.length) toast('No folders found — check account/project IDs', 'error');
    else toast(`Loaded ${folders.length} folder(s)`);
  } catch (err) {
    toast('Failed to load folders: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load';
  }
}

async function detectContainer() {
  const accountId = el('inp-account-id').value.trim();
  if (!accountId) { toast('Enter Account ID first', 'error'); return; }

  const btn = el('btn-detect-container');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const data = await api('GET', `/api/project/containers?accountId=${encodeURIComponent(accountId)}`);
    const containers = data?.data ?? data ?? [];
    if (containers.length > 0) {
      el('inp-container-id').value = containers[0].id ?? containers[0];
      toast(`Container detected: ${containers[0].id ?? containers[0]}`);
    } else {
      toast('No containers found — ensure your app is provisioned in ACC Admin', 'error');
    }
  } catch (err) {
    toast('Container detection failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect';
  }
}

async function saveEnv() {
  const folderSel = el('sel-folder');
  const folderUrn = folderSel.value || el('inp-folder-urn').value;

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

    // Build filter preview tags
    const conditions = ss.filter?.conditions ?? [];
    const tags = conditions.slice(0, 3).map(c => {
      if (c.conditionOperator) return `<span class="ss-filter-tag">(nested group)</span>`;
      const op = c.operator === 'equals' ? '=' : c.operator === 'in' ? 'in' : c.operator;
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
      <p class="ss-card-desc">${ss.description || ''}</p>
      <div class="flex flex-wrap">${tags}</div>
    `;

    card.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      ss._disabled = !e.target.checked;
      card.classList.toggle('disabled', ss._disabled);
    });

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

  // ── Event listeners ──────────────────────────────────────

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Connect tab
  el('btn-test-conn').addEventListener('click', testConnection);
  el('btn-load-folders').addEventListener('click', loadFolders);
  el('btn-detect-container').addEventListener('click', detectContainer);
  el('btn-save-env').addEventListener('click', saveEnv);
  el('btn-toggle-secret').addEventListener('click', () => {
    const inp = el('inp-client-secret');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  el('sel-folder').addEventListener('change', (e) => {
    const urn = e.target.value;
    el('inp-folder-urn').value = urn;
    el('folder-urn-row').classList.toggle('hidden', !urn);
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
