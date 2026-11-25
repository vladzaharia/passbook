import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ctx,
  ledger,
  resetLedger,
  rows,
  seedCreated,
  seedGrant,
  setup,
  userCtx,
} from './harness.ts';

beforeEach(resetLedger);

/** Every source file of the Worker, as text. The test pool has no file system. */
const SOURCES = import.meta.glob('../../workers/polaris-binding/src/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

async function frozen() {
  const s = setup();
  s.pocket.addUser('u1', { groups: ['g-dev'] });
  await seedGrant('u1');
  await seedCreated('u1');
  await s.api.health();
  await s.api.createSignup({ kind: 'developer' }, ctx());
  s.pocket.s.seen.length = 0;
  await expect(s.api.freeze('incident_response', userCtx())).resolves.toBe('frozen');
  return s;
}

describe('freeze', () => {
  it('stops every write with IDP_FROZEN and no Polaris ID request, while reads continue', async () => {
    const s = await frozen();
    await expect(s.api.createSignup({ kind: 'member' }, ctx())).rejects.toThrow(/^IDP_FROZEN/);
    await expect(s.api.deleteSignup('tok-id-1', ctx())).rejects.toThrow(/^IDP_FROZEN/);
    await expect(s.api.apply('u1', { add: ['console'] }, ctx())).rejects.toThrow(/^IDP_FROZEN/);
    await expect(s.api.apply('u1', { remove: ['developer'] }, ctx())).rejects.toThrow(
      /^IDP_FROZEN/,
    );
    await expect(
      s.api.apply('u1', { remove: ['developer'] }, ctx({ override: true })),
    ).rejects.toThrow(/^IDP_FROZEN/);
    await expect(s.api.setDisabled('u1', true, ctx())).rejects.toThrow(/^IDP_FROZEN/);
    expect(s.pocket.s.seen).toHaveLength(0);
    expect((await ledger()).filter((r) => r.status === 'IDP_FROZEN')).toHaveLength(6);
    // reads keep working
    await expect(s.api.lookup('u1')).resolves.toMatchObject({ roles: ['developer'] });
    await expect(s.api.snapshot(ctx())).resolves.toBeDefined();
    await expect(s.api.findByVerifiedEmail('u1@example.test', ctx())).resolves.toEqual({
      subject: 'u1',
    });
    await expect(s.api.health()).resolves.toMatchObject({ frozen: true, ok: false });
  });

  it('is idempotent and records who froze it and why', async () => {
    const s = await frozen();
    await expect(s.api.freeze('again', userCtx())).resolves.toBe('already');
    expect(await rows('idp_freezes')).toMatchObject([
      { reason: 'incident_response', actor: 'user:admin-1', thawed_at: null },
    ]);
  });

  it('has no RPC that thaws', async () => {
    const s = setup();
    const names = Object.keys(s.api).map((n) => n.toLowerCase());
    expect(names.filter((n) => /thaw|unfreeze|resume|unpause/.test(n))).toEqual([]);
    const index = Object.entries(SOURCES).find(([f]) => f.endsWith('/index.ts'))?.[1] ?? '';
    expect(index).not.toMatch(/^\s+(thaw|unfreeze|resume)\w*\(/im);
  });

  it('never writes thawed_at from source: only the owner does, through D1', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
    for (const [file, text] of Object.entries(SOURCES)) {
      expect(text, file).not.toMatch(/UPDATE\s+idp_freezes/i);
      expect(text, file).not.toMatch(/DELETE\s+FROM\s+idp_freezes/i);
    }
  });

  it('keeps the freeze table append-only; thawed_at is set once', async () => {
    await frozen();
    await expect(env.DB.prepare('DELETE FROM idp_freezes').run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE idp_freezes SET reason = 'x'").run()).rejects.toThrow(
      /only thawed_at/,
    );
    await expect(env.DB.prepare('UPDATE idp_freezes SET thawed_at = NULL').run()).rejects.toThrow(
      /only thawed_at/,
    );
    // the owner's command
    await env.DB.prepare('UPDATE idp_freezes SET thawed_at = 5 WHERE thawed_at IS NULL').run();
    await expect(env.DB.prepare('UPDATE idp_freezes SET thawed_at = 6').run()).rejects.toThrow(
      /only thawed_at/,
    );
  });

  it('writes resume after the owner thaws it', async () => {
    const s = await frozen();
    await env.DB.prepare('UPDATE idp_freezes SET thawed_at = 5').run();
    await expect(s.api.createSignup({ kind: 'member' }, ctx())).resolves.toMatchObject({
      tokenId: 'tok-id-2',
    });
  });

  it('freezes again after a thaw, as a new row', async () => {
    const s = await frozen();
    await env.DB.prepare('UPDATE idp_freezes SET thawed_at = 5').run();
    await expect(s.api.freeze('second', userCtx())).resolves.toBe('frozen');
    expect(await rows('idp_freezes')).toHaveLength(2);
  });

  it.each([
    ['a bad reason', 'Not A Reason'],
    ['an empty reason', ''],
  ])('refuses %s', async (_n, reason) => {
    const s = setup();
    await expect(s.api.freeze(reason, userCtx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(await rows('idp_freezes')).toEqual([]);
  });
});
