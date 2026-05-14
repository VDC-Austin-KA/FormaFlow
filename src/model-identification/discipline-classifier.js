/**
 * DisciplineClassifier
 * Automatically identifies the BIM discipline of each uploaded model
 * using a multi-stage evidence-weighting approach.
 *
 * Stage order (highest to lowest confidence):
 *  1. File-name pattern match
 *  2. Required-category presence check
 *  3. System-classification match
 *  4. Property-signature scan
 *  5. Dominant-category ratio
 *  6. Fallback → UNKNOWN
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '../../config/discipline-rules.json');

const logger = createLogger('DisciplineClassifier');

export class DisciplineClassifier {
  constructor(rulesPath = RULES_PATH) {
    this.rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    this.disciplines = this.rules.disciplines;
    this.strategy = this.rules.classificationStrategy;
  }

  /**
   * Classify a single model based on all available evidence.
   * @param {ModelDescriptor} model
   * @returns {ClassificationResult}
   */
  classify(model) {
    const evidence = this._gatherEvidence(model);
    const scores = this._scoreAllDisciplines(evidence);
    return this._selectDiscipline(model.fileName, scores);
  }

  /**
   * Classify an array of models and return a discipline map.
   * @param {ModelDescriptor[]} models
   * @returns {Map<string, ClassificationResult>}
   */
  classifyAll(models) {
    const results = new Map();
    for (const model of models) {
      const result = this.classify(model);
      results.set(model.id, result);
      logger.info(`[${model.fileName}] → ${result.discipline} (${(result.confidence * 100).toFixed(1)}%)`);
    }
    return results;
  }

  /**
   * Classify a clash group's discipline pair from its `groupingValues[]`.
   *
   * Used by ClashResultsProcessor (Stage 3) — given a multi-property
   * hierarchy like ["Level 3", "Supply Air", "PipeFitting:Elbow"], match each
   * value against `groupingValuePatterns` in config/discipline-rules.json to
   * find one or two implied disciplines. When `testHint` is provided (e.g.
   * `["MECH", "STRUCT"]` from the clash test template), that takes precedence.
   *
   * Returns `{ disciplineA, disciplineB, level, system }` — any field may be
   * null when no match is found.
   *
   * @param {string[]} groupingValues
   * @param {string[]|null} [testHint]
   * @returns {{disciplineA: string|null, disciplineB: string|null, level: string|null, system: string|null}}
   */
  classifyFromGroupingValues(groupingValues, testHint = null) {
    const out = { disciplineA: null, disciplineB: null, level: null, system: null };
    if (!Array.isArray(groupingValues) || !groupingValues.length) {
      if (Array.isArray(testHint) && testHint.length >= 2) {
        out.disciplineA = testHint[0];
        out.disciplineB = testHint[1];
      }
      return out;
    }

    const matchedDisciplines = new Set();
    for (const raw of groupingValues) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value) continue;

      // Level detection (e.g. "Level 3", "L03", "Roof", "Basement 1")
      if (!out.level && /(^|\s)(level\s*\d+|l\d+|roof|basement|ground)/i.test(value)) {
        out.level = value;
      }

      // System detection — any value that matches a known systemClassifications entry
      for (const [key, def] of Object.entries(this.disciplines)) {
        if (key === 'UNKNOWN') continue;
        if (def.systemClassifications?.some(sc => sc.toLowerCase() === value.toLowerCase())) {
          if (!out.system) out.system = value;
          matchedDisciplines.add(key);
        }
        // groupingValuePatterns is an optional discipline-rules.json extension
        // (regex list per discipline) for matching ad-hoc grouping property values.
        const patterns = def.groupingValuePatterns ?? [];
        if (patterns.some(p => new RegExp(p, 'i').test(value))) {
          matchedDisciplines.add(key);
        }
      }
    }

    // Test hint always wins when both are known
    if (Array.isArray(testHint) && testHint.length >= 2) {
      out.disciplineA = testHint[0];
      out.disciplineB = testHint[1];
      return out;
    }

    const ordered = [...matchedDisciplines].sort();
    out.disciplineA = ordered[0] ?? null;
    out.disciplineB = ordered[1] ?? null;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _gatherEvidence(model) {
    return {
      fileName: model.fileName ?? '',
      categories: model.categories ?? [],
      systemClassifications: model.systemClassifications ?? [],
      systemTypes: model.systemTypes ?? [],
      properties: model.properties ?? {}
    };
  }

  _scoreAllDisciplines(evidence) {
    const scores = {};
    for (const [key, def] of Object.entries(this.disciplines)) {
      if (key === 'UNKNOWN') continue;
      scores[key] = this._scoreOneDiscipline(def, evidence);
    }
    return scores;
  }

  _scoreOneDiscipline(def, evidence) {
    let score = 0;

    // 1. File-name pattern — strongest single signal (weight: 2.0)
    // NWC single-letter patterns (e.g. " M.nwc$") are treated as definitive:
    // they get a large bonus so content-based scoring from mixed-discipline
    // NWC files (e.g. a Mechanical model with hydronic pipes) can't override them.
    // The regular filename-pattern weight (2.0) is set high enough to beat the
    // maximum realistic content score (~1.5 for a strongly typed model) while
    // still losing to the NWC letter bonus (4.0).
    const nwcBonus = this._matchesNwcLetterPattern(def, evidence.fileName);
    if (nwcBonus) {
      score += 4.0; // overwhelms any content-based scoring; max possible was 3.4
    } else if (this._matchesFileNamePattern(def, evidence.fileName)) {
      score += 2.0;
    }

    // 2. Required categories present (weight: 0.8)
    if (def.requiredCategories?.length > 0) {
      const matchCount = def.requiredCategories.filter(c =>
        evidence.categories.includes(c)
      ).length;
      score += 0.8 * (matchCount / def.requiredCategories.length);
    }

    // 3. System-classification match (weight: 0.7)
    if (def.systemClassifications?.length > 0) {
      const matchCount = evidence.systemClassifications.filter(sc =>
        def.systemClassifications.includes(sc)
      ).length;
      if (matchCount > 0) {
        score += 0.7 * Math.min(matchCount / def.systemClassifications.length, 1);
      }
    }

    // 4. System-type pattern match (weight: 0.5)
    if (def.systemTypePatterns?.length > 0) {
      const patterns = def.systemTypePatterns.map(p => new RegExp(p, 'i'));
      const hitCount = evidence.systemTypes.filter(st =>
        patterns.some(rx => rx.test(st))
      ).length;
      if (hitCount > 0) {
        score += 0.5 * Math.min(hitCount / def.systemTypePatterns.length, 1);
      }
    }

    // 5. Property-signature match (weight: 0.6)
    if (def.propertySignatures?.length > 0) {
      const matchCount = def.propertySignatures.filter(sig =>
        this._testPropertySignature(sig, evidence)
      ).length;
      score += 0.6 * (matchCount / def.propertySignatures.length);
    }

    // 6. Dominant category ratio (weight: 0.4)
    if (def.revitCategories?.length > 0 && evidence.categories.length > 0) {
      const disciplineCategories = evidence.categories.filter(c =>
        def.revitCategories.includes(c)
      );
      const ratio = disciplineCategories.length / evidence.categories.length;
      if (ratio >= def.dominantCategoryThreshold) {
        score += 0.4 * ratio;
      }
    }

    // Penalty: excluded categories present
    if (def.excludeCategories?.length > 0) {
      const penaltyCount = def.excludeCategories.filter(c =>
        evidence.categories.includes(c)
      ).length;
      score -= 0.3 * penaltyCount;
    }

    return Math.max(0, score);
  }

  _matchesNwcLetterPattern(def, fileName) {
    if (!def.fileNamePatterns?.length) return false;
    const name = fileName.toUpperCase();
    // Only patterns that include nw[cd] (the NWC/NWD suffix check)
    const nwcPatterns = def.fileNamePatterns.filter(p => /nw\[cd\]/.test(p));
    return nwcPatterns.some(p => new RegExp(p, 'i').test(name));
  }

  _matchesFileNamePattern(def, fileName) {
    if (!def.fileNamePatterns?.length) return false;
    const name = fileName.toUpperCase();
    return def.fileNamePatterns.some(p => new RegExp(p, 'i').test(name));
  }

  _testPropertySignature(sig, evidence) {
    const value = evidence.properties[sig.property];
    if (value === undefined || value === null) {
      return sig.operator === 'not_exists';
    }
    switch (sig.operator) {
      case 'exists': return true;
      case 'not_exists': return false;
      case 'equals': return String(value).toLowerCase() === String(sig.value).toLowerCase();
      case 'contains': return String(value).toLowerCase().includes(String(sig.value).toLowerCase());
      case 'in': return Array.isArray(sig.values) && sig.values.includes(value);
      default: return false;
    }
  }

  _selectDiscipline(fileName, scores) {
    const sorted = Object.entries(scores)
      .sort(([, a], [, b]) => b - a);

    if (sorted.length === 0) {
      return this._unknownResult(fileName, 'No scores computed');
    }

    const [[topKey, topScore], second] = sorted;
    const maxPossible = 5.0;  // filename(2.0) + required-cat(0.8) + sys-class(0.7) + sys-type(0.5) + prop-sig(0.6) + dom-cat(0.4)
    const confidence = Math.min(topScore / maxPossible, 1);

    if (confidence < this.strategy.minimumConfidence) {
      return this._unknownResult(
        fileName,
        `Low confidence: ${(confidence * 100).toFixed(1)}% for ${topKey}`
      );
    }

    const gap = second ? topScore - second[1] : topScore;
    const isAmbiguous = gap < (topScore * this.strategy.ambiguityThreshold);

    return {
      discipline: topKey,
      label: this.disciplines[topKey].label,
      confidence,
      ambiguous: isAmbiguous,
      alternativeDiscipline: isAmbiguous && second ? second[0] : null,
      allScores: Object.fromEntries(sorted),
      requiresManualReview: isAmbiguous || confidence < this.strategy.minimumConfidence
    };
  }

  _unknownResult(fileName, reason) {
    return {
      discipline: 'UNKNOWN',
      label: this.disciplines.UNKNOWN.label,
      confidence: 0,
      ambiguous: false,
      alternativeDiscipline: null,
      allScores: {},
      requiresManualReview: true,
      reason
    };
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const classifier = new DisciplineClassifier();
  const sampleModels = [
    {
      id: 'mdl-001',
      fileName: 'ARCH_Building-A_L01.rvt',
      categories: ['Walls', 'Floors', 'Ceilings', 'Doors', 'Windows'],
      systemClassifications: [],
      systemTypes: [],
      properties: { Discipline: 'Architecture' }
    },
    {
      id: 'mdl-002',
      fileName: 'STRUCT_Core.rvt',
      categories: ['Structural Columns', 'Structural Framing', 'Structural Foundations'],
      systemClassifications: [],
      systemTypes: [],
      properties: { 'Structural Material': 'Concrete' }
    },
    {
      id: 'mdl-003',
      fileName: 'MEP_DUCT_L01.rvt',
      categories: ['Ducts', 'Duct Fittings', 'Air Terminals'],
      systemClassifications: ['Supply Air', 'Return Air', 'Exhaust Air'],
      systemTypes: ['SA-01', 'RA-01', 'EA-01'],
      properties: {}
    },
    {
      id: 'mdl-004',
      fileName: 'Unknown_Model.rvt',
      categories: ['Generic Models'],
      systemClassifications: [],
      systemTypes: [],
      properties: {}
    }
  ];

  console.log('\n=== FormaFlow Discipline Classifier ===\n');
  const results = classifier.classifyAll(sampleModels);
  for (const [id, result] of results) {
    const model = sampleModels.find(m => m.id === id);
    console.log(`${model.fileName}`);
    console.log(`  Discipline : ${result.discipline} — ${result.label}`);
    console.log(`  Confidence : ${(result.confidence * 100).toFixed(1)}%`);
    if (result.ambiguous) {
      console.log(`  ⚠ Ambiguous — also considered: ${result.alternativeDiscipline}`);
    }
    if (result.requiresManualReview) {
      console.log(`  ⚠ Requires manual review`);
    }
    console.log();
  }
}
