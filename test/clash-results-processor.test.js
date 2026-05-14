/**
 * Regression test for the Stage 3/4 naming contract.
 *
 *   1. When the `/clashes/grouped` response includes `name` and
 *      `groupingValues`, the processor must pass `name` through verbatim
 *      (`nameSource: 'api'`) so FormaFlow reports match what the ACC UI shows.
 *   2. When the response is missing `name`, the processor falls back to the
 *      legacy `{Level}_{TestName}_{Seq}` convention (`nameSource: 'fallback'`).
 *   3. When a discipline pair exceeds the collapse threshold, the processor
 *      collapses groups by `familyType` and appends ` — <Family:Type>` to the
 *      upstream API name (`nameSource: 'collapsed'`).
 */

import { jest } from '@jest/globals';
import { ClashResultsProcessor } from '../src/results/clash-results-processor.js';

function makeMockClient(groupedResponse) {
  return {
    getGroupedClashes: jest.fn().mockResolvedValue(groupedResponse),
    getClashTestResources: jest.fn().mockResolvedValue([]),
    getClashDocument: jest.fn().mockResolvedValue([]),
  };
}

const TEST = {
  remoteId: 'test-001',
  name: 'MECH_vs_STRUCT',
  priority: 2,
  requiredDisciplines: ['MECH', 'STRUCT'],
};

describe('ClashResultsProcessor — Stage 3 naming preservation', () => {
  it('preserves API-returned group name verbatim', async () => {
    const mc = makeMockClient({
      groups: [
        {
          id: 'g-1',
          name: 'Level 3 > Supply Air > Ducts',
          groupingValues: ['Level 3', 'Supply Air', 'Ducts'],
          count: 47,
        },
      ],
    });
    const processor = new ClashResultsProcessor(mc, { dryRun: true });
    const report = await processor.processAll('ms-1', 1, [TEST]);

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].name).toBe('Level 3 > Supply Air > Ducts');
    expect(report.groups[0].nameSource).toBe('api');
    expect(report.groups[0].groupingValues).toEqual(['Level 3', 'Supply Air', 'Ducts']);
  });

  it('infers discipline pair from test hint when groupingValues are ambiguous', async () => {
    const mc = makeMockClient({
      groups: [
        {
          id: 'g-2',
          name: 'Level 3 > Supply Air > Ducts',
          groupingValues: ['Level 3', 'Supply Air', 'Ducts'],
          count: 12,
        },
      ],
    });
    const processor = new ClashResultsProcessor(mc, { dryRun: true });
    const report = await processor.processAll('ms-1', 1, [TEST]);

    expect(report.groups[0].disciplineA).toBe('MECH');
    expect(report.groups[0].disciplineB).toBe('STRUCT');
  });

  it('falls back to legacy naming when API omits name', async () => {
    const mc = makeMockClient({
      groups: [
        {
          id: 'g-3',
          level: 'Level 3',
          count: 8,
        },
      ],
    });
    const processor = new ClashResultsProcessor(mc, { dryRun: true });
    const report = await processor.processAll('ms-1', 1, [TEST]);

    expect(report.groups[0].name).toBe('L03_MECH_vs_STRUCT_001');
    expect(report.groups[0].nameSource).toBe('fallback');
  });
});

describe('ClashResultsProcessor — Stage 4 collapse', () => {
  it('collapses by familyType when discipline pair exceeds threshold', async () => {
    const groups = Array.from({ length: 4 }, (_, i) => ({
      id: `g-${i}`,
      name: `Level ${i} > Supply Air > Ducts`,
      groupingValues: [`Level ${i}`, 'Supply Air', 'PipeFitting:Elbow'],
      count: 10,
    }));
    const mc = makeMockClient({ groups });
    const processor = new ClashResultsProcessor(mc, { dryRun: true, collapseThreshold: 3 });
    const report = await processor.processAll('ms-1', 1, [TEST]);

    // 4 groups → 1 pair → collapse triggers (threshold=3)
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].nameSource).toBe('collapsed');
    expect(report.groups[0].name).toMatch(/ — PipeFitting:Elbow$/);
    expect(report.groups[0].collapsedFrom).toEqual(['g-0', 'g-1', 'g-2', 'g-3']);
    expect(report.groups[0].clashCount).toBe(40);
  });

  it('does NOT collapse when below threshold', async () => {
    const groups = Array.from({ length: 2 }, (_, i) => ({
      id: `g-${i}`,
      name: `Level ${i} > Supply Air > Ducts`,
      groupingValues: [`Level ${i}`, 'Supply Air', 'PipeFitting:Elbow'],
      count: 10,
    }));
    const mc = makeMockClient({ groups });
    const processor = new ClashResultsProcessor(mc, { dryRun: true, collapseThreshold: 500 });
    const report = await processor.processAll('ms-1', 1, [TEST]);

    expect(report.groups).toHaveLength(2);
    expect(report.groups.every(g => g.nameSource === 'api')).toBe(true);
  });
});

describe('ClashResultsProcessor — Stage 5 candidate flagging', () => {
  it('flags groups with test.priority <= priorityThreshold as autoAssignCandidate', async () => {
    const mc = makeMockClient({
      groups: [{ id: 'g-1', name: 'A > B', groupingValues: ['A', 'B'], count: 5 }],
    });
    const processor = new ClashResultsProcessor(mc, { dryRun: true, priorityThreshold: 3 });
    const report = await processor.processAll('ms-1', 1, [TEST]); // TEST.priority = 2

    expect(report.groups[0].autoAssignCandidate).toBe(true);
    expect(report.priorityThreshold).toBe(3);
  });

  it('does NOT flag candidates when priorityThreshold is null', async () => {
    const mc = makeMockClient({
      groups: [{ id: 'g-1', name: 'A > B', groupingValues: ['A', 'B'], count: 5 }],
    });
    const processor = new ClashResultsProcessor(mc, { dryRun: true });
    const report = await processor.processAll('ms-1', 1, [TEST]);

    expect(report.groups[0].autoAssignCandidate).toBe(false);
  });
});
