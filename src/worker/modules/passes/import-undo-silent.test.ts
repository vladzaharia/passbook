import { beforeAll, describe, expect, it, vi } from 'vitest';
import { first } from '../../platform/db.ts';
import { runPassImport } from '../../workflows/pass-import.ts';
import { HEAD, type ImportHarness, setupImportHarness, stepOf } from './import-test-fixtures.ts';

const publishes: { notify?: boolean | undefined; cause: string }[] = [];
vi.mock('./publish.ts', async (original) => {
  const real = await original<typeof import('./publish.ts')>();
  return {
    ...real,
    publishPass: (ctx: unknown, options: { notify?: boolean; cause: string }) => {
      publishes.push({ notify: options.notify, cause: options.cause });
      return (real.publishPass as (c: unknown, o: unknown) => unknown)(ctx, options);
    },
  };
});

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});

describe('an undo is silent', () => {
  it('restores updated passes with change messages off', async () => {
    await h.existing('S-1', { memberName: 'Old', points: 1 });
    const d = await h.draft([HEAD, 'Newer,2,,S-1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    await h.api(h.admin, 'POST', `/${d.id}/undo`, {});
    publishes.length = 0;
    const instance =
      (
        await first<{ v: string }>(
          h.kit.env.DB,
          'SELECT undo_instance AS v FROM pass_imports WHERE id = ?',
          [d.id],
        )
      )?.v ?? '';
    await runPassImport(
      h.kit.env,
      instance,
      { importId: d.id, orgId: h.kit.org.id, mode: 'live', undo: true },
      stepOf(),
    );
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.notify).toBe(false);
  });
});
