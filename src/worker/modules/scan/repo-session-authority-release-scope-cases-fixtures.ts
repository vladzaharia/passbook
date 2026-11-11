import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { captureTemplateStamps } from './repo-scope-releases.ts';
import { sessionReadFencesCurrent } from './repo-session-authority.ts';
import {
  attachSession,
  CHECK_IN,
  kit,
  scannerSnapshot,
} from './repo-session-authority-test-fixtures.ts';
import { observedScanningSession } from './scanning-workspace-observation.ts';
import { approveScanReleases } from './test-kit.ts';

export function registerSessionScopeReleaseCases() {
  it('combines real credential and complete release snapshots, with a safe redacted fallback', async () => {
    const template = await kit.scanTemplate('Scoped session', { actions: [CHECK_IN] });
    const scanner = await kit.scanner({ templateIds: [template] });
    const actor = await scannerSnapshot(scanner.id);
    const stamps = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [template]);
    if (!stamps) throw new Error('Missing release stamp.');
    const fence = (redacted = false) =>
      sessionReadFencesCurrent(
        kit.ctx,
        actor,
        kit.clock.now(),
        redacted ? [] : stamps.releases,
        redacted ? [] : stamps.legacy,
        { scopeRedacted: redacted },
      );
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: true });
    expect(await sessionReadFencesCurrent(kit.ctx, actor, kit.clock.now(), [], [])).toEqual({
      authorityCurrent: true,
      stampsCurrent: false,
    });
    await approveScanReleases(kit, template, { modes: ['live'] });
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: false });
    expect(await fence(true)).toEqual({ authorityCurrent: true, stampsCurrent: true });
    await run(kit.env.DB, 'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?', [
      'rotated-hash',
      scanner.id,
    ]);
    expect(await fence(true)).toEqual({ authorityCurrent: false, stampsCurrent: false });
  });

  it('fences every captured workspace head in one transaction without partial results', async () => {
    const template = await kit.scanTemplate('Many captured heads', { actions: [CHECK_IN] });
    const scanner = await kit.scanner({ templateIds: [template] });
    await attachSession(scanner.id);
    const actor = await scannerSnapshot(scanner.id);
    const scope = observedScanningSession(actor)?.scope;
    const stamp = scope?.stamps[0];
    if (!scope || !stamp) throw new Error('Missing captured scanner release.');
    scope.stamps.push(...Array.from({ length: 3 }, () => stamp));
    const boundCounts: number[] = [];
    const batchSizes: number[] = [];
    let corrupt: 'missing' | 'sparse' | 'failed' | 'malformed' | null = null;
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    boundCounts.push(values.length);
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            batchSizes.push(statements.length);
            const results = await target.batch(statements);
            if (corrupt === 'missing') return results.slice(0, -1);
            if (corrupt === 'sparse') {
              const partial = results.slice();
              delete partial[1];
              return partial;
            }
            if (corrupt === 'failed')
              return results.map((result, index) =>
                index === 1 ? { ...result, success: false } : result,
              );
            if (corrupt === 'malformed')
              return results.map((result, index) =>
                index === 0 ? { ...result, results: [{ authority_current: '1' }] } : result,
              );
            return results;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    const fence = () => sessionReadFencesCurrent(ctx, actor, kit.clock.now(), [], []);
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: true });
    expect(batchSizes).toEqual([scope.stamps.length + 2]);
    expect(boundCounts).toHaveLength(scope.stamps.length + 3);
    expect(boundCounts.every((count) => count < 100)).toBe(true);
    for (const failure of ['missing', 'sparse', 'failed', 'malformed'] as const) {
      corrupt = failure;
      expect(await fence()).toEqual({ authorityCurrent: false, stampsCurrent: false });
    }
    corrupt = null;
    const release = stamp.releases[0];
    if (!release) throw new Error('Missing captured release head.');
    const last = scope.stamps.length - 1;
    scope.stamps[last] = {
      ...stamp,
      releases: [{ ...release, generation: release.generation + 1 }],
    };
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: false });
    scope.stamps[last] = stamp;
    await approveScanReleases(kit, template, { modes: ['live'] });
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: false });
  });

  it('also fences hidden original scanner scope heads for a workspace projection', async () => {
    const original = await kit.scanTemplate('Device event', { actions: [CHECK_IN] });
    const selected = await kit.scanTemplate('Workspace event', { actions: [CHECK_IN] });
    const deviceEvent = await kit.event({ templateIds: [original] });
    const workspaceEvent = await kit.event({ templateIds: [selected] });
    const scanner = await kit.scanner({ eventId: deviceEvent.id });
    await attachSession(scanner.id, { accepts: JSON.stringify({ eventId: workspaceEvent.id }) });
    const actor = await scannerSnapshot(scanner.id);
    expect(actor.event?.id).toBe(workspaceEvent.id);
    const stamps = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [selected]);
    if (!stamps) throw new Error('Missing workspace stamp.');
    const fence = () =>
      sessionReadFencesCurrent(kit.ctx, actor, kit.clock.now(), stamps.releases, stamps.legacy);
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: true });
    await approveScanReleases(kit, original, { modes: ['live'] });
    expect(await fence()).toEqual({ authorityCurrent: true, stampsCurrent: false });
    expect(
      await sessionReadFencesCurrent(kit.ctx, actor, kit.clock.now(), [], [], {
        scopeRedacted: true,
      }),
    ).toEqual({ authorityCurrent: true, stampsCurrent: true });
  });
}
