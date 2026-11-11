import { expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act, CHECK_IN, kit, out, tpl } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

export function registerRoundTrips() {
  async function trips(run: () => Promise<unknown>) {
    const counted = countD1(kit.env.DB);
    const original = kit.env.DB;
    Object.assign(kit.env, { DB: counted.db });
    try {
      await run();
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    return counted.count();
  }

  /** The guard's own reads (credential, org, scope) are counted by a request that stops at validation. */
  async function guardTrips(headers: Record<string, string>) {
    return trips(() => kit.post(headers, '/actions', {}));
  }

  it('a door check-in takes at most 6 after the guard, for a winner and for a loser', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const warm = await kit.scanPass(tpl);
    await act(s.headers, codeOf(warm));
    const pass = await kit.scanPass(tpl);
    const base = await guardTrips(s.headers);
    const winner = (await trips(() => act(s.headers, codeOf(pass)))) - base;
    const loser = (await trips(() => act(s.headers, codeOf(pass)))) - base;
    expect(winner).toBeLessThanOrEqual(6);
    expect(loser).toBeLessThanOrEqual(6);
  });

  it('keeps a cold policy-and-photo admission within five trips after the guard', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const original = kit.env.DB;
    const counted = countD1(original);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await kit.post(scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      clearSettingsCache(counted.db);
      const result = await out(await act(scanner.headers, codeOf(pass)));
      expect(result.kind).toBe('ok');
      expect(result.display?.identity.photo?.url).toContain('/assets/member.png?g=');
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(kit.env, { DB: original });
    }
  });

  it('proves the newly committed visit in a cold history-and-photo check-in within five trips', async () => {
    const templateId = await kit.scanTemplate('Cold authenticated visit history', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
      display: {
        v: 1,
        header: { title: 'First visit', subtitle: '{{history.lastScan.action}}' },
        variants: [
          {
            id: 'returning',
            name: 'Returning',
            when: { path: 'history.visits.total', gte: 1 },
            header: { title: 'Returning member' },
          },
        ],
        panels: [
          {
            id: 'p_history',
            rows: [
              { id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] },
            ],
          },
        ],
      },
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const original = kit.env.DB;
    const counted = countD1(original);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await kit.post(scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      clearSettingsCache(counted.db);
      const outcome = await out(await act(scanner.headers, codeOf(pass), { actionId: 'check_in' }));
      expect(outcome).toMatchObject({
        kind: 'ok',
        scanId: expect.any(String),
        display: { variant: 'returning', header: { title: 'Returning member' } },
      });
      expect(JSON.stringify(outcome.display)).toContain('Check in');
      expect(outcome.display?.identity.photo?.url).toContain('/assets/member.png?g=');
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(kit.env, { DB: original });
    }
  });

  it('a refusal takes at most 5 after the guard', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    await act(s.headers, { code: 'WARM-UP-0001', method: 'camera' });
    const base = await guardTrips(s.headers);
    const refusal =
      (await trips(() => act(s.headers, { code: 'ZZZZ-1111', method: 'camera' }))) - base;
    expect(refusal).toBeLessThanOrEqual(5);
  });
}
