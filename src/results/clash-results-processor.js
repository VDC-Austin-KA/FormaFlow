/**
 * ClashResultsProcessor
 *
 * Fetches raw clash results from the Model Coordination API, groups them
 * by Level + System Classification + Category (multi-property grouping),
 * and assigns unique, descriptive names following the convention defined
 * in config/naming-conventions.json.
 *
 * Naming format:
 *   [Level]_[TestName]_[SearchSetA]_vs_[SearchSetB]_[Sequence]
 *   e.g.  L03_ARCH_vs_STRUCT_ARCH_Floors_vs_STRUCT_Framing_001
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAMING_PATH = resolve(__dirname, '../../config/naming-conventions.json');

const logger = createLogger('ClashResultsProcessor');

export class ClashResultsProcessor {
  /**
   * @param {import('../api/model-coordination.js').ModelCoordinationClient} mcClient
   * @param {object} [options]
   * @param {boolean} [options.groupByLevel=true]
   * @param {boolean} [options.groupBySystem=true]
   * @param {string}  [options.outputPath='./output/clash-results']
   * @param {boolean} [options.dryRun=false]
   */
  constructor(mcClient, options = {}) {
    this._mc = mcClient;
    this._naming = JSON.parse(readFileSync(NAMING_PATH, 'utf8'));
    this._groupByLevel = options.groupByLevel ?? true;
    this._groupBySystem = options.groupBySystem ?? true;
    this._outputPath = options.outputPath ?? './output/clash-results';
    this._dryRun = options.dryRun ?? false;
  }

  /**
   * Process results for a list of completed clash tests.
   *
   * @param {string}            modelSetId
   * @param {number}            versionIndex
   * @param {ClashTestResult[]} clashTests   - results from ClashTestConfigurator
   * @returns {Promise<ProcessedClashReport>}
   */
  async processAll(modelSetId, versionIndex, clashTests) {
    // Include any test with a remote ID — covers both newly-created tests and
    // existing ACC tests used as fallback (where created is false).
    const completedTests = clashTests.filter(t => t.remoteId);
    logger.info('Processing results for %d clash test(s)', completedTests.length);

    const allGroups = [];
    for (const test of completedTests) {
      const groups = await this._processOne(modelSetId, versionIndex, test);
      allGroups.push(...groups);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      totalGroups: allGroups.length,
      totalClashes: allGroups.reduce((sum, g) => sum + g.clashCount, 0),
      groups: allGroups
    };

    if (!this._dryRun) {
      this._exportReport(report, modelSetId);
    }

    logger.info(
      'Processing complete: %d groups, %d total clashes',
      report.totalGroups,
      report.totalClashes
    );
    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _processOne(modelSetId, versionIndex, test) {
    let raw;
    try {
      raw = await this._mc.getGroupedClashes(modelSetId, versionIndex, test.remoteId);
    } catch (err) {
      logger.warn('Could not fetch grouped clashes for test %s: %s', test.name, err.message);
      raw = null;
    }

    // Fall back to resource-based fetching if grouped endpoint returns nothing
    if (!raw || (Array.isArray(raw) && raw.length === 0)) {
      logger.debug('Falling back to resource-based clash fetch for test %s', test.name);
      raw = await this._fetchFromResources(modelSetId, versionIndex, test.remoteId);
    }

    const clashes = this._normaliseClashes(raw);
    const groups = this._groupClashes(clashes, test);
    return this._nameGroups(groups, test);
  }

  _normaliseClashes(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    if (raw.clashes && Array.isArray(raw.clashes)) return raw.clashes;
    return [];
  }

  _groupClashes(clashes, test) {
    const buckets = new Map();
    for (const clash of clashes) {
      const level = this._groupByLevel ? this._extractLevel(clash) : 'ALL';
      const system = this._groupBySystem ? this._extractSystem(clash) : null;
      const key = system ? `${level}__${system}` : level;

      if (!buckets.has(key)) {
        buckets.set(key, {
          levelKey: level,
          systemKey: system,
          clashes: []
        });
      }
      buckets.get(key).clashes.push(clash);
    }
    return [...buckets.values()];
  }

  _nameGroups(rawGroups, test) {
    // Sort groups: by level then system for deterministic sequence numbers
    const sorted = rawGroups.sort((a, b) => {
      const lc = (a.levelKey ?? '').localeCompare(b.levelKey ?? '');
      if (lc !== 0) return lc;
      return (a.systemKey ?? '').localeCompare(b.systemKey ?? '');
    });

    return sorted.map((group, index) => {
      const seq = String(index + 1).padStart(3, '0');
      const level = this._normaliseLevel(group.levelKey);
      const name = this._buildGroupName(level, test.name, seq);

      return {
        name,
        level,
        system: group.systemKey,
        clashCount: group.clashes.length,
        clashes: group.clashes,
        testId: test.remoteId,
        testName: test.name,
        sequence: seq
      };
    });
  }

  _buildGroupName(level, testName, seq) {
    const parts = [level, testName, seq].filter(Boolean);
    return parts.join('_');
  }

  _extractLevel(clash) {
    // Level may be on either element of the clash pair
    const levelA = clash?.levelA ?? clash?.elementA?.level ?? clash?.level;
    const levelB = clash?.levelB ?? clash?.elementB?.level;
    return levelA ?? levelB ?? 'ZUNK';
  }

  _extractSystem(clash) {
    const sys = clash?.systemClassificationA ?? clash?.systemClassification ?? null;
    return sys || null;
  }

  _normaliseLevel(raw) {
    if (!raw || raw === 'ZUNK') return 'ZUNK';
    const patterns = this._naming.levelNormalisation.patterns;
    for (const rule of patterns) {
      const m = new RegExp(rule.match, 'i').exec(raw);
      if (m) {
        // Replace {n:02} placeholder with zero-padded capture group
        const num = m[1] ? parseInt(m[1], 10) : null;
        return rule.normalised
          .replace('{n:02}', num !== null ? String(num).padStart(2, '0') : '')
          .replace('{n}', String(num ?? ''));
      }
    }
    // Fallback: uppercase, trim, max 8 chars
    return raw.toUpperCase().replace(/\s+/g, '').slice(0, 8);
  }

  async _fetchFromResources(modelSetId, versionIndex, testId) {
    try {
      const resources = await this._mc.getClashTestResources(modelSetId, versionIndex, testId);
      const docs = resources?.data ?? resources ?? [];
      const allClashes = [];
      for (const doc of docs.slice(0, 10)) {  // cap at 10 resource docs
        const docData = await this._mc.getClashDocument(modelSetId, versionIndex, testId, doc.key ?? doc.id);
        const clashes = docData?.clashes ?? docData ?? [];
        allClashes.push(...(Array.isArray(clashes) ? clashes : []));
      }
      return allClashes;
    } catch (err) {
      logger.warn('Resource-based fetch failed: %s', err.message);
      return [];
    }
  }

  _exportReport(report, modelSetId) {
    try {
      const dir = resolve(this._outputPath);
      mkdirSync(dir, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      const path = resolve(dir, `clash-report_${modelSetId}_${dateStr}.json`);
      writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
      logger.info('Report exported to: %s', path);
    } catch (err) {
      logger.error('Failed to export report: %s', err.message);
    }
  }
}

/**
 * @typedef {Object} ClashGroup
 * @property {string}   name       - Unique group name per naming convention
 * @property {string}   level
 * @property {string}   system
 * @property {number}   clashCount
 * @property {any[]}    clashes
 * @property {string}   testId
 * @property {string}   testName
 * @property {string}   sequence
 */

/**
 * @typedef {Object} ProcessedClashReport
 * @property {string}       generatedAt
 * @property {number}       totalGroups
 * @property {number}       totalClashes
 * @property {ClashGroup[]} groups
 */
