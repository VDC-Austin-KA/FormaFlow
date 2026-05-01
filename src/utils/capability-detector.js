/**
 * CapabilityDetector
 *
 * Inspects process.env (or a provided env object) to determine which
 * FormaFlow features are currently available and which need additional
 * credentials or configuration.
 *
 * Capability tiers:
 *  0 — Always available (fully local, no API)
 *  1 — APS_CLIENT_ID + APS_CLIENT_SECRET (authentication enabled)
 *  2 — + hub context (APS_HUB_ID or ACC_ACCOUNT_ID)
 *  3 — + ACC_PROJECT_ID  (project context resolved)
 *  4 — + MC_CONTAINER_ID (Model Coordination fully unlocked)
 *
 * Supported env-var aliases:
 *  APS_HUB_ID  →  ACC_ACCOUNT_ID  (Autodesk sometimes surfaces the hub UUID
 *                                   under the shorter name)
 */

export function detectCapabilities(env = process.env) {
  const has = k => Boolean(env[k]?.trim());

  // Resolve hub/account ID from either conventional name
  const hasHubId      = has('APS_HUB_ID') || has('ACC_ACCOUNT_ID');
  const resolvedHubId = env.ACC_ACCOUNT_ID?.trim() || env.APS_HUB_ID?.trim() || null;
  const hubIdSource   = env.ACC_ACCOUNT_ID?.trim() ? 'ACC_ACCOUNT_ID' : (env.APS_HUB_ID?.trim() ? 'APS_HUB_ID' : null);

  const f = {
    clientId:     has('APS_CLIENT_ID'),
    clientSecret: has('APS_CLIENT_SECRET'),
    hubId:        hasHubId,
    projectId:    has('ACC_PROJECT_ID'),
    containerId:  has('MC_CONTAINER_ID'),
    targetFolder: has('TARGET_FOLDER_URN'),
    resolvedHubId,
    hubIdSource,
  };

  // Derived gate flags — each tier requires all previous tiers
  const canAuth        = f.clientId && f.clientSecret;
  const canHubOps      = canAuth && f.hubId;
  const canProjectOps  = canHubOps && f.projectId;
  const canMC          = canProjectOps && f.containerId;

  const capabilities = [
    // ── Tier 0 — always available ────────────────────────────────────────────
    {
      id: 'discipline-classifier', tier: 0,
      name: 'Discipline Classifier',
      description: 'Auto-classify BIM models by discipline using file-name patterns and Revit property signatures. Runs entirely locally — no API required.',
      available: true, missing: [],
    },
    {
      id: 'config-management', tier: 0,
      name: 'Config Management',
      description: 'Read and write workflow config, search-set library, clash-test templates, and naming conventions.',
      available: true, missing: [],
    },
    {
      id: 'navisworks-import', tier: 0,
      name: 'Navisworks XML Import',
      description: 'Parse Navisworks .xml search-set exports and convert them to the FormaFlow search-set format.',
      available: true, missing: [],
    },
    {
      id: 'dry-run-workflow', tier: 0,
      name: 'Dry-Run Workflow Simulation',
      description: 'Simulate the complete clash-automation workflow — discipline identify, search-set planning, clash-test selection — without any API write calls.',
      available: true, missing: [],
    },

    // ── Tier 1 — authentication ───────────────────────────────────────────────
    {
      id: 'aps-auth', tier: 1,
      name: 'APS 2-Legged Authentication',
      description: 'Obtain OAuth 2.0 bearer tokens for server-to-server APS API calls (scopes: data:read, data:write, account:read).',
      available: canAuth,
      missing: [
        ...(f.clientId     ? [] : ['APS_CLIENT_ID']),
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
      ],
    },
    {
      id: 'model-derivative', tier: 1,
      name: 'Model Derivative — Property Extraction',
      description: 'Extract Revit model properties (Category, System Classification, Discipline) from translated models to power automatic discipline identification.',
      available: canAuth,
      missing: [
        ...(f.clientId     ? [] : ['APS_CLIENT_ID']),
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
      ],
    },
    {
      id: 'live-model-properties', tier: 1,
      name: 'Live Model Property Autocomplete',
      description: 'Fetch available property names and sample values from translated ACC models to drive Search Set condition editors.',
      available: canAuth,
      missing: [
        ...(f.clientId     ? [] : ['APS_CLIENT_ID']),
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
      ],
    },

    // ── Tier 2 — hub context ─────────────────────────────────────────────────
    {
      id: 'hub-discovery', tier: 2,
      name: 'ACC Hub / Account Context',
      description: 'Hub ID resolved — enables listing projects within your ACC account without a manual discovery step.',
      available: canHubOps,
      note: resolvedHubId ? `Hub ID: …${resolvedHubId.slice(-12)} (from ${hubIdSource})` : null,
      missing: [
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
        ...(hasHubId       ? [] : ['APS_HUB_ID or ACC_ACCOUNT_ID']),
      ],
    },

    // ── Tier 3 — project context ─────────────────────────────────────────────
    {
      id: 'folder-browsing', tier: 3,
      name: 'ACC Folder Browsing',
      description: 'Browse top-level Docs folders and inspect folder contents within a specific ACC project.',
      available: canProjectOps,
      missing: [
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
        ...(hasHubId       ? [] : ['APS_HUB_ID or ACC_ACCOUNT_ID']),
        ...(f.projectId    ? [] : ['ACC_PROJECT_ID']),
      ],
    },

    // ── Tier 4 — Model Coordination ──────────────────────────────────────────
    {
      id: 'model-set-read', tier: 4,
      name: 'Model Coordination — Read Model Sets',
      description: 'List model sets, versions, and documents in the MC container for a given project.',
      available: canMC,
      missing: [
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
        ...(f.projectId    ? [] : ['ACC_PROJECT_ID']),
        ...(f.containerId  ? [] : ['MC_CONTAINER_ID']),
      ],
    },
    {
      id: 'search-set-crud', tier: 4,
      name: 'Search Set Management',
      description: 'Create, update, and delete reusable property-based Search Sets in an ACC model set via the Model Coordination API.',
      available: canMC,
      missing: [
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
        ...(f.projectId    ? [] : ['ACC_PROJECT_ID']),
        ...(f.containerId  ? [] : ['MC_CONTAINER_ID']),
      ],
    },
    {
      id: 'clash-tests', tier: 4,
      name: 'Clash Test Automation',
      description: 'Create clash tests, poll for completion, and retrieve grouped clash results from the Model Coordination API.',
      available: canMC,
      missing: [
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
        ...(f.projectId    ? [] : ['ACC_PROJECT_ID']),
        ...(f.containerId  ? [] : ['MC_CONTAINER_ID']),
      ],
    },
    {
      id: 'full-workflow', tier: 4,
      name: 'Full Automated Workflow',
      description: 'End-to-end: identify disciplines → create Search Sets → run clash tests → wait for results → export named clash report.',
      available: canMC,
      missing: [
        ...(f.clientSecret ? [] : ['APS_CLIENT_SECRET']),
        ...(f.projectId    ? [] : ['ACC_PROJECT_ID']),
        ...(f.containerId  ? [] : ['MC_CONTAINER_ID']),
      ],
    },
  ];

  // The single highest-impact next action the user should take
  const nextStep = !f.clientId      ? { action: 'Set APS_CLIENT_ID',     detail: 'Register your APS app at aps.autodesk.com/myapps and copy the Client ID.' }
    : !f.clientSecret               ? { action: 'Set APS_CLIENT_SECRET', detail: 'Add the Client Secret from your APS app dashboard.' }
    : !f.projectId                  ? { action: 'Set ACC_PROJECT_ID',    detail: 'Copy the Project ID from your ACC URL: acc.autodesk.com/accounts/…/projects/[PROJECT_ID].' }
    : !f.containerId                ? { action: 'Set MC_CONTAINER_ID',   detail: 'For Model Coordination v3, the Container ID equals the ACC Project ID. Use the "Detect" button on the Connect tab.' }
    : null;

  const available   = capabilities.filter(c => c.available);
  const unavailable = capabilities.filter(c => !c.available);

  return {
    flags: f,
    summary: {
      total:       capabilities.length,
      available:   available.length,
      unavailable: unavailable.length,
      canAuth,
      canHubOps,
      canProjectOps,
      canMC,
    },
    capabilities,
    nextStep,
  };
}
