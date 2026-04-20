/**
 * Navisworks Search Set XML Importer
 *
 * Parses a Navisworks-exported `.xml` file (Search Sets / Selection Sets)
 * and converts it into FormaFlow's internal search-set schema.
 *
 * Navisworks export root is usually `<exchange>` with a `<selectionsets>`
 * child that contains `<selectionset>` or `<selectionfolder>` nodes.
 *
 * Each <selectionset> has a <findspec> (for "Search" sets) with a
 * <conditions> tree; plain <selectionset> nodes without a findspec are
 * static item selections and are skipped (no equivalent in property-based
 * search-sets).
 *
 * We map Navisworks `test` attribute values to FormaFlow operators:
 *   equals / contains / startsWith / endsWith / notEquals / notContains
 *   / in / exists / greaterThan / lessThan
 *
 * Returns an array of partial FormaFlow search-set objects the caller
 * (UI / server) can merge into the library.
 */

import { XMLParser } from 'fast-xml-parser';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('NavisworksImporter');

/** Navisworks test attribute → FormaFlow operator */
const TEST_MAP = {
  equals: 'equals',
  '=': 'equals',
  not_equals: 'notEquals',
  '!=': 'notEquals',
  contains: 'contains',
  wildcard: 'contains',
  wildcard_contains: 'contains',
  wildcard_nocase: 'contains',
  does_not_contain: 'notContains',
  not_contains: 'notContains',
  starts_with: 'startsWith',
  wildcard_match_begin: 'startsWith',
  ends_with: 'endsWith',
  wildcard_match_end: 'endsWith',
  defined: 'exists',
  has_value: 'exists',
  is_defined: 'exists',
  greater_than: 'greaterThan',
  '>': 'greaterThan',
  less_than: 'lessThan',
  '<': 'lessThan'
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Coerce single elements into arrays where they can legitimately repeat
  isArray: (name) =>
    ['selectionset', 'selectionfolder', 'condition', 'value', 'data'].includes(name)
});

/**
 * Parse a Navisworks XML export string and return FormaFlow-compatible
 * search-set objects.
 *
 * @param {string} xmlText     - Raw XML contents.
 * @param {object} [opts]
 * @param {string} [opts.defaultDiscipline='UNKNOWN'] - Discipline assigned to every imported set.
 * @param {string} [opts.idPrefix='ss-nw-']           - Prefix used for generated ids.
 * @returns {{ sets: object[], warnings: string[] }}
 */
export function parseNavisworksXml(xmlText, opts = {}) {
  const defaultDiscipline = opts.defaultDiscipline ?? 'UNKNOWN';
  const idPrefix = opts.idPrefix ?? 'ss-nw-';
  const warnings = [];

  let doc;
  try {
    doc = parser.parse(xmlText);
  } catch (err) {
    throw new Error(`Malformed XML: ${err.message}`);
  }

  const root = doc?.exchange ?? doc;
  const sss = root?.selectionsets;
  if (!sss) {
    throw new Error('No <selectionsets> element found — is this a Navisworks Search Sets export?');
  }

  const flatSets = [];
  collectSets(sss, [], flatSets);

  const seenIds = new Set();
  const out = [];

  for (const { path, node } of flatSets) {
    const name = (node?.['@_name'] ?? 'Unnamed').trim();
    const findspec = node?.findspec;

    // Selection sets without a findspec are static item lists — no
    // property-based equivalent, skip but record a warning.
    if (!findspec) {
      warnings.push(`Skipped "${name}" — static selection set (no property filter).`);
      continue;
    }

    const disabled = String(findspec['@_disabled'] ?? '0') === '1';
    const mode = findspec['@_mode'] ?? 'all'; // "all" = AND, "any" = OR
    const conditionOperator = mode === 'any' ? 'or' : 'and';

    const conditionsNode = findspec.conditions;
    const rawConditions = conditionsNode?.condition ?? [];
    const conditions = [];

    for (const c of rawConditions) {
      const parsed = parseCondition(c, warnings, name);
      if (parsed) conditions.push(parsed);
    }

    if (!conditions.length) {
      warnings.push(`Skipped "${name}" — no parseable conditions.`);
      continue;
    }

    const safeName = [...path, name].join('_').replace(/\s+/g, '_');
    const id = uniqueId(`${idPrefix}${slug(safeName)}`, seenIds);

    out.push({
      id,
      name: safeName,
      discipline: defaultDiscipline,
      category: path[0] ?? 'Imported',
      transferable: true,
      systemBased: false,
      description: `Imported from Navisworks: ${[...path, name].join(' / ')}`,
      _disabled: disabled,
      filter: { conditionOperator, conditions }
    });
  }

  logger.info('Navisworks import: %d sets parsed, %d warning(s)', out.length, warnings.length);
  return { sets: out, warnings };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function collectSets(container, path, acc) {
  // selectionfolder nodes group further selectionsets (one level of
  // nesting is common; recurse to be safe).
  const folders = container.selectionfolder ?? [];
  for (const f of folders) {
    const fname = (f['@_name'] ?? 'Folder').trim();
    collectSets(f, [...path, fname], acc);
  }
  const sets = container.selectionset ?? [];
  for (const s of sets) acc.push({ path, node: s });
}

function parseCondition(cond, warnings, setName) {
  // Navisworks uses either the `test` attribute or a flags integer;
  // we rely on the `test` attribute — present in all modern exports.
  const rawTest = String(cond?.['@_test'] ?? 'equals').toLowerCase();
  const operator = TEST_MAP[rawTest];

  if (!operator) {
    warnings.push(`"${setName}": unrecognised test "${rawTest}" — defaulting to "contains".`);
  }

  const propertyName =
    cond?.property?.name?.['#text'] ??
    cond?.property?.name ??
    null;
  const categoryName =
    cond?.category?.name?.['#text'] ??
    cond?.category?.name ??
    null;

  if (!propertyName) {
    warnings.push(`"${setName}": condition missing property name — skipped.`);
    return null;
  }

  // Navisworks may nest multiple <value>/<data> for "in"-style conditions
  const values = [];
  const valueNodes = Array.isArray(cond?.value) ? cond.value : (cond?.value ? [cond.value] : []);
  for (const v of valueNodes) {
    const dataArr = Array.isArray(v?.data) ? v.data : (v?.data ? [v.data] : []);
    for (const d of dataArr) {
      values.push(typeof d === 'object' ? (d['#text'] ?? '') : d);
    }
  }

  // Include the category as a hint in the property label, matching
  // FormaFlow's "Category.Property" convention where the category isn't
  // the default "Element".
  const prop =
    categoryName && categoryName !== 'Element' && categoryName !== 'Item'
      ? `${categoryName}.${propertyName}`
      : propertyName;

  // Collapse list values into a single `in` if we got multiple
  let op = operator ?? 'contains';
  let value = values.length === 1 ? values[0] : values.length > 1 ? values : '';
  if (Array.isArray(value) && op === 'equals') op = 'in';

  return { property: prop, operator: op, value };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function uniqueId(base, seen) {
  let id = base || 'ss-nw-set';
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}
