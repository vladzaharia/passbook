import { describe, expect, it } from 'vitest';
import { runOp } from '../run-spec.ts';
import type { RunIndex, RunIndexItem } from '../types.ts';
import { safeStart } from './run-app.tsx';

const item = (id: string, method: RunIndexItem['method']): RunIndexItem => ({
  id,
  slug: 'passes',
  anchor: id,
  method,
  path: `/api/v1/${id}`,
  title: id,
});

describe('the console start', () => {
  it('opens on the first read, never the write that comes first', () => {
    const index: RunIndex = {
      codes: [],
      groups: [
        {
          label: 'Passes',
          items: [item('bulk', 'post'), item('void', 'post'), item('list', 'get')],
        },
      ],
    };
    expect(safeStart(index)?.id).toBe('list');
  });

  it('opens nothing when no read exists', () => {
    expect(
      safeStart({ codes: [], groups: [{ label: 'x', items: [item('a', 'delete')] }] }),
    ).toBeNull();
  });
});

describe('bulk runs', () => {
  const view = {
    anchor: 'a',
    title: 'Bulk',
    path: '/api/v1/passes/bulk-runs',
    idempotent: true,
  } as never;
  const raw = { operationId: 'passes.postBulkRuns' } as never;
  const doc = { components: {} } as never;
  it('ask twice like a delete, and only the starting POST does', () => {
    expect(runOp(doc, view, raw, 'post').destructive).toBe(true);
    expect(
      runOp(
        doc,
        { ...(view as object), path: '/api/v1/passes/bulk-runs/current' } as never,
        raw,
        'get',
      ).destructive,
    ).toBe(false);
  });
});
