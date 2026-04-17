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

const MC_MODELSET_BASE =
  process.env.MC_MODELSET_API_BASE ??
  'https://developer.api.autodesk.com/bim360/modelcoordination/modelset/v3';

const MC_CLASH_BASE =
  process.env.MC_CLASH_API_BASE ??
  'https://developer.api.autodesk.com/bim360/modelcoordination/clash/v3';

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
  // Model Sets
  // ─────────────────────────────────────────────────────────────────────────

  /** List all model sets in the container */
  async listModelSets() {
    const url = `${MC_MODELSET_BASE}/containers/${this._container}/modelsets`;
    logger.debug('GET %s', url);
    return this._client.get(url);
  }

  /** Get a specific model set */
  async getModelSet(modelSetId) {
    return this._client.get(
      `${MC_MODELSET_BASE}/containers/${this._container}/modelsets/${modelSetId}`
    );
  }

  /** Get the latest version info for a model set */
  async getModelSetVersions(modelSetId) {
    return this._client.get(
      `${MC_MODELSET_BASE}/containers/${this._container}/modelsets/${modelSetId}/versions`
    );
  }

  /** Get properties/manifest for a specific model set version */
  async getModelSetVersion(modelSetId, versionIndex) {
    return this._client.get(
      `${MC_MODELSET_BASE}/containers/${this._container}/modelsets/${modelSetId}/versions/${versionIndex}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Tests (Clash Sets in ACC terminology)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all clash tests for a model set version.
   * Each "clash test" defines a pair of Search Sets to test against each other.
   */
  async listClashTests(modelSetId, versionIndex) {
    return this._client.get(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/versions/${versionIndex}/tests`
    );
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
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/versions/${versionIndex}/tests`,
      testDef
    );
  }

  /** Get a specific clash test by ID */
  async getClashTest(modelSetId, versionIndex, testId) {
    return this._client.get(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/versions/${versionIndex}/tests/${testId}`
    );
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
  async waitForClashTest(modelSetId, versionIndex, testId, pollIntervalMs = 5000, maxWaitMs = 300_000) {
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      const test = await this.getClashTest(modelSetId, versionIndex, testId);
      const status = test?.status ?? test?.data?.status;
      logger.debug('Clash test %s — status: %s (attempt %d)', testId, status, attempt);

      if (status === 'COMPLETE' || status === 'complete') return test;
      if (status === 'FAILED' || status === 'ERROR') {
        throw new Error(`Clash test ${testId} failed with status: ${status}`);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Clash test ${testId} timed out after ${maxWaitMs}ms`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Clash Results
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get resources (raw clash documents) for a clash test.
   * Returns document keys that can be fetched individually.
   */
  async getClashTestResources(modelSetId, versionIndex, testId) {
    return this._client.get(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/versions/${versionIndex}/tests/${testId}/resources`
    );
  }

  /**
   * Fetch a signed URL for a specific clash resource document.
   * Pattern from: https://github.com/autodesk-platform-services/aps-clash-data-view
   */
  async getClashDocument(modelSetId, versionIndex, testId, documentKey) {
    return this._client.get(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/versions/${versionIndex}/tests/${testId}/resources/${documentKey}`
    );
  }

  /**
   * Get grouped clash results for a test.
   * Groups are organized by system/level/zone for structured output.
   */
  async getGroupedClashes(modelSetId, versionIndex, testId) {
    return this._client.get(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/versions/${versionIndex}/tests/${testId}/groups`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search Sets (ACC / Forma — March 2026+)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List existing Search Sets for a model set.
   * NOTE: Search Sets API endpoints were added in ACC March 2026 update.
   * Monitor: https://aps.autodesk.com/en/docs/acc/v1/overview/release-notes/
   */
  async listSearchSets(modelSetId) {
    return this._client.get(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/searchsets`
    );
  }

  /**
   * Create a new Search Set (reusable property-based filter).
   *
   * @param {string} modelSetId
   * @param {SearchSetDefinition} searchSetDef
   */
  async createSearchSet(modelSetId, searchSetDef) {
    logger.info('Creating Search Set: %s', searchSetDef.name);
    return this._client.post(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/searchsets`,
      searchSetDef
    );
  }

  /**
   * Update an existing Search Set.
   */
  async updateSearchSet(modelSetId, searchSetId, searchSetDef) {
    return this._client.patch(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/searchsets/${searchSetId}`,
      searchSetDef
    );
  }

  /**
   * Delete a Search Set.
   */
  async deleteSearchSet(modelSetId, searchSetId) {
    return this._client.delete(
      `${MC_CLASH_BASE}/containers/${this._container}/clashsets/${modelSetId}/searchsets/${searchSetId}`
    );
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
