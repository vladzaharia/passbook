import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { scenario, requestOf } = policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('scanner history event and source proofs', () => {
  it('redacts a label that becomes a private pass value', async () => {
    const s = await scenario();
    const result = (await (
      await kit.post(s.scanner.headers, '/actions', {
        ...requestOf(s.pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    await run(kit.env.DB, "UPDATE passes SET external_id='Check in' WHERE id=?", [s.pass.id]);
    const recent = (await (await kit.get(s.scanner.headers, '/scans?limit=5')).json()) as {
      items: { scanId: string; actionLabel: string; title: string | null }[];
    };
    expect(recent.items.find((item) => item.scanId === result.scanId)).toMatchObject({
      actionLabel: 'Scan',
      title: null,
    });
    const summary = (await (await kit.get(s.scanner.headers, '/summary')).json()) as {
      total: number;
      byAction: unknown[];
    };
    expect(summary).toMatchObject({ total: 1, byAction: [] });
  });

  it('keeps a tampered event as a minimal receipt and omits its action bucket', async () => {
    const s = await scenario();
    const result = (await (
      await kit.post(s.scanner.headers, '/actions', {
        ...requestOf(s.pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing scan');
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_set(data,'$.authority.role','manager') WHERE pass_id=? AND kind='scan.checked_in'",
      [s.pass.id],
    );
    const recent = (await (await kit.get(s.scanner.headers, '/scans?limit=5')).json()) as {
      items: { scanId: string; actionLabel: string; title: string | null; undoable: boolean }[];
    };
    expect(recent.items.find((item) => item.scanId === result.scanId)).toMatchObject({
      actionLabel: 'Scan',
      title: null,
      undoable: false,
    });
    const summary = (await (await kit.get(s.scanner.headers, '/summary')).json()) as {
      total: number;
      ok: number;
      byAction: unknown[];
    };
    expect(summary).toMatchObject({ total: 1, ok: 1, byAction: [] });
  });

  it('omits every action bucket when any contributing action is unproven', async () => {
    const firstTemplate = await kit.scanTemplate('Visible action', {
      actions: [{ id: 'first_entry', label: 'First entry', kind: 'check_in' }],
    });
    const secondTemplate = await kit.scanTemplate('Unproven action', {
      actions: [{ id: 'second_entry', label: 'Second entry', kind: 'check_in' }],
    });
    const firstPass = await kit.scanPass(firstTemplate);
    const secondPass = await kit.scanPass(secondTemplate);
    const scanner = await kit.scanner({
      templateIds: [firstTemplate, secondTemplate],
      settings: { lookup: true },
    });
    for (const pass of [firstPass, secondPass]) {
      const result = (await (
        await kit.post(scanner.headers, '/actions', {
          ...requestOf(pass.id),
          actionId: 'auto',
        })
      ).json()) as { kind: string };
      expect(result.kind).toBe('ok');
    }
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_remove(data,'$.authority.eventProof') WHERE pass_id=? AND kind='scan.checked_in'",
      [secondPass.id],
    );
    const summary = (await (await kit.get(scanner.headers, '/summary')).json()) as {
      total: number;
      ok: number;
      byAction: unknown[];
    };
    expect(summary).toMatchObject({ total: 2, ok: 2, byAction: [] });
  });

  it('omits an action bucket when a contributor is undone at the final authority batch', async () => {
    const s = await scenario();
    const result = (await (
      await kit.post(s.scanner.headers, '/actions', {
        ...requestOf(s.pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing scan');
    const real = kit.env.DB;
    const summaryStatements = new WeakSet<D1PreparedStatement>();
    let changed = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.includes('COUNT(*) AS total')) return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = statement.bind(...values);
                    summaryStatements.add(bound);
                    return bound;
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!changed && statements.some((statement) => summaryStatements.has(statement))) {
              changed = true;
              await run(real, 'UPDATE scans SET undone_by=id WHERE id=?', [result.scanId]);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    try {
      const summary = (await (await kit.get(s.scanner.headers, '/summary')).json()) as {
        total: number;
        ok: number;
        undone: number;
        byAction: unknown[];
      };
      expect(changed).toBe(true);
      expect(summary).toMatchObject({ total: 1, ok: 1, undone: 1, byAction: [] });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it('aggregates proven contributors across bounded history pages', async () => {
    const s = await scenario();
    for (let index = 0; index < 101; index++) {
      const pass = index === 0 ? s.pass : await kit.scanPass(s.templateId);
      const result = (await (
        await kit.post(s.scanner.headers, '/actions', {
          ...requestOf(pass.id),
          actionId: 'auto',
        })
      ).json()) as { kind: string };
      expect(result.kind).toBe('ok');
    }
    const summary = (await (await kit.get(s.scanner.headers, '/summary')).json()) as {
      total: number;
      ok: number;
      byAction: { actionId: string; label: string; count: number; amount: number }[];
    };
    expect(summary).toMatchObject({
      total: 101,
      ok: 101,
      byAction: [{ actionId: 'check_in', label: 'Check in', count: 101, amount: 0 }],
    });
  }, 120_000);
});
