#!/usr/bin/env node
/**
 * FormaFlow Automated Workflow
 *
 * Orchestrates the full end-to-end clash detection process:
 *
 *   1. Scan target folder — list all uploaded models
 *   2. Extract properties via Model Derivative API
 *   3. Classify each model to a BIM discipline (auto-identify)
 *   4. Create discipline-specific Search Sets in the model set
 *   5. Auto-select clash tests from the pairing matrix
 *   6. Create clash tests, wait for completion
 *   7. Fetch, group, and name clash results
 *   8. Export standardised JSON report
 *
 * Usage:
 *   node src/workflow/automated-workflow.js [--dry-run] [--config path/to/overrides.json]
 *
 * References:
 *   APS SDK:        https://github.com/autodesk-platform-services/aps-sdk-node
 *   Clash sample:   https://github.com/autodesk-platform-services/aps-clash-data-view
 *   MC API docs:    https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

import { APSClient }                from '../api/aps-client.js';
import { ModelCoordinationClient }  from '../api/model-coordination.js';
import { ModelDerivativeClient }    from '../api/model-derivative.js';
import { DisciplineClassifier }     from '../model-identification/discipline-classifier.js';
import { SearchSetGenerator }       from '../search-sets/search-set-generator.js';
import { ClashTestConfigurator }    from '../clash-tests/clash-test-configurator.js';
import { ClashResultsProcessor }    from '../results/clash-results-processor.js';
import { createLogger }             from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, '../../config/workflow-config.json');

const logger = createLogger('Workflow');

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'config':  { type: 'string',  default: DEFAULT_CONFIG_PATH }
    }
  });

  const config = loadConfig(args.config);
  const dryRun = args['dry-run'] || config.workflow.dryRun;

  if (dryRun) logger.warn('DRY RUN mode — no write API calls will be made');

  logger.info('=== FormaFlow Automated Workflow ===');
  logger.info('Project: %s (%s)', config.project.name, config.project.code);

  // ── 1. Initialise API clients ──────────────────────────────────────────
  const apsClient = new APSClient();
  const mcClient  = new ModelCoordinationClient(apsClient);
  const mdClient  = new ModelDerivativeClient(apsClient);

  // ── 2. Resolve model set ───────────────────────────────────────────────
  logger.info('Fetching model sets from container...');
  const modelSetsResponse = await mcClient.listModelSets();
  const modelSets = modelSetsResponse?.data ?? modelSetsResponse ?? [];

  if (!modelSets.length) {
    logger.error('No model sets found in container %s', process.env.MC_CONTAINER_ID);
    process.exit(1);
  }

  // Use the first model set (or filter by name if needed)
  const modelSet = modelSets[0];
  const modelSetId = modelSet.id ?? modelSet.modelSetId;
  logger.info('Using model set: %s (%s)', modelSet.name ?? modelSetId, modelSetId);

  // ── 3. Get latest version ─────────────────────────────────────────────
  const versionsResponse = await mcClient.getModelSetVersions(modelSetId);
  const versions = versionsResponse?.data ?? versionsResponse ?? [];
  const latestVersion = versions[versions.length - 1];
  const versionIndex = latestVersion?.versionIndex ?? latestVersion?.index ?? 1;
  logger.info('Latest model set version: %d', versionIndex);

  // ── 4. Extract model descriptors via Model Derivative ─────────────────
  logger.info('Extracting model properties for discipline identification...');
  const documents = latestVersion?.documents ?? [];

  if (!documents.length) {
    logger.warn('No documents found in version %d — using filename-only classification', versionIndex);
  }

  const descriptors = await Promise.all(
    documents.map(doc =>
      mdClient.extractModelDescriptor(doc.urn ?? doc.derivativeUrn, doc.name ?? doc.fileName ?? doc.urn)
    )
  );

  // ── 5. Classify disciplines ────────────────────────────────────────────
  const classifier = new DisciplineClassifier();
  logger.info('Classifying %d model(s)...', descriptors.length);
  const classificationResults = classifier.classifyAll(descriptors);

  const disciplineSet = new Set();
  const unknownModels = [];
  for (const [id, result] of classificationResults) {
    if (result.discipline === 'UNKNOWN') {
      unknownModels.push(id);
      if (config.workflow.stopOnUnknownDiscipline) {
        logger.error('Unclassified model: %s — stopping (stopOnUnknownDiscipline=true)', id);
        process.exit(1);
      }
    } else {
      disciplineSet.add(result.discipline);
    }
  }

  const detectedDisciplines = [...disciplineSet];
  logger.info('Detected disciplines: %s', detectedDisciplines.join(', '));
  if (unknownModels.length) {
    logger.warn('%d model(s) could not be classified: %s', unknownModels.length, unknownModels.join(', '));
  }

  // ── 6. Create Search Sets ──────────────────────────────────────────────
  const ssGenerator = new SearchSetGenerator(mcClient, {
    overwriteExisting: config.searchSets.overwriteExisting,
    createSystemBased: config.searchSets.createSystemBasedSets,
    createFallback:    config.searchSets.createFallbackCategorySets,
    dryRun
  });

  const ssResults = await ssGenerator.generateForDisciplines(modelSetId, detectedDisciplines);

  // Build a name→remoteId map for the clash configurator
  const searchSetNameToId = new Map();
  for (const res of ssResults) {
    if (res.remoteId) searchSetNameToId.set(res.name, res.remoteId);
  }

  // ── 7. Create Clash Tests ──────────────────────────────────────────────
  const testConfigurator = new ClashTestConfigurator(mcClient, {
    subTestsEnabled: config.clashTests.subTestsEnabled,
    dryRun,
    disabledTestIds: config.clashTests.disabledTestIds
  });

  const clashTestResults = await testConfigurator.configureForDisciplines(
    modelSetId,
    versionIndex,
    detectedDisciplines,
    searchSetNameToId
  );

  // ── 8. Wait for clash tests to complete ───────────────────────────────
  if (!dryRun) {
    logger.info('Waiting for %d clash test(s) to complete...', clashTestResults.filter(r => r.created).length);
    for (const test of clashTestResults.filter(r => r.created && r.remoteId)) {
      try {
        await mcClient.waitForClashTest(
          modelSetId,
          versionIndex,
          test.remoteId,
          config.workflow.pollIntervalMs,
          config.workflow.clashTestTimeoutMs
        );
        logger.info('Clash test completed: %s', test.name);
      } catch (err) {
        logger.error('Clash test did not complete: %s — %s', test.name, err.message);
      }
    }
  }

  // ── 9. Process and name results ───────────────────────────────────────
  const processor = new ClashResultsProcessor(mcClient, {
    groupByLevel:  config.results.groupByLevel,
    groupBySystem: config.results.groupBySystemClassification,
    outputPath:    config.results.exportPath,
    dryRun
  });

  const report = await processor.processAll(modelSetId, versionIndex, clashTestResults);

  // ── 10. Summary ───────────────────────────────────────────────────────
  logger.info('');
  logger.info('=== Workflow Complete ===');
  logger.info('  Disciplines identified : %s', detectedDisciplines.join(', '));
  logger.info('  Search Sets created    : %d', ssResults.filter(r => r.created).length);
  logger.info('  Clash tests created    : %d', clashTestResults.filter(r => r.created).length);
  logger.info('  Clash groups generated : %d', report.totalGroups);
  logger.info('  Total clashes found    : %d', report.totalClashes);
  if (!dryRun) {
    logger.info('  Report saved to        : %s', resolve(config.results.exportPath));
  }
  logger.info('');

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  const defaults = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  if (!configPath || configPath === DEFAULT_CONFIG_PATH || !existsSync(configPath)) {
    return defaults;
  }
  try {
    const overrides = JSON.parse(readFileSync(configPath, 'utf8'));
    return deepMerge(defaults, overrides);
  } catch {
    logger.warn('Could not load config overrides from %s — using defaults', configPath);
    return defaults;
  }
}

function deepMerge(base, overrides) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

main().catch(err => {
  logger.error('Workflow failed: %s', err.stack ?? err.message);
  process.exit(1);
});
