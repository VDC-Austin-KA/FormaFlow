/**
 * Model Coordination API Client (v3)
 *
 * Wraps the Model Coordination REST endpoints for:
 *  - Model Sets (listing, creating, updating, fetching versions)
 *  - Model Set Views (listing, creating)
 *  - Clash Tests (listing, polling status, fetching results)
 *  - Clash Groups: Closed, Assigned, Shared (screenshots/jobs)
 *  - Search Sets / Clash Rules (legacy containers and v3 unified-rules)
 *
 * API Documentation:
 *  https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash
 *
 * Key v3 API facts (confirmed from official docs):
 *  - Model Set service base:  https://developer.api.autodesk.com/bim360/modelset/v3
 *  - Clash service base:      https://developer.api.autodesk.com/bim360/clash/v3
 *  - All paths start with:    /containers/{containerId}/...
 *  - Versions use field:      version  (integer, NOT versionIndex)
 *  - Versions list key:       modelSetVersions  (NOT versions)
 *  - Model sets list key:     modelSets
 *  - Views list key:          modelSetViews
 *  - Clash tests list key:    tests
 *  - Pagination:              pageLimit + continuationToken
 *  - Clash test creation:     auto-triggered when a model set version publishes
 *                             (no standalone POST /tests for v3 containers)
 *  - Clash test GET:          /containers/{c}/tests/{testId}  (NOT under /modelsets/)
 *  - Closed clash groups:     /containers/{c}/tests/{testId}/clashes/closed
 *  - Assigned clash groups:   /containers/{c}/tests/{testId}/clashes/assigned
 *  - Auth:                    3-legged OAuth only; 2-legged returns 403
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ModelCoordination');

// ─────────────────────────────────────────────────────────────────────────────
// URL resolution for Model Coordination v3 API
// ─────────────────────────────────────────────────────────────────────────────
// There are two known-working base URL patterns for MC v3:
//   1. https://developer.api.autodesk.com/bim360/modelset/v3   (legacy BIM360 / early ACC)
//   2. https://developer.api.autodesk.com/modelcoordination/v3 (modern ACC / Forma)
//
// Which one works depends on the specific ACC account configuration.
// The MC_CANDIDATE_BASES array stores both so the container detection route
// can try each until one succeeds, then persist the winner.
//
// The only path that's genuinely *wrong* is the deprecated v2:
//   - .../bim360/modelcoordination/v2
// That gets auto-corrected to the primary candidate.

export const MC_CANDIDATE_BASES = [
  'https://developer.api.autodesk.com/bim360/modelset/v3',
  'https://developer.api.autodesk.com/modelcoordination/v3',
];

export function resolveMcBase(envVar, fallback) {
  const raw = (process.env[envVar] ?? '').trim();
  if (!raw) return fallback;

  // Auto-correct the deprecated v2 path
  if (raw.includes('/bim360/modelcoordination/v2')) {
    logger.warn('Env var %s contains deprecated v2 path — auto-correcting: %s → %s', envVar, raw, fallback);
    return fallback;
  }

  // Auto-correct any URL with the spurious "modelcoordination/" segment.
  if (/\/bim360\/modelcoordination\//.test(raw)) {
    const fixed = raw.replace('/bim360/modelcoordination/', '/bim360/');
    logger.warn('Env var %s contains spurious "modelcoordination/" segment — auto-correcting: %s → %s', envVar, raw, fixed);
    return fixed;
  }

  return raw;
}

const getMcModelsetBase = () => resolveMcBase('MC_MODELSET_API_BASE', MC_CANDIDATE_BASES[0]);
const getMcClashBase    = () => resolveMcBase('MC_CLASH_API_BASE', 'https://developer.api.autodesk.com/bim360/clash/v3');

export class ModelCoordinationClient {
  /**
   * @param {import('./aps-client.js').APSClient} apsClient
   * @param {string} containerId - MC Container ID (from ACC project settings)
   */
  constructor(apsClient, containerId = process.env.MC_CONTAINER_ID) {
    if (!containerId) throw new Error('MC_CONTAINER_ID must be set');
    this._client = apsClient;
    this._container = containerId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fallback Fetcher
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Automatically falls back between bim360/modelset/v3 and modelcoordination/v3
   * if the configured default fails with 404/403.
   */
  async _fetchModelset(pathSuffix) {
    const defaultBase = getMcModelsetBase();
    const candidates = [defaultBase, ...MC_CANDIDATE_BASES].filter((v, i, a) => a.indexOf(v) === i);

    let lastError;
    for (const base of candidates) {
      const url = `${base}${pathSuffix}`;
      try {
        logger.debug('GET %s', url);
        return await this._client.get(url);
      } catch (err) {
        lastError = err;
        if (err.status !== 404 && err.status !== 403) throw err;
      }
    }
    throw lastError;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Sets
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all model sets in the container.
   * Response: { modelSets: [...], page: { continuationToken } }
   */
  async listModelSets(opts = {}) {
    const qs = new URLSearchParams();
    qs.set('pageLimit', String(opts.pageLimit ?? 100));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    if (opts.includeDisabled)   qs.set('includeDisabled', 'true');
    if (opts.name)              qs.set('name', opts.name);
    if (opts.folderUrn)         qs.set('folderUrn', opts.folderUrn);
    return this._fetchModelset(`/containers/${this._container}/modelsets?${qs}`);
  }

  /** Get a specific model set by ID. */
  async getModelSet(modelSetId) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}`);
  }

  /**
   * Create a new model set.
   * Returns: ModelSetJob { jobId }  — async, poll the job endpoint for completion.
   * @param {object} body - { name, description?, isDisabled?, modelSetId?, folders: [{ folderUrn }] }
   */
  async createModelSet(body) {
    logger.info('Creating model set: %s', body.name);
    const base = getMcModelsetBase();
    return this._client.post(`${base}/containers/${this._container}/modelsets`, body);
  }

  /**
   * Update a model set's name/description.
   * Returns: ModelSetJob { jobId }
   * @param {string} modelSetId
   * @param {object} body - { oldName?, newName?, oldDescription?, newDescription? }
   */
  async updateModelSet(modelSetId, body) {
    logger.info('Updating model set: %s', modelSetId);
    const base = getMcModelsetBase();
    return this._client.patch(`${base}/containers/${this._container}/modelsets/${modelSetId}`, body);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Set Versions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all versions for a model set.
   * Response: { modelSetVersions: [...], page: { continuationToken } }
   * Each version has field: version (integer), status, createTime
   */
  async getModelSetVersions(modelSetId, opts = {}) {
    const qs = new URLSearchParams();
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    const suffix = qs.toString() ? `?${qs}` : '';
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/versions${suffix}`);
  }

  /**
   * Get a specific model set version.
   * Pass 'latest' to get the tip version without knowing the version number.
   * Response includes documentVersions array.
   */
  async getModelSetVersion(modelSetId, version) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/versions/${version}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Set Views
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all views for a model set.
   * Response: { modelSetViews: [...], page: { continuationToken } }
   */
  async listModelSetViews(modelSetId, opts = {}) {
    const qs = new URLSearchParams();
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    if (opts.createdBy)         qs.set('createdBy', opts.createdBy);
    if (opts.isPrivate != null) qs.set('isPrivate', String(opts.isPrivate));
    const suffix = qs.toString() ? `?${qs}` : '';
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/views${suffix}`);
  }

  /** Get details for a specific model set view. */
  async getModelSetView(modelSetId, viewId) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/views/${viewId}`);
  }

  /**
   * Create a new model set view.
   * Returns: ModelSetViewJob { jobId } — async.
   * @param {string} modelSetId
   * @param {object} body - { name, description?, isPrivate?, screenshotId?, viewId?, definition: [{ lineageUrn, viewableName? }] }
   */
  async createModelSetView(modelSetId, body) {
    logger.info('Creating model set view: %s', body.name);
    const base = getMcModelsetBase();
    return this._client.post(`${base}/containers/${this._container}/modelsets/${modelSetId}/views`, body);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Tests
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if the clash service responds for this model set version.
   */
  async isClashEnabled(modelSetId, versionIndex = 1) {
    try {
      await this.listClashTests(modelSetId, versionIndex);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify a model set exists (used to confirm clash is wired up).
   */
  async verifyModelSet(modelSetId) {
    return this.getModelSet(modelSetId);
  }

  /**
   * List all clash tests for a model set.
   * Primary v3 path: GET /clash/v3/containers/{c}/modelsets/{m}/tests  (non-versioned)
   * Fallback:        GET /clash/v3/containers/{c}/modelsets/{m}/versions/{v}/tests  (versioned)
   * Response: { tests: [...] }
   */
  async listClashTests(modelSetId, versionIndex) {
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/modelsets/${modelSetId}`;

    // Try non-versioned path first (primary v3 documented path)
    try {
      return await this._client.get(`${base}/tests`);
    } catch (err) {
      const is404 = err.status === 404 || String(err.message).includes('404');
      if (!is404) throw err;
      logger.debug('listClashTests non-versioned 404 — trying versioned path');
    }

    // Fall back to versioned path (legacy containers)
    if (versionIndex) {
      return this._client.get(`${base}/versions/${versionIndex}/tests`);
    }

    throw new Error(`listClashTests: no valid path found for modelSet ${modelSetId}`);
  }

  /**
   * Create a new clash test.
   *
   * NOTE: In v3 "unified-rules" containers, clash tests are auto-created when a
   * model set version publishes — there is no standalone POST /tests endpoint.
   * This method tries the POST and gracefully handles 404/405 for v3 containers.
   */
  async createClashTest(modelSetId, versionIndex, testDef) {
    logger.info('Creating clash test: %s', testDef.name);
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/modelsets/${modelSetId}`;

    // Try versioned path first (legacy containers support this)
    try {
      return await this._client.post(`${base}/versions/${versionIndex}/tests`, testDef);
    } catch (err) {
      const isNotSupported = err.status === 404 || err.status === 405
        || String(err.message).includes('404') || String(err.message).includes('405');
      if (!isNotSupported) throw err;
      logger.debug('createClashTest versioned POST not supported — trying non-versioned path');
    }

    // Try non-versioned path
    try {
      return await this._client.post(`${base}/tests`, testDef);
    } catch (err) {
      const isNotSupported = err.status === 404 || err.status === 405
        || String(err.message).includes('404') || String(err.message).includes('405');
      if (!isNotSupported) throw err;
      // v3 containers auto-create tests — signal this to the caller
      logger.warn(
        'createClashTest: POST /tests returned %s for model set %s. ' +
        'This container uses the v3 unified-rules model — clash tests are auto-generated ' +
        'when model set versions publish. No manual creation needed.',
        err.status, modelSetId
      );
      return { _autoCreated: true, message: 'v3 container: clash tests are auto-generated on version publish' };
    }
  }

  /**
   * Get a specific clash test by ID.
   *
   * Primary v3 path:  GET /clash/v3/containers/{c}/tests/{testId}  (container-level, not under modelsets)
   * Fallback paths:   versioned, then list scan.
   */
  async getClashTest(modelSetId, versionIndex, testId) {
    const clashBase = getMcClashBase();

    // Primary: container-level path (v3 documented endpoint)
    const containerPath = `${clashBase}/containers/${this._container}/tests/${testId}`;
    try {
      return await this._client.get(containerPath);
    } catch (err) {
      const is404 = err.status === 404 || String(err.message).includes('404');
      if (!is404) throw err;
      logger.debug('getClashTest container-level 404 for %s — trying modelset-versioned path', testId);
    }

    // Fallback: versioned path (legacy containers)
    const versionedPath = `${clashBase}/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}/tests/${testId}`;
    try {
      return await this._client.get(versionedPath);
    } catch (err) {
      const is404 = err.status === 404 || String(err.message).includes('404');
      if (!is404) throw err;
      logger.debug('getClashTest versioned 404 for %s — falling back to list scan', testId);
    }

    // Last resort: scan the list
    const listData = await this.listClashTests(modelSetId, versionIndex);
    const list = listData?.tests ?? listData?.clashTests ?? (Array.isArray(listData) ? listData : []);
    const found = list.find(t => (t.id ?? t.testId) === testId);
    if (!found) throw new Error(`Clash test ${testId} not found (all paths returned 404)`);
    return found;
  }

  /**
   * Poll a clash test until it completes or errors.
   */
  async waitForClashTest(modelSetId, versionIndex, testId, pollIntervalMs = 5000, maxWaitMs = 300_000, onStatus = null) {
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;
    let lastStatus = null;
    while (Date.now() < deadline) {
      attempt++;
      const test = await this.getClashTest(modelSetId, versionIndex, testId);
      const status = test?.status ?? test?.data?.status ?? 'UNKNOWN';
      logger.debug('Clash test %s — status: %s (attempt %d)', testId, status, attempt);
      if (status !== lastStatus) {
        lastStatus = status;
        if (onStatus) onStatus(status, attempt);
      }

      const norm = String(status).toUpperCase();
      if (norm === 'COMPLETE' || norm === 'COMPLETED' || norm === 'SUCCESS') return test;
      if (norm === 'FAILED' || norm === 'ERROR' || norm === 'CANCELLED') {
        throw new Error(`Clash test ${testId} failed with status: ${status}`);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Clash test ${testId} timed out after ${maxWaitMs}ms (last status: ${lastStatus ?? 'unknown'})`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Results
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get resources (raw clash documents) for a clash test.
   */
  async getClashTestResources(modelSetId, versionIndex, testId) {
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/modelsets/${modelSetId}`;
    const versionedUrl = `${base}/versions/${versionIndex}/tests/${testId}/resources`;
    const flatUrl      = `${base}/tests/${testId}/resources`;
    try {
      return await this._client.get(versionedUrl);
    } catch (err) {
      if (err.status !== 404 && !String(err.message).includes('404')) throw err;
      logger.debug('getClashTestResources versioned 404 — trying non-versioned path');
      return this._client.get(flatUrl);
    }
  }

  /**
   * Fetch a signed URL for a specific clash resource document.
   */
  async getClashDocument(modelSetId, versionIndex, testId, documentKey) {
    const clashBase = getMcClashBase();
    return this._client.get(
      `${clashBase}/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}/tests/${testId}/resources/${documentKey}`
    );
  }

  /**
   * Get grouped clash results.
   *
   * Primary path (documented as of 2026):
   *   GET /clash/v3/containers/{c}/modelsets/{m}/clashes/grouped
   *   Returns the model-set-wide grouped clash report — one entry per
   *   clash group with `groupingValues[]` (the hierarchy values from the
   *   active Saved Clash Check), and the verbatim UI-shown `name`.
   *
   * Fallbacks (legacy / pipeline variants):
   *   /tests/{testId}/groups, /clashinstances, /checks/{testId}/...
   *
   * @param {string} modelSetId
   * @param {number} [versionIndex]  - only used by legacy fallback paths
   * @param {string} [testId]        - filter to a single clash test
   * @param {object} [opts]          - { pageLimit, continuationToken }
   */
  async getGroupedClashes(modelSetId, versionIndex, testId, opts = {}) {
    const clashBase = getMcClashBase();
    const containerBase = `${clashBase}/containers/${this._container}`;
    const modelsetBase  = `${containerBase}/modelsets/${modelSetId}`;

    // Build query string for the documented endpoint
    const qs = new URLSearchParams();
    if (testId)                 qs.set('clashTestId', testId);
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    const groupedSuffix = qs.toString() ? `?${qs}` : '';

    const candidates = [
      // PRIMARY — documented v3 endpoint
      `${modelsetBase}/clashes/grouped${groupedSuffix}`,
      // Documented v3 clash group paths (container-level)
      `${containerBase}/tests/${testId}/clashes/assigned`,
      `${containerBase}/tests/${testId}/clashes/closed`,
      // Legacy paths (modelset-scoped)
      `${modelsetBase}/versions/${versionIndex}/tests/${testId}/groups`,
      `${modelsetBase}/tests/${testId}/groups`,
      `${modelsetBase}/versions/${versionIndex}/tests/${testId}/clashinstances`,
      `${modelsetBase}/tests/${testId}/clashinstances`,
      // Clash checks BETA surface
      `${modelsetBase}/checks/${testId}/groups`,
      `${modelsetBase}/checks/${testId}/clashinstances`,
    ];

    let lastErr;
    for (const url of candidates) {
      try {
        const result = await this._client.get(url);
        logger.debug('getGroupedClashes succeeded at: %s', url);
        return result;
      } catch (err) {
        const is404 = err.status === 404 || String(err.message).includes('404');
        if (!is404) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Groups: batch assign (Stage 5 — auto-assign to issues)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Batch-assign clash groups to an ACC Issue.
   * POST /clash/v3/containers/{c}/tests/{testId}/clashes:assign
   * Body: { issueId, groupIds: [string] }
   *
   * @param {string}   testId
   * @param {string[]} groupIds  - clash group IDs from getGroupedClashes
   * @param {string}   issueId   - ACC Issue ID to link the groups to
   */
  async assignClashGroupsToIssue(testId, groupIds, issueId) {
    const clashBase = getMcClashBase();
    return this._client.post(
      `${clashBase}/containers/${this._container}/tests/${testId}/clashes:assign`,
      { issueId, groupIds }
    );
  }

  /**
   * Batch-close (mark "Not an issue") a set of clash groups.
   * POST /clash/v3/containers/{c}/tests/{testId}/clashes:close
   * Body: { reason, groupIds: [string] }
   */
  async closeClashGroups(testId, groupIds, reason = 'NotAnIssue') {
    const clashBase = getMcClashBase();
    return this._client.post(
      `${clashBase}/containers/${this._container}/tests/${testId}/clashes:close`,
      { reason, groupIds }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Groups: Closed
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List closed (dismissed) clash groups for a specific clash test.
   * GET /clash/v3/containers/{c}/tests/{testId}/clashes/closed
   * Response: { modelSetId, modelSetVersion, groups: [{ id, originalClashTestId, createdAtVersion, existing[], resolved[] }] }
   *
   * @param {string} testId
   * @param {object} [opts] - { pageLimit, continuationToken }
   */
  async getClosedClashGroups(testId, opts = {}) {
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/tests/${testId}/clashes/closed`;
    const qs = new URLSearchParams();
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    const url = qs.toString() ? `${base}?${qs}` : base;
    return this._client.get(url);
  }

  /**
   * List closed clash groups model-set-wide (all tests).
   * GET /clash/v3/containers/{c}/modelsets/{m}/clashes/closed
   * Supports filter params: clashTestId, reason, createdBy, after, before, sort
   */
  async listClosedClashGroups(modelSetId, opts = {}) {
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/modelsets/${modelSetId}/clashes/closed`;
    const qs = new URLSearchParams();
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    if (opts.clashTestId)       qs.set('clashTestId', opts.clashTestId);
    if (opts.reason)            qs.set('reason', opts.reason);
    if (opts.createdBy)         qs.set('createdBy', opts.createdBy);
    if (opts.after)             qs.set('after', opts.after);
    if (opts.before)            qs.set('before', opts.before);
    if (opts.sort)              qs.set('sort', opts.sort);
    const url = qs.toString() ? `${base}?${qs}` : base;
    return this._client.get(url);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Groups: Assigned
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List assigned clash groups for a specific clash test.
   * GET /clash/v3/containers/{c}/tests/{testId}/clashes/assigned
   * Assigned clash groups are linked to ACC Issues.
   * Response: { modelSetId, modelSetVersion, groups: [{ id, originalClashTestId, createdAtVersion, existing[], resolved[] }] }
   *
   * @param {string} testId
   * @param {object} [opts] - { pageLimit, continuationToken }
   */
  async getAssignedClashGroups(testId, opts = {}) {
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/tests/${testId}/clashes/assigned`;
    const qs = new URLSearchParams();
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    const url = qs.toString() ? `${base}?${qs}` : base;
    return this._client.get(url);
  }

  /**
   * Get full issue details for a set of assigned clash group IDs.
   * POST /clash/v3/containers/{c}/tests/{testId}/clashes/assigned
   * Body: Array<string> of group IDs
   * Response: AssignedClashGroupClashData (includes issueId, clashData, etc.)
   */
  async getAssignedClashGroupDetails(testId, groupIds) {
    const clashBase = getMcClashBase();
    return this._client.post(
      `${clashBase}/containers/${this._container}/tests/${testId}/clashes/assigned`,
      groupIds
    );
  }

  /**
   * List assigned clash groups model-set-wide (all tests).
   * GET /clash/v3/containers/{c}/modelsets/{m}/clashes/assigned
   * Supports filter params: clashTestId, issueId, createdBy, after, before, sort
   */
  async listAssignedClashGroups(modelSetId, opts = {}) {
    const clashBase = getMcClashBase();
    const base = `${clashBase}/containers/${this._container}/modelsets/${modelSetId}/clashes/assigned`;
    const qs = new URLSearchParams();
    if (opts.pageLimit)         qs.set('pageLimit', String(opts.pageLimit));
    if (opts.continuationToken) qs.set('continuationToken', opts.continuationToken);
    if (opts.clashTestId)       qs.set('clashTestId', opts.clashTestId);
    if (opts.issueId)           qs.set('issueId', opts.issueId);
    if (opts.createdBy)         qs.set('createdBy', opts.createdBy);
    if (opts.after)             qs.set('after', opts.after);
    if (opts.before)            qs.set('before', opts.before);
    if (opts.sort)              qs.set('sort', opts.sort);
    const url = qs.toString() ? `${base}?${qs}` : base;
    return this._client.get(url);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Groups: Shared (job status + screenshots)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Poll an async clash group operation job.
   * GET /clash/v3/containers/{c}/clashes/jobs/{jobId}
   * Response: ClashGroupJob { status }
   */
  async getClashGroupJobStatus(jobId) {
    const clashBase = getMcClashBase();
    return this._client.get(`${clashBase}/containers/${this._container}/clashes/jobs/${jobId}`);
  }

  /**
   * Upload a screenshot for use with clash groups or model set views.
   * POST /modelset/v3/containers/{c}/modelsets/{m}/screenshots
   * Body: PNG image (image/png content-type)
   * Response: ScreenshotToken { id: string }
   */
  async uploadScreenshot(modelSetId, pngBuffer) {
    const base = getMcModelsetBase();
    return this._client.request(
      `${base}/containers/${this._container}/modelsets/${modelSetId}/screenshots`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: pngBuffer,
      }
    );
  }

  /**
   * Retrieve a screenshot by ID.
   * GET /modelset/v3/containers/{c}/modelsets/{m}/screenshots/{screenShotId}
   * Returns: PNG image stream
   */
  async getScreenshot(modelSetId, screenShotId) {
    const base = getMcModelsetBase();
    const token = await this._client.getToken();
    const url = `${base}/containers/${this._container}/modelsets/${modelSetId}/screenshots/${screenShotId}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Screenshot fetch ${response.status}: ${url}`);
    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Sets (listing model sets known to the Clash service)
  // ─────────────────────────────────────────────────────────────────────────

  async listClashModelSets() {
    return this._client.get(
      `${getMcClashBase()}/containers/${this._container}/modelsets`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search Sets (legacy containers — /searchsets endpoint)
  // ─────────────────────────────────────────────────────────────────────────

  _searchSetUrl(modelSetId, versionIndex, suffix = '') {
    const base = `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}`;
    const tail = `searchsets${suffix ? '/' + suffix : ''}`;
    return versionIndex != null
      ? `${base}/versions/${versionIndex}/${tail}`
      : `${base}/${tail}`;
  }

  async _searchSetRequest(method, modelSetId, versionIndex, suffix, body) {
    const versionedUrl = this._searchSetUrl(modelSetId, versionIndex, suffix);
    const flatUrl      = this._searchSetUrl(modelSetId, null, suffix);
    const call = url => method === 'GET'    ? this._client.get(url)
      : method === 'POST'   ? this._client.post(url, body)
      : method === 'PATCH'  ? this._client.patch(url, body)
      : method === 'DELETE' ? this._client.delete(url)
      : Promise.reject(new Error(`Unsupported method ${method}`));

    if (versionIndex == null) return call(flatUrl);
    try {
      return await call(versionedUrl);
    } catch (err) {
      const is404 = err.status === 404 || String(err.message).includes('404');
      if (!is404) throw err;
      logger.debug('searchsets versioned URL 404, falling back to flat: %s', flatUrl);
      return call(flatUrl);
    }
  }

  async listSearchSets(modelSetId, versionIndex) {
    return this._searchSetRequest('GET', modelSetId, versionIndex, '');
  }

  async createSearchSet(modelSetId, versionIndex, searchSetDef) {
    logger.info('Creating Search Set: %s', searchSetDef?.name);
    return this._searchSetRequest('POST', modelSetId, versionIndex, '', searchSetDef);
  }

  async updateSearchSet(modelSetId, versionIndex, searchSetId, searchSetDef) {
    return this._searchSetRequest('PATCH', modelSetId, versionIndex, searchSetId, searchSetDef);
  }

  async deleteSearchSet(modelSetId, versionIndex, searchSetId) {
    return this._searchSetRequest('DELETE', modelSetId, versionIndex, searchSetId);
  }

  async isSearchSetsApiAvailable(modelSetId, versionIndex) {
    if (this._searchSetsAvailable != null) return this._searchSetsAvailable;
    try {
      await this.listSearchSets(modelSetId, versionIndex);
      this._searchSetsAvailable = true;
    } catch (err) {
      const is404 = err.status === 404 || String(err.message).includes('404');
      this._searchSetsAvailable = !is404;
      if (!is404) throw err;
    }
    return this._searchSetsAvailable;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Rules (v3 unified-rules document)
  //
  // In the modern Forma / ACC v3 API, separate "search sets" + "clash tests"
  // have been consolidated into a single /rules document per model set.
  //   GET  /clash/v3/containers/{c}/modelsets/{m}/rules      → current rules
  //   POST same URL with checksum in body                    → update rules
  // The body shape is { checksum, documentRules, fileRules, clashType, clashDisabled }.
  // Tests run automatically against the rules whenever a view is published.
  // ─────────────────────────────────────────────────────────────────────────

  _rulesUrl(modelSetId) {
    return `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}/rules`;
  }

  async getClashRules(modelSetId) {
    return this._client.get(this._rulesUrl(modelSetId));
  }

  /**
   * Update the clash-rules document.
   * Checksum is required as a body field (optimistic-concurrency guard).
   */
  async putClashRules(modelSetId, rulesDoc, ifMatchChecksum) {
    const body = { ...rulesDoc };
    if (ifMatchChecksum && !body.checksum) body.checksum = ifMatchChecksum;
    return this._client.post(this._rulesUrl(modelSetId), body);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Checks (BETA — named checks visible in ACC Model Coordination UI)
  // ─────────────────────────────────────────────────────────────────────────

  async listClashChecks(modelSetId) {
    const legacyBase = getMcClashBase();
    const bContainer = this._container.startsWith('b.') ? this._container : `b.${this._container}`;
    const baseCandidates = [
      `${legacyBase}/containers/${this._container}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/model-coordination/v2/containers/${this._container}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/model-coordination/v2/containers/${bContainer}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/construction/clash/v1/containers/${this._container}/modelsets/${modelSetId}`,
      `https://developer.api.autodesk.com/bim360/clash/v4/containers/${this._container}/modelsets/${modelSetId}`,
    ];
    for (const base of baseCandidates) {
      for (const suffix of ['/checks', '/clashchecks']) {
        try {
          const data = await this._client.get(`${base}${suffix}`);
          const arr = Array.isArray(data) ? data
            : Array.isArray(data.checks) ? data.checks
            : Array.isArray(data.data) ? data.data
            : Array.isArray(data.items) ? data.items
            : [];
          logger.debug('listClashChecks found %d checks at %s%s', arr.length, base, suffix);
          return arr;
        } catch (err) {
          const is404 = err.status === 404 || String(err.message).includes('404');
          if (!is404) throw err;
        }
      }
    }
    return [];
  }

  async getClashCheckResults(modelSetId, checkId) {
    const base = `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}`;
    for (const url of [
      `${base}/checks/${checkId}/groups`,
      `${base}/checks/${checkId}/clashinstances`,
      `${base}/checks/${checkId}`,
    ]) {
      try {
        const result = await this._client.get(url);
        logger.debug('getClashCheckResults succeeded at: %s', url);
        return result;
      } catch (err) {
        const is404 = err.status === 404 || String(err.message).includes('404');
        if (!is404) throw err;
      }
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClashTestDefinition
 * @property {string}   name          - Human-readable test name
 * @property {string[]} selectionA    - Search Set IDs or model scope for side A
 * @property {string[]} selectionB    - Search Set IDs or model scope for side B
 * @property {number}   [tolerance]   - Clash tolerance in project units
 * @property {string}   [type]        - 'hard' | 'clearance' | 'duplicate'
 */

/**
 * @typedef {Object} SearchSetDefinition
 * @property {string}          name    - Display name for the Search Set
 * @property {SearchSetFilter} filter  - Property-based filter definition
 */

/**
 * @typedef {Object} SearchSetFilter
 * @property {string}           operator   - 'and' | 'or'
 * @property {FilterCondition[]} conditions
 */

/**
 * @typedef {Object} FilterCondition
 * @property {string} property  - Property name (e.g. 'Category', 'System Classification')
 * @property {string} operator  - 'equals' | 'contains' | 'in' | 'startsWith'
 * @property {*}      value     - Filter value
 */
