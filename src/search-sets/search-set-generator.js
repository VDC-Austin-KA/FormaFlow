/**
 * SearchSetGenerator
 *
 * Reads the Search Set library (config/search-set-library.json) and
 * pushes the relevant sets to the Model Coordination API for a given
 * model set. Only creates sets for disciplines identified in the current
 * project; skips sets that already exist unless overwrite is enabled.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_PATH = resolve(__dirname, '../../config/search-set-library.json');

const logger = createLogger('SearchSetGenerator');

export class SearchSetGenerator {
  /**
   * @param {import('../api/model-coordination.js').ModelCoordinationClient} mcClient
   * @param {object} [options]
   * @param {boolean} [options.overwriteExisting=false]
   * @param {boolean} [options.createSystemBased=true]
   * @param {boolean} [options.createFallback=true]
   * @param {boolean} [options.dryRun=false]
   */
  constructor(mcClient, options = {}) {
    this._mc = mcClient;
    this._library = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'));
    this._overwrite = options.overwriteExisting ?? false;
    this._createSystemBased = options.createSystemBased ?? true;
    this._createFallback = options.createFallback ?? true;
    this._dryRun = options.dryRun ?? false;
  }

  /**
   * Create Search Sets for all detected disciplines in a model set.
   *
   * @param {string}   modelSetId
   * @param {string[]} detectedDisciplines  - e.g. ['ARCH', 'STRUCT', 'MECH']
   * @returns {Promise<SearchSetCreationResult[]>}
   */
  async generateForDisciplines(modelSetId, detectedDisciplines) {
    logger.info(
      'Generating Search Sets for model set %s — disciplines: %s',
      modelSetId,
      detectedDisciplines.join(', ')
    );

    // Fetch existing sets so we can: (a) detect duplicates by name, AND
    // (b) recover their remote IDs so clash tests can still reference them.
    let existingSets = [];
    this.listExistingError = null;
    try {
      const res = await this._mc.listSearchSets(modelSetId);
      existingSets = res?.data ?? res?.results ?? res?.searchSets ?? (Array.isArray(res) ? res : []);
      logger.info('Fetched %d existing Search Set(s) for conflict check', existingSets.length);
    } catch (err) {
      this.listExistingError = err.message;
      logger.warn('Could not fetch existing Search Sets (%s) — proceeding without conflict check', err.message);
    }
    const existingByName = new Map(existingSets.map(s => [s.name, s.id ?? s.searchSetId]));

    const results = [];
    for (const disc of detectedDisciplines) {
      const setIds = this._library.searchSetGroups[disc] ?? [];
      for (const setId of setIds) {
        const template = this._library.searchSets.find(s => s.id === setId);
        if (!template) continue;

        // Respect system-based and fallback flags
        if (template.systemBased && !this._createSystemBased) continue;
        if (!template.systemBased && !this._createFallback) continue;

        const result = await this._createOne(modelSetId, template, existingByName);
        results.push(result);

        // Track created names + IDs to avoid double-creating within the same run
        if (result.created && result.remoteId) existingByName.set(template.name, result.remoteId);
      }
    }

    const created = results.filter(r => r.created).length;
    const skipped = results.filter(r => r.skipped).length;
    logger.info('Search Sets: %d created, %d skipped (already exist)', created, skipped);
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _createOne(modelSetId, template, existingByName) {
    // If a Search Set with this name already exists, reuse its remote ID so
    // clash-test creation can still reference it. Without this the workflow
    // silently dropped clash tests because every "skipped" set lost its id.
    if (existingByName.has(template.name) && !this._overwrite) {
      const remoteId = existingByName.get(template.name);
      logger.debug('Reusing existing Search Set: %s (remote id: %s)', template.name, remoteId);
      return { id: template.id, remoteId, name: template.name, created: false, skipped: true };
    }

    const payload = this._buildPayload(template);

    if (this._dryRun) {
      logger.info('[DRY RUN] Would create Search Set: %s', template.name);
      return { id: template.id, name: template.name, created: false, dryRun: true };
    }

    try {
      const response = await this._mc.createSearchSet(modelSetId, payload);
      const remoteId = response?.id ?? response?.data?.id ?? response?.searchSetId;
      if (!remoteId) {
        logger.warn(
          'Create Search Set %s returned no id — response: %s',
          template.name,
          JSON.stringify(response)?.slice(0, 200)
        );
        return {
          id: template.id,
          name: template.name,
          created: false,
          error: 'API response did not include a remote id (search set may not have been persisted)',
        };
      }
      logger.info('Created Search Set: %s (remote id: %s)', template.name, remoteId);
      return { id: template.id, remoteId, name: template.name, created: true };
    } catch (err) {
      logger.error('Failed to create Search Set %s: %s', template.name, err.message);
      return { id: template.id, name: template.name, created: false, error: err.message };
    }
  }

  _buildPayload(template) {
    return {
      name: template.name,
      description: template.description,
      filter: template.filter
    };
  }

  /**
   * Return a flat map of discipline → search set names for use in clash config.
   */
  getSearchSetNamesByDiscipline() {
    const map = {};
    for (const [disc, setIds] of Object.entries(this._library.searchSetGroups)) {
      map[disc] = setIds.map(id => {
        const s = this._library.searchSets.find(x => x.id === id);
        return s ? s.name : id;
      });
    }
    return map;
  }

  /**
   * Return all search set templates for a given discipline.
   */
  getTemplatesForDiscipline(discipline) {
    const ids = this._library.searchSetGroups[discipline] ?? [];
    return ids.map(id => this._library.searchSets.find(s => s.id === id)).filter(Boolean);
  }
}
