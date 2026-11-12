import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectUnavailable,
  kit,
  out,
  retireCredential,
  rows,
  tpl,
} from './act-test-fixtures.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { codeOf, key } from './test-kit.ts';

export function registerAuthorityRetirement() {
  it.each([
    { scannerMode: 'live', passMode: 'test', reason: 'test_pass' },
    { scannerMode: 'test', passMode: 'live', reason: 'live_pass' },
  ] as const)(
    'keeps a $reason refusal passless across modes and on replay',
    async ({ scannerMode, passMode, reason }) => {
      const s = await kit.scanner({ mode: scannerMode, templateIds: [tpl] });
      const pass = await kit.scanPass(
        tpl,
        { memberName: 'Cross Mode Private Person' },
        { mode: passMode },
      );
      const idempotencyKey = key();
      const response = await act(s.headers, codeOf(pass), { idempotencyKey });
      expect(response.status).toBe(200);
      const original = await out(response);
      expect(original).toMatchObject({
        kind: 'refused',
        reason,
        replay: false,
        scanId: null,
        at: null,
        action: null,
        card: null,
        template: null,
        display: null,
        previous: null,
        value: null,
        flags: [],
        undoUntil: null,
        overridable: false,
      });
      const scan = await first<{ id: string }>(
        kit.env.DB,
        'SELECT * FROM scans WHERE idempotency_key = ?',
        [idempotencyKey],
      );
      expect(scan).toMatchObject({
        id: expect.any(String),
        mode: scannerMode,
        state: 'done',
        outcome: 'refused',
        reason: 'not_found',
        pass_id: null,
        template_id: null,
        pass_version: null,
        action_id: null,
        action_kind: null,
      });
      if (!scan) throw new Error('Missing scan');
      const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
        kit.env.DB,
        'SELECT pass_type_identifier, team_identifier FROM signing_identities WHERE id = ?',
        [pass.identityId],
      );
      if (!identity || !pass.scanCode || !pass.releaseId)
        throw new Error('Missing cross-mode fixture identity');
      const refs = await credentialTombstoneRefsForInput(
        kit.ctx,
        kit.org.id,
        scannerMode,
        codeOf(pass),
      );
      for (const forbidden of [
        pass.id,
        pass.serial,
        pass.scanCode,
        pass.identityId,
        pass.releaseId,
        pass.authToken,
        pass.downloadToken,
        identity.pass_type_identifier,
        identity.team_identifier,
        tpl,
        'Gym card',
        'Cross Mode Private Person',
        ...refs.credentialTombstoneRefs,
        ...refs.otherModeCredentialTombstoneRefs,
      ]) {
        expect(JSON.stringify(original)).not.toContain(forbidden);
        expect(JSON.stringify(scan)).not.toContain(forbidden);
      }
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
      ).toHaveLength(0);
      expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(
        0,
      );
      expect(
        await rows('SELECT pass_id FROM scan_presence WHERE pass_id=?', [pass.id]),
      ).toHaveLength(0);
      const replay = await act(s.headers, codeOf(pass), { idempotencyKey });
      expect(replay.status).toBe(200);
      expect(await out(replay)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        replay: true,
        scanId: scan.id,
        action: null,
        card: null,
        template: null,
        display: null,
        previous: null,
        value: null,
        flags: [],
      });
      expect(
        await first(kit.env.DB, 'SELECT * FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
      ).toEqual(scan);
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
      ).toHaveLength(0);
      const overrideKey = key();
      const attemptedOverride = await out(
        await act(s.headers, codeOf(pass), {
          idempotencyKey: overrideKey,
          overrideOf: kit.fx.ids.id(),
        }),
      );
      expect(attemptedOverride).toMatchObject({
        kind: 'refused',
        reason,
        scanId: null,
        replay: false,
      });
      expect(
        await first(
          kit.env.DB,
          `SELECT outcome,reason,pass_id,template_id,action_id,override_of
      FROM scans WHERE idempotency_key=?`,
          [overrideKey],
        ),
      ).toEqual({
        outcome: 'refused',
        reason: 'not_found',
        pass_id: null,
        template_id: null,
        action_id: null,
        override_of: null,
      });
    },
  );

  it('masks an earlier passless receipt after its other-mode credential is retired', async () => {
    const scanner = await kit.scanner({ mode: 'live', templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const idempotencyKey = key();
    expect(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }))).toMatchObject({
      kind: 'refused',
      reason: 'test_pass',
      scanId: null,
    });
    const scan = await first(kit.env.DB, 'SELECT * FROM scans WHERE idempotency_key=?', [
      idempotencyKey,
    ]);
    const refs = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', codeOf(pass));
    const otherModeCredentialRef = refs.otherModeCredentialTombstoneRefs[0];
    if (otherModeCredentialRef === undefined) throw new Error('Missing other-mode credential ref');
    await retireCredential(kit.env.DB, pass.id, otherModeCredentialRef);
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
    expect(
      await first(kit.env.DB, 'SELECT * FROM scans WHERE idempotency_key=?', [idempotencyKey]),
    ).toEqual(scan);
  }, 60_000);

  it('masks a completed pass-backed receipt when its input credential is retired', async () => {
    const template = await kit.scanTemplate('Retired serial lookup', {
      actions: [CHECK_IN],
      lookup: { input: 'memberNo' },
    });
    const other = await kit.scanPass(template);
    const pass = await kit.scanPass(template, { memberNo: other.serial });
    const scanner = await kit.scanner({ templateIds: [template] });
    const input = { code: other.serial, method: 'manual' as const };
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, input, { idempotencyKey }));
    expect(original.kind).toBe('ok');
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id=?', [original.scanId ?? '']),
    ).toEqual({ pass_id: pass.id });
    const gate = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id]);
    const refs = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input);
    const credentialRef = refs.credentialTombstoneRefs[0];
    if (credentialRef === undefined) throw new Error('Missing credential ref');
    await retireCredential(kit.env.DB, other.id, credentialRef);
    expectUnavailable(await out(await act(scanner.headers, input, { idempotencyKey })));
    expect(await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual(
      gate,
    );
    await expectOriginalLedger(pass.id, original.scanId);
  }, 60_000);

  it.each(['voided', 'generation'] as const)(
    'answers a %s change between evaluation and the batched preflight 409, and the retry decides',
    async (change) => {
      const s = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const original = kit.env.DB;
      const matching = new WeakSet<D1PreparedStatement>();
      const idempotencyKey = key();
      let raced = false;
      const db = new Proxy(original, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const prepared = target.prepare(sql);
              if (!sql.includes('SELECT (SELECT rules FROM pass_check_in')) return prepared;
              return new Proxy(prepared, {
                get(statement, member) {
                  if (member === 'bind')
                    return (...params: unknown[]) => {
                      const bound = statement.bind(...params);
                      matching.add(bound);
                      return bound;
                    };
                  const value = Reflect.get(statement, member, statement);
                  return typeof value === 'function' ? value.bind(statement) : value;
                },
              });
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!raced && statements.some((statement) => matching.has(statement))) {
                raced = true;
                await run(
                  target,
                  change === 'voided'
                    ? "UPDATE passes SET status='voided' WHERE id=?"
                    : 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?',
                  [pass.id],
                );
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: db });
      try {
        const response = await act(s.headers, codeOf(pass), { idempotencyKey });
        expect(raced).toBe(true);
        // A race, not a miss: the client retries the same key.
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
      } finally {
        Object.assign(kit.env, { DB: original });
      }
      expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(
        0,
      );
      // The claim is written with the commit grant now, so a refusal leaves no row (or a pristine
      // failed one), never a decided scan bound to the pass.
      expect(
        await first<{ state: string; pass_id: string | null; outcome: string | null }>(
          original,
          'SELECT state,pass_id,outcome FROM scans WHERE idempotency_key=?',
          [idempotencyKey],
        ),
      ).toSatisfy((row) => row === null || (row.state === 'failed' && row.outcome === null));
      const retry = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
      expect(retry).toMatchObject(
        change === 'voided' ? { kind: 'refused', reason: 'voided' } : { kind: 'ok' },
      );
    },
  );
}
