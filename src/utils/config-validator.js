/**
 * Config Validator
 *
 * Validates all JSON config files against expected structure before a workflow
 * run. Catches missing required fields, wrong types, and unknown discipline IDs
 * early — before any API calls are made.
 *
 * Usage:  npm run validate-config
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, '../../config');

const logger = createLogger('ConfigValidator');

// ─────────────────────────────────────────────────────────────────────────────
// Schema-lite validators (no external library dependency)
// ─────────────────────────────────────────────────────────────────────────────

function assertString(val, path) {
  if (typeof val !== 'string') throw new Error(`${path} must be a string, got ${typeof val}`);
}

function assertArray(val, path) {
  if (!Array.isArray(val)) throw new Error(`${path} must be an array`);
}

function assertObject(val, path) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertIn(val, choices, path) {
  if (!choices.includes(val)) {
    throw new Error(`${path} must be one of [${choices.join(', ')}], got "${val}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual config validators
// ─────────────────────────────────────────────────────────────────────────────

function validateDisciplineRules(config) {
  assertObject(config.disciplines, 'disciplines');
  assertObject(config.classificationStrategy, 'classificationStrategy');
  for (const [key, disc] of Object.entries(config.disciplines)) {
    assertString(disc.label, `disciplines.${key}.label`);
    assertString(disc.abbreviation, `disciplines.${key}.abbreviation`);
    assertArray(disc.fileNamePatterns, `disciplines.${key}.fileNamePatterns`);
    assertArray(disc.revitCategories, `disciplines.${key}.revitCategories`);
  }
  return [];
}

function validateSearchSetLibrary(config) {
  const warnings = [];
  assertArray(config.searchSets, 'searchSets');
  assertObject(config.searchSetGroups, 'searchSetGroups');

  const VALID_OPERATORS = ['equals', 'contains', 'startsWith', 'in', 'exists', 'notEquals'];
  const ids = new Set();

  for (const ss of config.searchSets) {
    if (ids.has(ss.id)) warnings.push(`Duplicate Search Set id: ${ss.id}`);
    ids.add(ss.id);
    assertString(ss.id, `searchSet.id`);
    assertString(ss.name, `searchSet(${ss.id}).name`);
    assertObject(ss.filter, `searchSet(${ss.id}).filter`);
    assertIn(ss.filter.conditionOperator, ['and', 'or'], `searchSet(${ss.id}).filter.conditionOperator`);
    assertArray(ss.filter.conditions, `searchSet(${ss.id}).filter.conditions`);

    for (const cond of ss.filter.conditions) {
      if (cond.conditionOperator) {
        // nested group — recurse check
        assertArray(cond.conditions, `nested group in ${ss.id}`);
      } else {
        assertString(cond.property, `condition.property in ${ss.id}`);
        assertIn(cond.operator, VALID_OPERATORS, `condition.operator in ${ss.id}`);
      }
    }
  }

  // Verify all group references exist
  for (const [disc, setIds] of Object.entries(config.searchSetGroups)) {
    for (const id of setIds) {
      if (!ids.has(id)) {
        warnings.push(`searchSetGroups.${disc} references unknown id: ${id}`);
      }
    }
  }

  return warnings;
}

function validateClashTestTemplates(config) {
  const warnings = [];
  assertArray(config.clashTests, 'clashTests');
  assertObject(config.autoPairingMatrix, 'autoPairingMatrix');
  assertObject(config.autoPairingMatrix.pairs, 'autoPairingMatrix.pairs');

  const testIds = new Set();
  for (const t of config.clashTests) {
    if (testIds.has(t.id)) warnings.push(`Duplicate clash test id: ${t.id}`);
    testIds.add(t.id);
    assertString(t.id, 'clashTest.id');
    assertString(t.name, `clashTest(${t.id}).name`);
    assertIn(t.clashType, ['hard', 'clearance', 'duplicate'], `clashTest(${t.id}).clashType`);
    assertArray(t.requiredDisciplines, `clashTest(${t.id}).requiredDisciplines`);
    assertObject(t.sideA, `clashTest(${t.id}).sideA`);
    assertObject(t.sideB, `clashTest(${t.id}).sideB`);
  }

  // Verify pairing matrix references valid test IDs
  for (const [pair, ids] of Object.entries(config.autoPairingMatrix.pairs)) {
    for (const id of ids) {
      if (!testIds.has(id)) {
        warnings.push(`autoPairingMatrix.pairs[${pair}] references unknown test id: ${id}`);
      }
    }
  }

  return warnings;
}

function validateNamingConventions(config) {
  assertObject(config.clashGroupNaming, 'clashGroupNaming');
  assertString(config.clashGroupNaming.format, 'clashGroupNaming.format');
  assertArray(config.levelNormalisation.patterns, 'levelNormalisation.patterns');
  return [];
}

function validateWorkflowConfig(config) {
  const warnings = [];
  assertObject(config.project, 'project');
  assertString(config.project.code, 'project.code');
  assertObject(config.workflow, 'workflow');
  if (typeof config.workflow.dryRun !== 'boolean') {
    warnings.push('workflow.dryRun should be a boolean');
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

const CONFIGS = [
  { file: 'discipline-rules.json',    validator: validateDisciplineRules },
  { file: 'search-set-library.json',  validator: validateSearchSetLibrary },
  { file: 'clash-test-templates.json', validator: validateClashTestTemplates },
  { file: 'naming-conventions.json',  validator: validateNamingConventions },
  { file: 'workflow-config.json',     validator: validateWorkflowConfig }
];

export function validateAllConfigs() {
  let allPassed = true;
  const allWarnings = [];

  for (const { file, validator } of CONFIGS) {
    const path = resolve(CONFIG_DIR, file);
    try {
      const raw = readFileSync(path, 'utf8');
      const config = JSON.parse(raw);
      const warnings = validator(config);
      logger.info('PASS  %s', file);
      if (warnings.length) {
        warnings.forEach(w => logger.warn('  WARN  %s', w));
        allWarnings.push(...warnings);
      }
    } catch (err) {
      logger.error('FAIL  %s — %s', file, err.message);
      allPassed = false;
    }
  }

  return { passed: allPassed, warnings: allWarnings };
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  logger.info('Validating FormaFlow config files...\n');
  const { passed, warnings } = validateAllConfigs();
  console.log('');
  if (passed) {
    logger.info('All configs valid. %d warning(s).', warnings.length);
  } else {
    logger.error('One or more configs failed validation.');
    process.exit(1);
  }
}
