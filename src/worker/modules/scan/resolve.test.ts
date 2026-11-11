import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { door, HOUR, kit, resolve, setupResolveFixture, tpl } from './resolve-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupResolveFixture);

describe('resolve: one fixture per reason', () => {
  it('a pass of the scanner answers ready with a card and the identity display', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const { status, out } = await resolve(s.headers, codeOf(pass));
    expect(status).toBe(200);
    expect(out).toMatchObject({ kind: 'ready', reason: 'choose', scanId: null, replay: false });
    expect(out.card?.passId).toBe(pass.id);
    expect(out.card?.display.identity.holder).toBe('Anna Popescu');
    expect(out.card?.actions[0]).toMatchObject({ id: 'check_in', available: true, lock: null });
  });

  it('not_found', async () => {
    const s = await door();
    const { out } = await resolve(s.headers, { code: 'NOPE-NOT-A-PASS', method: 'camera' });
    expect(out).toMatchObject({ kind: 'refused', reason: 'not_found', card: null, display: null });
  });

  it('ambiguous: two passes share a member number', async () => {
    const s = await door();
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const hash = await sha256Hex(normalizeLookup('AMB-1'));
    for (const p of [a, b])
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ?, revision=revision+1 WHERE id = ?', [
        hash,
        p.id,
      ]);
    const { out } = await resolve(s.headers, { code: 'amb 1', method: 'wedge' });
    expect(out).toMatchObject({ kind: 'refused', reason: 'ambiguous' });
  });

  it('narrowing removes ambiguity: the other pass is of a template this scanner does not accept', async () => {
    const other = await kit.scanTemplate('Other card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const s = await door();
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(other)];
    const hash = await sha256Hex(normalizeLookup('NARROW-1'));
    for (const p of [a, b])
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ?, revision=revision+1 WHERE id = ?', [
        hash,
        p.id,
      ]);
    const { out } = await resolve(s.headers, { code: 'NARROW-1', method: 'manual' });
    expect(out.kind).toBe('ready');
    expect(out.card?.passId).toBe(a.id);
  });

  it('returns only the generic test_pass or live_pass reason across modes', async () => {
    const live = await door();
    const test = await door([tpl], { mode: 'test' });
    const testPass = await kit.scanPass(
      tpl,
      { memberName: 'Test Mode Private Name' },
      { mode: 'test' },
    );
    const livePass = await kit.scanPass(tpl, { memberName: 'Live Mode Private Name' });
    const cases = [
      {
        result: await resolve(live.headers, codeOf(testPass)),
        pass: testPass,
        reason: 'test_pass',
        name: 'Test Mode Private Name',
      },
      {
        result: await resolve(test.headers, codeOf(livePass)),
        pass: livePass,
        reason: 'live_pass',
        name: 'Live Mode Private Name',
      },
    ] as const;
    for (const { result, pass, reason, name } of cases) {
      expect(result.status).toBe(200);
      expect(result.out).toMatchObject({
        kind: 'refused',
        reason,
        scanId: null,
        at: null,
        replay: false,
        action: null,
        card: null,
        template: null,
        display: null,
        previous: null,
        value: null,
        flags: [],
      });
      const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
        kit.env.DB,
        'SELECT pass_type_identifier, team_identifier FROM signing_identities WHERE id = ?',
        [pass.identityId],
      );
      if (!identity || !pass.scanCode || !pass.releaseId)
        throw new Error('Missing cross-mode fixture identity');
      const text = JSON.stringify(result.out);
      for (const secret of [
        name,
        'Gym card',
        tpl,
        pass.id,
        pass.serial,
        pass.scanCode,
        pass.identityId,
        pass.releaseId,
        pass.authToken,
        pass.downloadToken,
        identity.pass_type_identifier,
        identity.team_identifier,
      ])
        expect(text).not.toContain(secret);
    }
  });

  it.each([
    { scannerMode: 'live', passMode: 'test', route: 'resolve' },
    { scannerMode: 'live', passMode: 'test', route: 'actions' },
    { scannerMode: 'test', passMode: 'live', route: 'resolve' },
    { scannerMode: 'test', passMode: 'live', route: 'actions' },
  ] as const)(
    'refuses a cross-mode $route when the scanner loses authority',
    async ({ scannerMode, passMode, route }) => {
      const scanner = await door([tpl], { mode: scannerMode });
      const pass = await kit.scanPass(
        tpl,
        { memberName: 'Cross Mode Actor Race' },
        { mode: passMode },
      );
      const idempotencyKey = key();
      const real = kit.env.DB;
      let raced = false;
      const db = new Proxy(real, {
        get(target, prop) {
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              if (
                !raced &&
                results.some((result) =>
                  result.results?.some((row) => {
                    // D1 guarantees result rows are objects; this batch only needs the id.
                    const batchRow = row as { id?: unknown };
                    return batchRow.id === pass.id;
                  }),
                )
              ) {
                raced = true;
                await run(real, "UPDATE scanners SET device_role='monitor' WHERE id=?", [
                  scanner.id,
                ]);
              }
              return results;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: db });
      let response: Response;
      try {
        response = await kit.post(scanner.headers, `/${route}`, {
          idempotencyKey,
          input: { passId: pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
          ...(route === 'actions' ? { actionId: 'check_in' } : {}),
        });
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(raced).toBe(true);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        scanId: null,
        replay: false,
        action: null,
        template: null,
        card: null,
        display: null,
      });
      for (const secret of [pass.id, pass.serial, pass.scanCode!, 'Cross Mode Actor Race'])
        expect(text).not.toContain(secret);
      expect(
        await first(real, 'SELECT id FROM scans WHERE idempotency_key=?', [idempotencyKey]),
      ).toBeNull();
      expect(
        await all(real, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
      expect(
        await all(real, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
      ).toHaveLength(0);
    },
  );

  it('not_accepted: a pass of another template', async () => {
    const other = await kit.scanTemplate('Other card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const s = await door();
    const { out } = await resolve(s.headers, codeOf(await kit.scanPass(other)));
    expect(out).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
    expect(out.template).toBeNull();
  });

  it('wrong_event: the event matches another tier', async () => {
    const ev = await kit.event({ templateIds: [tpl] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input = ?, match_values = ? WHERE id = ?', [
      'tier',
      '["gold"]',
      ev.id,
    ]);
    const s = await door([], { eventId: ev.id });
    const gold = await kit.scanPass(tpl, { tier: 'gold' });
    const silver = await kit.scanPass(tpl, { tier: 'silver' });
    expect((await resolve(s.headers, codeOf(gold))).out.kind).toBe('ready');
    expect((await resolve(s.headers, codeOf(silver))).out).toMatchObject({ reason: 'wrong_event' });
  });

  it('removed, voided and expired; removed beats expired', async () => {
    const s = await door();
    const removed = await kit.scanPass(tpl);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      kit.clock.now() - HOUR,
      removed.id,
    ]);
    expect((await resolve(s.headers, codeOf(removed))).out).toMatchObject({
      reason: 'removed',
      at: kit.clock.now() - HOUR,
    });
    const voided = await kit.scanPass(tpl);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    expect((await resolve(s.headers, codeOf(voided))).out.reason).toBe('voided');
    const expired = await kit.scanPass(tpl);
    const past = new Date(kit.clock.now() - HOUR).toISOString();
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [past, expired.id],
    );
    expect((await resolve(s.headers, codeOf(expired))).out.reason).toBe('expired');
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      kit.clock.now(),
      expired.id,
    ]);
    expect((await resolve(s.headers, codeOf(expired))).out.reason).toBe('removed');
  });

  it('not_yet_valid and ended for the pass window', async () => {
    const s = await door();
    const soon = await kit.scanPass(tpl, {
      startsAt: new Date(kit.clock.now() + HOUR).toISOString(),
    });
    const late = await kit.scanPass(tpl, {
      endsAt: new Date(kit.clock.now() - HOUR).toISOString(),
    });
    expect((await resolve(s.headers, codeOf(soon))).out).toMatchObject({
      kind: 'heads_up',
      reason: 'not_yet_valid',
      at: kit.clock.now() + HOUR,
    });
    expect((await resolve(s.headers, codeOf(late))).out).toMatchObject({
      kind: 'heads_up',
      reason: 'ended',
    });
  });

  it('not_yet_valid and ended for the event window; a closed event still answers', async () => {
    const pass = await kit.scanPass(tpl);
    const early = await kit.event({
      templateIds: [tpl],
      opensAt: kit.clock.now() + HOUR,
      closesAt: kit.clock.now() + 2 * HOUR,
    });
    const over = await kit.event({
      templateIds: [tpl],
      opensAt: kit.clock.now() - 2 * HOUR,
      closesAt: kit.clock.now() - HOUR,
    });
    const a = await kit.scanner({ eventId: early.id });
    const b = await kit.scanner({ eventId: over.id });
    expect((await resolve(a.headers, codeOf(pass))).out).toMatchObject({
      reason: 'not_yet_valid',
      at: kit.clock.now() + HOUR,
    });
    expect((await resolve(b.headers, codeOf(pass))).out).toMatchObject({
      reason: 'ended',
      at: kit.clock.now() - HOUR,
    });
  });

  it('check_required for a stop flag, with the card and the flag label', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl, { tier: 'overdue' });
    const { out } = await resolve(s.headers, codeOf(pass));
    expect(out).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Unpaid dues'],
    });
    expect(out.card?.flags).toEqual([{ label: 'Unpaid dues', tone: 'warning', stop: true }]);
  });

  it('an unassigned scanner reads nothing: not_accepted, and its session says unassigned', async () => {
    const s = await door([]);
    const pass = await kit.scanPass(tpl);
    expect((await resolve(s.headers, codeOf(pass))).out).toMatchObject({
      kind: 'refused',
      reason: 'not_accepted',
    });
    const session = (await (await kit.get(s.headers, '/session')).json()) as { state: string };
    expect(session.state).toBe('unassigned');
  });
});
