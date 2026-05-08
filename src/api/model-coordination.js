/**
 * Model Coordination API Client (v3)
 *
 * Wraps the Model Coordination REST endpoints for:
 *  - Model Sets (listing, creating, fetching versions)
 *  - Clash Sets / Clash Tests (creating tests, polling status, fetching results)
 *  - Search Sets (creating reusable property-based filters)
 *  - Grouped clash results
 *
 * API Documentation:
 *  https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash
 *
 * Sample reference:
 *  https://github.com/autodesk-platform-services/aps-clash-data-view
 *  https://github.com/autodesk-platform-services/aps-clash-data-export-pdf
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
  // No real Autodesk endpoint contains "/bim360/modelcoordination/" — common bad
  // overrides include "/bim360/modelcoordination/clash/v3" and
  // "/bim360/modelcoordination/modelset/v3". Strip the segment so the URL
  // becomes the canonical "/bim360/clash/v3" or "/bim360/modelset/v3".
  if (/\/bim360\/modelcoordination\//.test(raw)) {
    const fixed = raw.replace('/bim360/modelcoordination/', '/bim360/');
    logger.warn('Env var %s contains spurious "modelcoordination/" segment — auto-correcting: %s → %s', envVar, raw, fixed);
    return fixed;
  }

  return raw;
}

const getMcModelsetBase = () => resolveMcBase('MC_MODELSET_API_BASE', MC_CANDIDATE_BASES[0]);
const getMcClashBase    = () => resolveMcBase('MC_CLASH_API_BASE',     'https://developer.api.autodesk.com/bim360/clash/v3');

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
   * if the configured default fails with 404/403. This protects against ephemeral
   * config loss on Railway restarts.
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

  /** List all model sets in the container */
  async listModelSets() {
    return this._fetchModelset(`/containers/${this._container}/modelsets?limit=100`);
  }

  /** Get a specific model set */
  async getModelSet(modelSetId) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}`);
  }

  /** Get the latest version info for a model set */
  async getModelSetVersions(modelSetId) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/versions`);
  }

  /** Get properties/manifest for a specific model set version */
  async getModelSetVersion(modelSetId, versionIndex) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Set Views
  // ─────────────────────────────────────────────────────────────────────────

  /** List all saved views for a model set */
  async listModelSetViews(modelSetId) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/views`);
  }

  /** Get details for a specific model set view */
  async getModelSetView(modelSetId, viewId) {
    return this._fetchModelset(`/containers/${this._container}/modelsets/${modelSetId}/views/${viewId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Sets
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all model sets known to the Clash service for this container.
   * A model set that exists in modelset/v3 but is absent here has NOT had
   * clash detection enabled yet — open it in ACC → Model Coordination and
   * run (or schedule) a clash test to register it with the clash service.
   */
  async listClashModelSets() {
    return this._client.get(
      `${getMcClashBase()}/containers/${this._container}/modelsets`
    );
  }

  /**
   * Returns true if the clash service responds for this model set version.
   * The clash/v3 service does NOT expose a top-level "list model sets"
   * endpoint (calling /clash/v3/containers/{id}/modelsets returns 404 even
   * for clash-enabled containers — confirmed live). Probe the per-version
   * /tests endpoint instead, which is the canonical readiness signal.
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
   * Check if a coordination space (model set) has clash detection enabled.
   * In v3, we simply verify the model set exists.
   */
  async verifyModelSet(modelSetId) {
    return this.getModelSet(modelSetId);
  }

  // Clash Tests
  // ─────────────────────────────────────────────────────────────────────────

  /** List all clash tests. Tries versioned path first; falls back to non-versioned on 404. */
  async listClashTests(modelSetId, versionIndex) {
    const base = `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}`;
    try {
      return await this._client.get(`${base}/versions/${versionIndex}/tests`);
    } catch (err) {
      if (err.status !== 404 && !String(err.message).includes('404')) throw err;
      logger.debug('listClashTests versioned 404 — trying non-versioned path');
      return this._client.get(`${base}/tests`);
    }
  }

  /**
   * Create a new clash test.
   *
   * @param {string} modelSetId
   * @param {number} versionIndex
   * @param {ClashTestDefinition} testDef
   */
  async createClashTest(modelSetId, versionIndex, testDef) {
    logger.info('Creating clash test: %s', testDef.name);
    return this._client.post(
      `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}/tests`,
      testDef
    );
  }

  /** Get a specific clash test by ID. Falls back to scanning the list when the per-test detail endpoint 404s (v3 containers). */
  async getClashTest(modelSetId, versionIndex, testId) {
    try {
      return await this._client.get(
        `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}/tests/${testId}`
      );
    } catch (err) {
      const is404 = err.status === 404 || String(err.message).includes('404');
      if (!is404) throw err;
      logger.debug('getClashTest detail 404 for %s — falling back to list scan', testId);
      const listData = await this.listClashTests(modelSetId, versionIndex);
      const list = listData?.tests ?? listData?.clashTests ?? (Array.isArray(listData) ? listData : []);
      const found = list.find(t => (t.id ?? t.testId) === testId);
      if (!found) throw new Error(`Clash test ${testId} not found in list (detail endpoint returned 404)`);
      return found;
    }
  }

  /**
   * Poll a clash test until it completes or errors.
   *
   * @param {string} modelSetId
   * @param {number} versionIndex
   * @param {string} testId
   * @param {number} [pollIntervalMs=5000]
   * @param {number} [maxWaitMs=300000]  5-minute default timeout
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
   * Tries versioned path first; falls back to non-versioned on 404 (v3 containers).
   */
  async getClashTestResources(modelSetId, versionIndex, testId) {
    const base = `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}`;
    const versionedUrl = `${base}/versions/${versionIndex}/tests/${testId}/resources`;
    const flatUrl      = `${base}/tests/${testId}/resources`;
    try {
      return await this._client.get(versionedUrl);
    } catch (err) {
      if (err.status !== 404 && !String(err.message).includes('404')) throw err;
      logger.debug('getClashTestResources versioned 404 for %s — trying non-versioned path', testId);
      return this._client.get(flatUrl);
    }
  }

  /**
   * Fetch a signed URL for a specific clash resource document.
   * Pattern from: https://github.com/autodesk-platform-services/aps-clash-data-view
   */
  async getClashDocument(modelSetId, versionIndex, testId, documentKey) {
    return this._client.get(
      `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}/tests/${testId}/resources/${documentKey}`
    );
  }

  /**
   * Get grouped clash results for a test.
   * Tries multiple URL patterns because v3 unified-rules containers differ from legacy containers.
   * Also tries the newer /checks/{id} surface that backs the ACC "Clash checks" (BETA) UI.
   */
  async getGroupedClashes(modelSetId, versionIndex, testId) {
    const base = `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}`;
    const candidates = [
      `${base}/versions/${versionIndex}/tests/${testId}/groups`,
      `${base}/tests/${testId}/groups`,
      `${base}/versions/${versionIndex}/tests/${testId}/clashinstances`,
      `${base}/tests/${testId}/clashinstances`,
      `${base}/checks/${testId}/groups`,
      `${base}/checks/${testId}/clashinstances`,
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

  /**
   * List the named "Clash checks" visible in the ACC Model Coordination UI
   * under the Clashes > Clash checks (BETA) tab.
   * Tries multiple known and candidate API base URLs.
   * Returns an empty array if the endpoint doesn't exist for any tried base.
   */
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

  /**
   * Get grouped results for a named clash check (from the Clash checks BETA UI).
   */
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

  // ─────────────────────────────────────────────────────────────────────────
  // Search Sets (ACC / Forma v3)
  //
  // Live observation: GET .../modelsets/{id}/searchsets returns 404 even when
  // clash tests for the same model set work. Clash tests use a versioned path
  // (.../versions/{v}/tests) and search sets follow the same pattern. We try
  // the versioned URL first and fall back to the flat URL on 404 so we
  // remain compatible if Autodesk later flattens the path.
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

  /** List existing Search Sets for a model set version. */
  async listSearchSets(modelSetId, versionIndex) {
    return this._searchSetRequest('GET', modelSetId, versionIndex, '');
  }

  /** Create a new Search Set (reusable property-based filter). */
  async createSearchSet(modelSetId, versionIndex, searchSetDef) {
    logger.info('Creating Search Set: %s', searchSetDef?.name);
    return this._searchSetRequest('POST', modelSetId, versionIndex, '', searchSetDef);
  }

  /** Update an existing Search Set. */
  async updateSearchSet(modelSetId, versionIndex, searchSetId, searchSetDef) {
    return this._searchSetRequest('PATCH', modelSetId, versionIndex, searchSetId, searchSetDef);
  }

  /** Delete a Search Set. */
  async deleteSearchSet(modelSetId, versionIndex, searchSetId) {
    return this._searchSetRequest('DELETE', modelSetId, versionIndex, searchSetId);
  }

  /**
   * Probe the /searchsets endpoint once and cache the result. Used to
   * short-circuit the bulk-create loop when the API surface for this
   * container does not support /searchsets (which is the case for the
   * modern v3 unified-rules model — see getClashRules below).
   */
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
  //   PUT  same URL with If-Match: <checksum>                → update rules
  // The body shape is { checksum, documentRules, fileRules, clashType, clashDisabled }.
  // Tests run automatically against the rules whenever a view is published.
  // ─────────────────────────────────────────────────────────────────────────

  _rulesUrl(modelSetId) {
    return `${getMcClashBase()}/containers/${this._container}/modelsets/${modelSetId}/rules`;
  }

  /** Get the current clash-rules document for a model set. */
  async getClashRules(modelSetId) {
    return this._client.get(this._rulesUrl(modelSetId));
  }

  /**
   * Update the clash-rules document.
   * Live-tested against the v3 OTG container (May 2026):
   *   - PUT  → 404 (not supported)
   *   - POST → 400 "checksum required" if body omits it; otherwise accepts.
   * The checksum is required as a body field (not as If-Match header) and
   * acts as the optimistic-concurrency guard.
   */
  async putClashRules(modelSetId, rulesDoc, ifMatchChecksum) {
    const body = { ...rulesDoc };
    if (ifMatchChecksum && !body.checksum) body.checksum = ifMatchChecksum;
    return this._client.post(this._rulesUrl(modelSetId), body);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
