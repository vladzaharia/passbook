import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureLogs,
  ctx,
  ledger,
  resetLedger,
  rows,
  seedCreated,
  seedGrant,
  setup,
} from './harness.ts';

beforeEach(resetLedger);

const MODES = [
  ['WRITE_MODE is dry_run', { WRITE_MODE: 'dry_run' }, {}],
  ['the caller asks for a dry run in live mode', { WRITE_MODE: 'live' }, { dryRun: true }],
  ['WRITE_MODE is unset', { WRITE_MODE: '' }, {}],
] as const;

describe.each(MODES)('dry run when %s', (_n, patch, over) => {
  async function seeded() {
    const s = setup('v2', patch);
    s.pocket.addUser('u1', { groups: ['g-dev'] });
    s.pocket.addUser('u2', { groups: ['g-other'] });
    s.pocket.addUser('c1', { groups: ['g-dev'] });
    await seedGrant('u1');
    await seedCreated('c1');
    return s;
  }

  it('reads, computes and ledgers every write, and sends none', async () => {
    const s = await seeded();
    await expect(s.api.createSignup({ kind: 'member' }, ctx(over))).resolves.toEqual({
      dryRun: true,
    });
    await expect(s.api.apply('u2', { add: ['console'] }, ctx(over))).resolves.toEqual({
      added: ['console'],
      removed: [],
      skipped: [],
      dryRun: true,
    });
    await expect(s.api.apply('u1', { remove: ['developer'] }, ctx(over))).resolves.toMatchObject({
      removed: ['developer'],
      dryRun: true,
    });
    await expect(s.api.setDisabled('c1', true, ctx(over))).resolves.toEqual({
      result: 'disabled',
      dryRun: true,
    });
    expect(s.pocket.writes()).toHaveLength(0);
    expect(
      (await ledger()).filter((r) => r.phase === 'dry_run').map((r) => [r.method, r.delta]),
    ).toEqual([
      ['createSignup', 'signup'],
      ['apply', '+console'],
      ['apply', '-developer'],
      ['setDisabled', 'disable'],
    ]);
  });

  it('changes no state of its own: no grant, subject, disable mark or signup', async () => {
    const s = await seeded();
    await s.api.apply('u2', { add: ['console'] }, ctx(over));
    await s.api.apply('u1', { remove: ['developer'] }, ctx(over));
    await s.api.setDisabled('c1', true, ctx(over));
    expect(await rows('idp_signups')).toEqual([]);
    expect(await rows('idp_grants')).toMatchObject([{ subject: 'u1', removed_at: null }]);
    expect(
      (await rows('idp_subjects')).find((r) => r.subject === 'c1')?.disabled_by_binding_at,
    ).toBeNull();
    expect((await rows('idp_subjects')).some((r) => r.subject === 'u2')).toBe(false);
    expect(s.pocket.s.users.get('u1')?.groups).toEqual(['g-dev']);
  });

  it('still refuses what a live call would refuse', async () => {
    const s = await seeded();
    s.pocket.addUser('adm', { isAdmin: true });
    await expect(s.api.apply('adm', { add: ['console'] }, ctx(over))).rejects.toThrow(
      /^IDP_REFUSED/,
    );
    await expect(s.api.apply('u1', { add: ['support'] }, ctx(over))).rejects.toThrow(/not mapped/);
  });

  it('reports a no-op as a no-op, and deleteSignup as a dry run', async () => {
    const s = await seeded();
    await expect(s.api.apply('u1', { add: ['developer'] }, ctx(over))).resolves.toMatchObject({
      added: [],
      skipped: [{ role: 'developer', reason: 'already' }],
    });
    s.pocket.s.config = { ...s.pocket.s.config };
    const pocket = s.pocket;
    // a minted token cannot exist in dry run, so seed one the owner's way
    pocket.s.tokens.push({
      id: 'tok-x',
      value: 'v',
      expiresAt: s.clock.now + 1,
      usageCount: 0,
      groups: ['g-dev'],
    });
    await env.DB.prepare(
      `INSERT INTO idp_signups (token_id, token_sha256, kind, targets, ref, created_at, expires_at) VALUES ('tok-x', 'x', 'member', '["console"]', 'r', 1, 2)`,
    ).run();
    await expect(s.api.deleteSignup('tok-x', ctx(over))).resolves.toEqual({ dryRun: true });
    expect(pocket.s.tokens).toHaveLength(1);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('still counts against budgets, so a dry-run week shows the real load', async () => {
    const s = await seeded();
    await s.api.apply('u2', { add: ['console'] }, ctx(over));
    expect(
      (await s.api.health()).budget[
        (over as { dryRun?: boolean }).dryRun ? 'preview' : 'apply_add_system'
      ]?.day,
    ).toBe(1);
  });

  it('reports the mode in health and keeps the safe-config gate', async () => {
    const s = await seeded();
    expect((await s.api.health()).mode).toBe(patch.WRITE_MODE === 'live' ? 'live' : 'dry_run');
    s.pocket.s.config.allowUserSignups = 'open';
    s.clock.now += 11 * 60_000;
    const logs = await captureLogs(() => s.api.apply('u2', { add: ['console'] }, ctx(over)));
    expect(String(logs.error)).toMatch(/^IdpError: IDP_UNSAFE_CONFIG/);
  });
});
