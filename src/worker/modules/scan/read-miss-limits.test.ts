import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { Binds } from '../../platform/authority-principal.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import {
  actorFor,
  counter,
  kit,
  scopedKey,
  setupMissIntegration,
  templateId,
  windowStart,
} from './miss-integration-test-fixtures.ts';
import { grantReadMiss, readMissChecks, unchangedCond } from './misses.ts';
import { missWindow } from './repo-miss-authority.ts';
import { searchWindowUnchanged } from './repo-search.ts';
import { notFoundWindow } from './resolve-passless-read.ts';
import { grantScanMembership, key } from './test-kit.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

beforeAll(setupMissIntegration);

const HEX = (c: string) => c.repeat(64);

async function setCount(scannerId: string, count: number) {
  const k = scopedKey(kit.org.id, 'live', `s:${scannerId}`);
  await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,?)', [
    k,
    windowStart(),
    count,
  ]);
  return k;
}
const resolve = (headers: Record<string, string>, input: Record<string, unknown>) =>
  kit.post(headers, '/resolve', { idempotencyKey: key(), input, clientTs: kit.clock.now() });

describe('a miss window is safe by construction', () => {
  it.each([
    ['a bind count that differs from its marks', 'p.id = ?', []],
    ['a tenant column compared to a bound value', 'p.org_id = ?', ['x']],
    ['the reserved a. alias', 'a.id = {org}', []],
    ['the reserved g. alias', 'g.org_id = {org}', []],
    ['a write', 'EXISTS (SELECT 1 FROM passes p WHERE 1) OR (SELECT 1 WHERE delete)', []],
    ['a comment', '1 /* hi */', []],
    ['a second statement', '1; 2', []],
  ] as const)('refuses %s', (_name, sql, params) => {
    expect(() => missWindow(sql, params)).toThrow();
  });

  it('renders both producers with the grant row as the only tenant, every passes alias bound to it', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = {
      ...(await actorFor(scanner.id)),
      templateIds: ['t1', 't2'],
      event: {
        id: 'e1',
        orgId: kit.org.id,
        mode: 'live' as const,
        name: 'e',
        matchInput: 'tier',
        matchValues: JSON.stringify(['gold']),
        opensAt: 0,
        closesAt: 1,
        timeZone: 'UTC',
        capacity: null,
        reentry: false,
        note: null,
        updatedAt: 1,
        archivedAt: null,
      },
    };
    const keys = { scanCode: 'S'.repeat(26), barcodeHash: HEX('d'), lookupHash: HEX('e') };
    const windows = [
      notFoundWindow(actor, { passId: 'p1' }),
      notFoundWindow(actor, {
        scanCode: keys.scanCode,
        barcodeHash: keys.barcodeHash,
        lookupHash: keys.lookupHash,
        serial: 'x',
      }),
      notFoundWindow(actor, null),
      searchWindowUnchanged(actor, 'Alpha', null, keys, kit.clock.now(), [HEX('a')], 2),
      searchWindowUnchanged(actor, 'a@b.test', 'a@b.test', keys, kit.clock.now(), [HEX('a')], 0),
    ];
    for (const window of windows) {
      if (!window) throw new Error('window');
      const b = new Binds();
      const sql = unchangedCond(window).render(b, 'org_mode', 'g');
      expect(b.params).toHaveLength(window.params.length);
      expect(sql).not.toMatch(/\{(?:org|mode)\}/);
      for (const m of sql.matchAll(/FROM passes (\w+)/g)) {
        const alias = m[1];
        const bound =
          sql.match(new RegExp(`\\b${alias}\\.org_id\\s*=\\s*g\\.org_id`, 'g'))?.length ?? 0;
        expect(bound, `${alias} in ${sql.slice(0, 80)}`).toBeGreaterThan(0);
      }
      // No bound value sits next to a tenant column.
      expect(sql).not.toMatch(/\b(?:org_id|mode)\s*(?:=|IS)\s*\?/i);
    }
  });
});

describe('the miss cap is a gate', () => {
  it.each(['resolve', 'lookup'] as const)(
    'refuses %s once the cap is reached, a hit included',
    async (route) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await kit.scanPass(templateId, { memberName: 'Capped Member' });
      const ask = () =>
        route === 'resolve'
          ? resolve(scanner.headers, { passId: pass.id, method: 'manual' })
          : kit.post(scanner.headers, '/lookup', { q: pass.id });
      // Positive control: at the cap's edge (30 counted) a hit is served.
      const k = await setCount(scanner.id, 30);
      const served = await ask();
      expect(served.status).toBe(200);
      expect(await served.text()).toContain(pass.id);
      // Past it, the same hit is refused, with a retry time, and nothing of the pass is sent.
      await run(kit.env.DB, 'UPDATE counters SET count=31 WHERE key=?', [k]);
      const refused = await ask();
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBeTruthy();
      const text = await refused.text();
      expect(text).toContain('SCAN_TOO_MANY_MISSES');
      expect(text).not.toContain(pass.id);
      expect(text).not.toContain('Capped Member');
    },
  );

  it('a later window opens it again', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    await setCount(scanner.id, 40);
    expect((await resolve(scanner.headers, { passId: pass.id, method: 'manual' })).status).toBe(
      429,
    );
    kit.clock.advance(10 * 60_000);
    expect((await resolve(scanner.headers, { passId: pass.id, method: 'manual' })).status).toBe(
      200,
    );
  });
});

describe('an uncounted miss does not say what exists out of scope', () => {
  it('counts a code that matches only a deleted pass, as it counts a code that matches nothing', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const gone = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at=?, revision=revision+1 WHERE id=?', [
      kit.clock.now(),
      gone.id,
    ]);
    const k = await setCount(scanner.id, 10);
    expect(
      (await resolve(scanner.headers, { code: gone.scanCode!, method: 'camera' })).status,
    ).toBe(200);
    expect(await counter(k)).toEqual({ count: 11 });
    expect(
      (await resolve(scanner.headers, { code: 'nothing-like-it-1', method: 'camera' })).status,
    ).toBe(200);
    expect(await counter(k)).toEqual({ count: 12 });
  });

  it('counts a lookup that matches a pass of another template, pending transfer or not', async () => {
    const other = await kit.scanTemplate('Other template', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const elsewhere = await kit.scanPass(other, { memberName: 'Elsewhere Member' });
    await stagePendingCredentialTransfer(kit.env.DB, elsewhere.id, {
      id: kit.fx.ids.id(),
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    const k = await setCount(scanner.id, 10);
    const response = await kit.post(scanner.headers, '/lookup', { q: elsewhere.id });
    expect(await response.json()).toEqual({ items: [], more: false });
    expect(await counter(k)).toEqual({ count: 11 });
  });
});

describe('a blank lookup is a validation error and counts nothing', () => {
  it('answers 422 for a whitespace query', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const k = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
    const response = await kit.post(scanner.headers, '/lookup', { q: '   ' });
    expect(response.status).toBe(422);
    expect(await counter(k)).toBeNull();
  });
});

describe('the miss grant holds the actor as a write does', () => {
  it('names no check with the cap-audit assert reason, for a scanner or an admin', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await actorFor(scanner.id);
    expect(readMissChecks(actor, kit.clock.now(), [HEX('a')]).map((c) => c.reason)).not.toContain(
      'release',
    );
  });

  it("counts nothing once the admin's membership does not grant the capability it was admitted for", async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('Missing admin session');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const build = async (capability: 'scanning:read' | 'scanning:manage') => {
      const actor = adminActor(auth, 'live', {
        orgId: kit.org.id,
        event: null,
        templateIds: [],
        timeZone: 'UTC',
      });
      actor.platformSessionId = auth.sessionId;
      actor.tenantAuthority = {
        ...(await captureScanTenantAuthority(kit.ctx, auth, authority)),
        capability,
      };
      actor.role = tenantScanRole(authority);
      await captureTestEpochs(kit.ctx, actor);
      return actor;
    };
    const observation = { refs: [], unchanged: missWindow('{org} IS NOT NULL', []) };
    expect(await grantReadMiss(kit.ctx, await build('scanning:read'), observation)).toBe('counted');
    // A read-only membership cannot count a miss under a manage capability.
    expect(await grantReadMiss(kit.ctx, await build('scanning:manage'), observation)).toBe(
      'not_committed',
    );
  });
});

describe('a holder erasure moves a generation', () => {
  it.each([
    ['removal', 'UPDATE passes SET removed_at=? WHERE id=?'],
    ['deletion', 'UPDATE passes SET deleted_at=? WHERE id=?'],
  ] as const)('%s bumps the lifecycle generation a read fences on', async (_name, sql) => {
    const pass = await kit.scanPass(templateId);
    const before = await first<{ g: number }>(
      kit.env.DB,
      'SELECT lifecycle_generation AS g FROM passes WHERE id=?',
      [pass.id],
    );
    await run(kit.env.DB, sql, [kit.clock.now(), pass.id]);
    const after = await first<{ g: number }>(
      kit.env.DB,
      'SELECT lifecycle_generation AS g FROM passes WHERE id=?',
      [pass.id],
    );
    expect(after!.g).toBeGreaterThan(before!.g);
  });
});
