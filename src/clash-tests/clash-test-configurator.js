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
    const sideA = this._resolveSearchSetIds(template.sideA.searchSetIds, template.sideA.fallbackSearchSetIds, ssMap);
    const sideB = this._resolveSearchSetIds(template.sideB.searchSetIds, template.sideB.fallbackSearchSetIds, ssMap);

    if (!sideA.ids.length || !sideB.ids.length) {
      const missing = [...sideA.missing, ...sideB.missing];
      const available = [...ssMap.keys()];
      logger.warn(
        'Skipping test %s — could not resolve Search Set ID(s): [%s]. Available: [%s]',
        template.name,
        missing.join(', '),
        available.join(', ')
      );
      return null;
    }

    return {
      name: template.name,
      type: template.clashType,
      tolerance: template.tolerance,
      selectionA: sideA.ids,
      selectionB: sideB.ids,
      _resolved: { sideA: sideA.ids, sideB: sideB.ids, sideAKeys: sideA.keys, sideBKeys: sideB.keys },
    };
  }

  _buildSubTestPayload(subTest, parentTemplate, ssMap) {
    const sideA = this._resolveSearchSetIds(subTest.sideASearchSetIds, [], ssMap);
    const sideB = this._resolveSearchSetIds(subTest.sideBSearchSetIds, [], ssMap);

    if (!sideA.ids.length || !sideB.ids.length) {
      const missing = [...sideA.missing, ...sideB.missing];
      const available = [...ssMap.keys()];
      logger.warn(
        'Skipping sub-test %s — could not resolve Search Set ID(s): [%s]. Available: [%s]',
        subTest.name,
        missing.join(', '),
        available.join(', ')
      );
      return null;
    }

    return {
      name: subTest.name,
      type: parentTemplate.clashType,
      tolerance: parentTemplate.tolerance,
      selectionA: sideA.ids,
      selectionB: sideB.ids,
      _resolved: { sideA: sideA.ids, sideB: sideB.ids, sideAKeys: sideA.keys, sideBKeys: sideB.keys },
    };
  }

  /**
   * Resolve Search Set names/IDs to remote IDs from the map.
   * Returns {ids, keys, missing} so the caller can report what wasn't found.
   * Falls back to fallback list if every primary key is missing.
   */
  _resolveSearchSetIds(primaryNames, fallbackNames, ssMap) {
    const primaryHits = primaryNames.filter(n => ssMap.has(n));
    if (primaryHits.length > 0) {
      return {
        ids: primaryHits.map(n => ssMap.get(n)),
        keys: primaryHits,
        missing: primaryNames.filter(n => !ssMap.has(n)),
      };
    }
    const fallbackHits = fallbackNames.filter(n => ssMap.has(n));
    return {
      ids: fallbackHits.map(n => ssMap.get(n)),
      keys: fallbackHits,
      missing: [...primaryNames, ...fallbackNames].filter(n => !ssMap.has(n)),
    };
  }

  async _createOne(modelSetId, versionIndex, payload, templateId) {
    // Strip diagnostic-only fields before sending to the API
    const { _resolved, ...apiPayload } = payload;

    if (this._dryRun) {
      logger.info('[DRY RUN] Would create clash test: %s', apiPayload.name);
      return { templateId, name: apiPayload.name, created: false, dryRun: true, resolved: _resolved };
    }

    try {
      const response = await this._mc.createClashTest(modelSetId, versionIndex, apiPayload);
      const remoteId = response?.id ?? response?.data?.id ?? response?.testId;
      if (!remoteId) {
        logger.warn(
          'Create clash test %s returned no id — response: %s',
          apiPayload.name,
          JSON.stringify(response)?.slice(0, 200)
        );
        return {
          templateId,
          name: apiPayload.name,
          created: false,
          error: 'API response did not include a remote id (clash test may not have been persisted)',
          resolved: _resolved,
        };
      }
      logger.info('Created clash test: %s (id: %s)', apiPayload.name, remoteId);
      return { templateId, name: apiPayload.name, created: true, remoteId, resolved: _resolved };
    } catch (err) {
      logger.error('Failed to create clash test %s: %s', apiPayload.name, err.message);
      return { templateId, name: apiPayload.name, created: false, error: err.message, resolved: _resolved };
    }
  }
}
