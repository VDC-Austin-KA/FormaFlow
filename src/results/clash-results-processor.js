/**
 * ClashResultsProcessor
 *
 * Fetches grouped clash results from `GET /modelsets/{m}/clashes/grouped`,
 * preserves the API/UI auto-generated names verbatim, and enriches each
 * group with FormaFlow-inferred metadata (discipline pair, normalised level,
 * collapsed-by-FamilyType signal).
 *
 * Naming policy:
 *   - When the API returns `group.name`, pass it through unchanged so the
 *     FormaFlow report decodes 1:1 with what the ACC Coordination UI shows.
 *   - When the API does not return a name (Stage 1 fallback: discipline-pair
 *     synthetic groups, or older container shapes), build a fallback name
 *     using the legacy convention in config/naming-conventions.json.
 *
 * Stages:
 *   3 — Multi-property hierarchy: walk `groupingValues[]` to infer disciplines.
 *   4 — High-cardinality collapse: when a discipline pair yields > N leaf
 *       groups, collapse them by `Family:Type` to keep reports readable.
 *   5 — Auto-assign to issues (orchestrated by the workflow, not here): this
 *       processor only flags `autoAssignCandidate=true` on groups whose
 *       priority exceeds the configured threshold.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { DisciplineClassifier } from '../model-identification/discipline-classifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAMING_PATH = resolve(__dirname, '../../config/naming-conventions.json');

const logger = createLogger('ClashResultsProcessor');

const DEFAULT_COLLAPSE_THRESHOLD = Number(process.env.PRIORITY_COLLAPSE_THRESHOLD ?? 500);

export class ClashResultsProcessor {
  /**
   * @param {import('../api/model-coordination.js').ModelCoordinationClient} mcClient
   * @param {object} [options]
   * @param {boolean} [options.groupByLevel=true]            - legacy fallback grouping
   * @param {boolean} [options.groupBySystem=true]           - legacy fallback grouping
   * @param {string}  [options.outputPath='./output/clash-results']
   * @param {boolean} [options.dryRun=false]
   * @param {number}  [options.collapseThreshold]            - Stage 4 threshold (default 500)
   * @param {number}  [options.priorityThreshold]            - Stage 5 auto-assign threshold (1..10)
   */
  constructor(mcClient, options = {}) {
    this._mc = mcClient;
    this._naming = JSON.parse(readFileSync(NAMING_PATH, 'utf8'));
    this._groupByLevel = options.groupByLevel ?? true;
    this._groupBySystem = options.groupBySystem ?? true;
    this._outputPath = options.outputPath ?? './output/clash-results';
    this._dryRun = options.dryRun ?? false;
    this._collapseThreshold = options.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
    this._priorityThreshold = options.priorityThreshold ?? null;
    this._classifier = new DisciplineClassifier();
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
    const completedTests = clashTests.filter(t => t.remoteId);
    logger.info('Processing results for %d clash test(s)', completedTests.length);

    const allGroups = [];
    for (const test of completedTests) {
      const groups = await this._processOne(modelSetId, versionIndex, test);
      allGroups.push(...groups);
    }

    // Stage 4: collapse high-cardinality discipline pairs
    const collapsed = this._maybeCollapseHighCardinality(allGroups);

    const report = {
      generatedAt: new Date().toISOString(),
      totalGroups: collapsed.length,
      totalClashes: collapsed.reduce((sum, g) => sum + g.clashCount, 0),
      collapseThreshold: this._collapseThreshold,
      priorityThreshold: this._priorityThreshold,
      groups: collapsed
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
    let raw = null;
    try {
      raw = await this._mc.getGroupedClashes(modelSetId, versionIndex, test.remoteId);
    } catch (err) {
      logger.warn('Could not fetch grouped clashes for test %s: %s', test.name, err.message);
    }

    let clashes = this._normaliseClashes(raw);

    if (!clashes.length) {
      if (raw !== null && raw !== undefined) {
        const shape = Array.isArray(raw)
          ? `Array(${raw.length})`
          : `Object{${Object.keys(raw ?? {}).join(',')}}`;
        logger.info('getGroupedClashes for %s returned %s — falling back to resources', test.name, shape);
      }
      const resourceRaw = await this._fetchFromResources(modelSetId, versionIndex, test.remoteId);
      clashes = this._normaliseClashes(resourceRaw);
      if (!clashes.length && resourceRaw !== null && resourceRaw !== undefined) {
        const shape = Array.isArray(resourceRaw)
          ? `Array(${resourceRaw.length})`
          : `Object{${Object.keys(resourceRaw ?? {}).join(',')}}`;
        logger.info('Resource-based fetch for %s returned %s — no clashes extracted', test.name, shape);
      }
    }

    // Pre-grouped path: API returned canonical clash groups.
    if (clashes.length && this._looksPreGrouped(clashes[0])) {
      logger.info('Test %s results appear pre-grouped (%d groups)', test.name, clashes.length);
      return this._processPreGrouped(clashes, test);
    }

    // Legacy fallback: API returned raw clash instances — apply our own grouping.
    const groups = this._groupClashes(clashes, test);
    return this._nameFallbackGroups(groups, test);
  }

  _normaliseClashes(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    for (const key of ['groups', 'clashGroups', 'clashes', 'data', 'items',
                        'clashInstances', 'results', 'clashResults', 'tests']) {
      if (Array.isArray(raw[key])) return raw[key];
    }
    if (raw.result && typeof raw.result === 'object') return this._normaliseClashes(raw.result);
    if (raw.pagination && Array.isArray(raw.data)) return raw.data;
    return [];
  }

  _looksPreGrouped(item) {
    return item && typeof item === 'object' &&
      ('count' in item || 'clashCount' in item || 'clashesCount' in item || 'groupingValues' in item) &&
      !('objectId' in item) && !('objectIdA' in item);
  }

  /**
   * Process pre-grouped clashes (the modern `/modelsets/{m}/clashes/grouped` path).
   *
   * Preserves the verbatim API name, walks `groupingValues` to infer
   * disciplines (Stage 3), and flags `autoAssignCandidate` per Stage 5 policy.
   */
  _processPreGrouped(preGrouped, test) {
    return preGrouped.map((g, index) => {
      const seq = String(index + 1).padStart(3, '0');
      const groupingValues = Array.isArray(g.groupingValues) ? g.groupingValues : [];

      // Stage 3: preserve API name verbatim; derive a fallback only if absent.
      const apiName = g.name ?? g.displayName ?? null;
      const name = apiName ?? this._buildFallbackName(g, test, seq);

      // Stage 3: infer discipline pair from groupingValues + test metadata.
      const disciplinePair = this._classifier.classifyFromGroupingValues(
        groupingValues,
        test.requiredDisciplines ?? null
      );

      // Stage 4 input: extract Family:Type signature for downstream collapse.
      const familyType = g.familyType ?? g.family ?? this._extractFamilyType(g);

      // Stage 5 candidate flag — workflow decides whether to actually assign.
      const priority = test.priority ?? null;
      const autoAssignCandidate = this._priorityThreshold !== null
        && priority !== null
        && priority <= this._priorityThreshold;

      logger.debug(
        'group naming: { apsName: %j, formaFlowName: %j, source: %s }',
        apiName, name, apiName ? 'api' : 'fallback'
      );

      return {
        // Identity
        groupId: g.id ?? g.groupId ?? null,
        name,
        nameSource: apiName ? 'api' : 'fallback',
        // Hierarchy
        groupingValues,
        familyType,
        // Metrics
        clashCount: g.count ?? g.clashCount ?? g.clashesCount ?? 0,
        // Test linkage
        testId: test.remoteId,
        testName: test.name,
        sequence: seq,
        // Stage 3 enrichment
        disciplineA: disciplinePair?.disciplineA ?? null,
        disciplineB: disciplinePair?.disciplineB ?? null,
        level: disciplinePair?.level ?? null,
        system: disciplinePair?.system ?? null,
        // Stage 5 input
        priority,
        autoAssignCandidate,
        // Provenance
        preGrouped: true,
        collapsedFrom: null,
      };
    });
  }

  _extractFamilyType(group) {
    // Look for Family:Type-like values inside groupingValues
    const gv = group.groupingValues ?? [];
    for (const v of gv) {
      if (typeof v === 'string' && v.includes(':')) return v;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 4: high-cardinality collapse
  // ─────────────────────────────────────────────────────────────────────────

  _maybeCollapseHighCardinality(groups) {
    // Bucket by (disciplineA, disciplineB)
    const byPair = new Map();
    for (const g of groups) {
      const key = `${g.disciplineA ?? '?'}__${g.disciplineB ?? '?'}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(g);
    }

    const out = [];
    for (const [pairKey, pairGroups] of byPair) {
      if (pairGroups.length <= this._collapseThreshold) {
        out.push(...pairGroups);
        continue;
      }

      logger.info(
        'Stage 4: collapsing %d groups for pair %s by Family:Type (threshold=%d)',
        pairGroups.length, pairKey, this._collapseThreshold
      );

      // Sub-bucket by familyType
      const byFamily = new Map();
      for (const g of pairGroups) {
        const ft = g.familyType ?? '_no_family_';
        if (!byFamily.has(ft)) byFamily.set(ft, []);
        byFamily.get(ft).push(g);
      }

      for (const [familyType, familyGroups] of byFamily) {
        // Preserve the first group's API name and append the Family:Type
        const first = familyGroups[0];
        const collapsedName = familyType === '_no_family_'
          ? first.name
          : `${first.name} — ${familyType}`;

        out.push({
          ...first,
          name: collapsedName,
          nameSource: 'collapsed',
          clashCount: familyGroups.reduce((s, g) => s + g.clashCount, 0),
          collapsedFrom: familyGroups.map(g => g.groupId).filter(Boolean),
          familyType: familyType === '_no_family_' ? null : familyType,
        });
      }
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Legacy fallback path (raw clash instances)
  // ─────────────────────────────────────────────────────────────────────────

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

  _nameFallbackGroups(rawGroups, test) {
    const sorted = rawGroups.sort((a, b) => {
      const lc = (a.levelKey ?? '').localeCompare(b.levelKey ?? '');
      if (lc !== 0) return lc;
      return (a.systemKey ?? '').localeCompare(b.systemKey ?? '');
    });

    return sorted.map((group, index) => {
      const seq = String(index + 1).padStart(3, '0');
      const level = this._normaliseLevel(group.levelKey);
      const name = this._buildFallbackNameFromParts(level, test.name, seq);
      logger.debug('group naming: { apsName: null, formaFlowName: %j, source: fallback }', name);

      return {
        groupId: null,
        name,
        nameSource: 'fallback',
        groupingValues: [level, group.systemKey].filter(Boolean),
        familyType: null,
        clashCount: group.clashes.length,
        testId: test.remoteId,
        testName: test.name,
        sequence: seq,
        disciplineA: null,
        disciplineB: null,
        level,
        system: group.systemKey,
        priority: test.priority ?? null,
        autoAssignCandidate: false,
        preGrouped: false,
        collapsedFrom: null,
      };
    });
  }

  _buildFallbackName(group, test, seq) {
    const level = this._normaliseLevel(group.levelName ?? group.level ?? 'ZUNK');
    return this._buildFallbackNameFromParts(level, test.name, seq);
  }

  _buildFallbackNameFromParts(level, testName, seq) {
    return [level, testName, seq].filter(Boolean).join('_');
  }

  _extractLevel(clash) {
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
        const num = m[1] ? parseInt(m[1], 10) : null;
        return rule.normalised
          .replace('{n:02}', num !== null ? String(num).padStart(2, '0') : '')
          .replace('{n}', String(num ?? ''));
      }
    }
    return raw.toUpperCase().replace(/\s+/g, '').slice(0, 8);
  }

  async _fetchFromResources(modelSetId, versionIndex, testId) {
    try {
      const resources = await this._mc.getClashTestResources(modelSetId, versionIndex, testId);
      const docs = resources?.data ?? resources ?? [];
      const allClashes = [];
      for (const doc of docs.slice(0, 10)) {
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
 * @property {string|null}    groupId
 * @property {string}         name              - Verbatim from ACC UI when nameSource='api'
 * @property {'api'|'fallback'|'collapsed'} nameSource
 * @property {string[]}       groupingValues    - Hierarchy values from the active Saved Clash Check
 * @property {string|null}    familyType        - Stage 4 collapse signature
 * @property {number}         clashCount
 * @property {string}         testId
 * @property {string}         testName
 * @property {string}         sequence
 * @property {string|null}    disciplineA       - Stage 3 inference
 * @property {string|null}    disciplineB       - Stage 3 inference
 * @property {string|null}    level             - normalised
 * @property {string|null}    system            - normalised
 * @property {number|null}    priority
 * @property {boolean}        autoAssignCandidate
 * @property {boolean}        preGrouped
 * @property {string[]|null}  collapsedFrom     - source group IDs when nameSource='collapsed'
 */

/**
 * @typedef {Object} ProcessedClashReport
 * @property {string}       generatedAt
 * @property {number}       totalGroups
 * @property {number}       totalClashes
 * @property {number}       collapseThreshold
 * @property {number|null}  priorityThreshold
 * @property {ClashGroup[]} groups
 */
