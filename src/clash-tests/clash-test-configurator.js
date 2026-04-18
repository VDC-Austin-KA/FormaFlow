/**
 * ClashTestConfigurator
 *
 * Selects and creates clash tests in ACC/Forma based on:
 *  1. Detected disciplines for the current model set
 *  2. The auto-pairing matrix in config/clash-test-templates.json
 *  3. Available Search Set remote IDs (previously created by SearchSetGenerator)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = resolve(__dirname, '../../config/clash-test-templates.json');

const logger = createLogger('ClashTestConfigurator');

export class ClashTestConfigurator {
  /**
   * @param {import('../api/model-coordination.js').ModelCoordinationClient} mcClient
   * @param {object} [options]
   * @param {boolean} [options.subTestsEnabled=true]
   * @param {boolean} [options.dryRun=false]
   * @param {string[]} [options.disabledTestIds=[]]
   */
  constructor(mcClient, options = {}) {
    this._mc = mcClient;
    this._config = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));
    this._subTestsEnabled = options.subTestsEnabled ?? true;
    this._dryRun = options.dryRun ?? false;
    this._disabledIds = new Set(options.disabledTestIds ?? []);
  }

  /**
   * Select relevant clash test templates based on detected disciplines,
   * create them in ACC, and return the results.
   *
   * @param {string}   modelSetId
   * @param {number}   versionIndex
   * @param {string[]} detectedDisciplines
   * @param {Map<string,string>} searchSetNameToRemoteId  - 'ARCH_Floors' → 'abc123'
   * @returns {Promise<ClashTestResult[]>}
   */
  async configureForDisciplines(modelSetId, versionIndex, detectedDisciplines, searchSetNameToRemoteId) {
    const selectedTemplates = this._selectTemplates(detectedDisciplines);
    logger.info(
      'Selected %d clash test template(s) for disciplines: %s',
      selectedTemplates.length,
      detectedDisciplines.join(', ')
    );

    const results = [];
    for (const template of selectedTemplates) {
      const tests = this._subTestsEnabled && template.subTests?.length
        ? template.subTests.map(sub => this._buildSubTestPayload(sub, template, searchSetNameToRemoteId))
        : [this._buildTestPayload(template, searchSetNameToRemoteId)];

      for (const payload of tests) {
        if (!payload) continue;
        const result = await this._createOne(modelSetId, versionIndex, payload, template.id);
        results.push(result);
      }
    }

    const created = results.filter(r => r.created).length;
    logger.info('Clash tests: %d created', created);
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  _selectTemplates(disciplines) {
    const matrix = this._config.autoPairingMatrix.pairs;
    const selectedIds = new Set();

    for (const [pairKey, testIds] of Object.entries(matrix)) {
      const [a, b] = pairKey.split('+');
      if (disciplines.includes(a) && disciplines.includes(b)) {
        testIds.forEach(id => selectedIds.add(id));
      }
    }

    return this._config.clashTests.filter(t =>
      t.enabled &&
      !this._disabledIds.has(t.id) &&
      selectedIds.has(t.id)
    );
  }

  _buildTestPayload(template, ssMap) {
    const sideAIds = this._resolveSearchSetIds(template.sideA.searchSetIds, template.sideA.fallbackSearchSetIds, ssMap);
    const sideBIds = this._resolveSearchSetIds(template.sideB.searchSetIds, template.sideB.fallbackSearchSetIds, ssMap);

    if (!sideAIds.length || !sideBIds.length) {
      logger.warn('Skipping test %s — could not resolve all Search Set IDs', template.name);
      return null;
    }

    return {
      name: template.name,
      type: template.clashType,
      tolerance: template.tolerance,
      selectionA: sideAIds,
      selectionB: sideBIds
    };
  }

  _buildSubTestPayload(subTest, parentTemplate, ssMap) {
    const sideAIds = this._resolveSearchSetIds(subTest.sideASearchSetIds, [], ssMap);
    const sideBIds = this._resolveSearchSetIds(subTest.sideBSearchSetIds, [], ssMap);

    if (!sideAIds.length || !sideBIds.length) {
      logger.warn('Skipping sub-test %s — could not resolve Search Set IDs', subTest.name);
      return null;
    }

    return {
      name: subTest.name,
      type: parentTemplate.clashType,
      tolerance: parentTemplate.tolerance,
      selectionA: sideAIds,
      selectionB: sideBIds
    };
  }

  /**
   * Resolve Search Set names to remote IDs from the name→id map.
   * Falls back to fallbackIds if primary names are not found.
   */
  _resolveSearchSetIds(primaryNames, fallbackNames, ssMap) {
    // ssMap might be keyed by search-set-library ID or by name
    const resolved = primaryNames
      .map(name => ssMap.get(name))
      .filter(Boolean);

    if (resolved.length > 0) return resolved;

    // Try fallbacks
    return fallbackNames
      .map(name => ssMap.get(name))
      .filter(Boolean);
  }

  async _createOne(modelSetId, versionIndex, payload, templateId) {
    if (this._dryRun) {
      logger.info('[DRY RUN] Would create clash test: %s', payload.name);
      return { templateId, name: payload.name, created: false, dryRun: true };
    }

    try {
      const response = await this._mc.createClashTest(modelSetId, versionIndex, payload);
      const remoteId = response?.id ?? response?.data?.id;
      logger.info('Created clash test: %s (id: %s)', payload.name, remoteId);
      return { templateId, name: payload.name, created: true, remoteId };
    } catch (err) {
      logger.error('Failed to create clash test %s: %s', payload.name, err.message);
      return { templateId, name: payload.name, created: false, error: err.message };
    }
  }
}
