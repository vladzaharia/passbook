import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { planCounts } from './counts.ts';
import { registerCountsCacheAdminCases } from './repo-counts-cache-admin-cases-test-fixtures.ts';
import {
  adminFor,
  cache,
  csrfFence,
  expectBlocked,
  expectCached,
  kit,
  raceCache,
  type Scenario,
  scenario,
  withMutableTrigger,
} from './repo-counts-cache-fixtures.ts';

export function registerCountsCacheAuthorityCases() {
  it.each(['scanner', 'admin'] as const)(
    'fences %s CSRF rotation without a revision bump in the cache batch',
    async (principal) => {
      const s = await scenario();
      const actor = principal === 'scanner' ? s.actor : await adminFor(s);
      const guard = await csrfFence(actor);
      const initial = planCounts(kit.ctx, actor, undefined, actor, guard);
      expect(
        (await initial.read(await kit.env.DB.batch(initial.stmts))).counts.event?.expected,
      ).toBe(1);
      expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
      await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=0 WHERE id=?', [
        s.event.id,
      ]);
      const id = principal === 'scanner' ? s.scanner.id : actor.platformSessionId;
      const table = principal === 'scanner' ? 'scanners' : 'sessions';
      const key = principal === 'scanner' ? 'id' : 'id_hash';
      const original = await first<{ secret: string }>(
        kit.env.DB,
        `SELECT csrf_secret AS secret FROM ${table} WHERE ${key}=?`,
        [id],
      );
      if (!original) throw new Error('Missing CSRF secret fixture');
      const trigger =
        principal === 'scanner' ? 'scanners_credential_revision' : 'sessions_csrf_secret_immutable';
      await withMutableTrigger(trigger, async () => {
        try {
          const race = raceCache((db) =>
            run(db, `UPDATE ${table} SET csrf_secret=? WHERE ${key}=?`, ['rotated-csrf', id]),
          );
          const plan = planCounts(race.ctx, actor, undefined, actor, guard);
          const results = await race.ctx.env.DB.batch(plan.stmts);
          expect(race.raced()).toBe(true);
          expect(results[3]?.results).toEqual([]);
          expect((await plan.read(results)).counts.event?.expected).toBe(1);
          expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
        } finally {
          await run(kit.env.DB, `UPDATE ${table} SET csrf_secret=? WHERE ${key}=?`, [
            original.secret,
            id,
          ]);
        }
      });
    },
  );

  it('fences a replaced credential keyset before the cache batch', async () => {
    const s = await scenario();
    const original = s.actor.credentialKeysetCommitment;
    if (!original) throw new Error('Missing credential keyset fixture');
    const replacement = (original === 'f'.repeat(64) ? 'e' : 'f').repeat(64);
    await withMutableTrigger('credential_ref_keyset_no_update', async () => {
      try {
        await expectBlocked(s, (db) =>
          run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [replacement]),
        );
      } finally {
        await run(kit.env.DB, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
          original,
        ]);
      }
    });
  });

  it.each(['invalid', 'f'.repeat(64)])(
    'does not cache with an invalid or stale keyset %s',
    async (keyset) => {
      const s = await scenario();
      const value = keyset === s.actor.credentialKeysetCommitment ? 'e'.repeat(64) : keyset;
      const actor = { ...s.actor, credentialKeysetCommitment: value };
      const plan = planCounts(kit.ctx, actor);
      const results = await kit.env.DB.batch(plan.stmts);
      expect(results[3]?.results).toEqual([]);
      expect((await plan.read(results)).counts.event?.expected).toBe(1);
      expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
    },
  );

  it.each([
    [
      'event match without a revision bump',
      (db: D1Database, s: Scenario) =>
        run(db, `UPDATE scan_events SET match_input='tier',match_values='["gold"]' WHERE id=?`, [
          s.event.id,
        ]),
    ],
    [
      'event archive',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scan_events SET archived_at=1 WHERE id=?', [s.event.id]),
    ],
    [
      'event mode',
      (db: D1Database, s: Scenario) =>
        run(db, "UPDATE scan_events SET mode='test' WHERE id=?", [s.event.id]),
    ],
    [
      'event template addition',
      (db: D1Database, s: Scenario) =>
        run(db, 'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)', [
          s.event.id,
          s.otherTemplateId,
        ]),
    ],
    [
      'event template removal',
      (db: D1Database, s: Scenario) =>
        run(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
          s.event.id,
          s.templateId,
        ]),
    ],
    [
      'selected template deletion',
      (db: D1Database, s: Scenario) =>
        run(db, "UPDATE templates SET status='deleted' WHERE id=?", [s.templateId]),
    ],
    [
      'scanner mode',
      (db: D1Database, s: Scenario) =>
        run(db, "UPDATE scanners SET mode='test' WHERE id=?", [s.scanner.id]),
    ],
    [
      'scanner event assignment',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scanners SET event_id=NULL WHERE id=?', [s.scanner.id]),
    ],
    [
      'scanner settings',
      (db: D1Database, s: Scenario) =>
        run(
          db,
          `UPDATE scanners SET settings=json_set(settings,'$.lookup',json('false')) WHERE id=?`,
          [s.scanner.id],
        ),
    ],
    [
      'scanner role',
      (db: D1Database, s: Scenario) =>
        run(db, "UPDATE scanners SET device_role='monitor' WHERE id=?", [s.scanner.id]),
    ],
    [
      'scanner revocation',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scanners SET revoked_at=1 WHERE id=?', [s.scanner.id]),
    ],
    [
      'scanner credential rotation',
      (db: D1Database, s: Scenario) =>
        run(db, "UPDATE scanners SET token_hash='replaced',updated_at=updated_at+1 WHERE id=?", [
          s.scanner.id,
        ]),
    ],
    [
      'scanner CSRF credential rotation',
      (db: D1Database, s: Scenario) =>
        run(db, "UPDATE scanners SET csrf_secret='replaced',updated_at=updated_at+1 WHERE id=?", [
          s.scanner.id,
        ]),
    ],
    [
      'scanner credential prefix',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scanners SET token_prefix=?,updated_at=updated_at+1 WHERE id=?', [
          kit.fx.ids.token(12),
          s.scanner.id,
        ]),
    ],
    [
      'scanner credential pairing generation',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scanners SET paired_at=paired_at+1 WHERE id=?', [s.scanner.id]),
    ],
    [
      'scanner credential expiration change',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scanners SET expires_at=expires_at+1 WHERE id=?', [s.scanner.id]),
    ],
    [
      'scanner credential expiry',
      (db: D1Database, s: Scenario) =>
        run(db, 'UPDATE scanners SET expires_at=1 WHERE id=?', [s.scanner.id]),
    ],
  ] as const)('does not cache after %s changes', async (_label, mutate) => {
    const s = await scenario();
    await expectBlocked(
      s,
      (db) => mutate(db, s),
      s.actor,
      undefined,
      _label === 'selected template deletion' ? 0 : 1,
    );
  });

  it.each(['disabled', 'role', 'unbound'] as const)(
    'does not cache after the signed-in staff member is %s',
    async (change) => {
      const s = await scenario({ staff: true });
      if (!s.staff) throw new Error('Missing staff fixture');
      const staffId = s.staff.id;
      await expectBlocked(s, (db) =>
        change === 'unbound'
          ? run(db, 'UPDATE scanners SET staff_id=NULL WHERE id=?', [s.scanner.id])
          : run(
              db,
              change === 'disabled'
                ? 'UPDATE scan_staff SET disabled_at=1 WHERE id=?'
                : "UPDATE scan_staff SET role='door' WHERE id=?",
              [staffId],
            ),
      );
    },
  );

  it.each(['paused', 'mode', 'scope', 'malformed scope', 'overrides', 'detached'] as const)(
    'does not cache after the scanning session %s changes',
    async (change) => {
      const s = await scenario({ session: true });
      if (!s.sessionId) throw new Error('Missing session fixture');
      const sessionId = s.sessionId;
      await expectBlocked(s, (db) => {
        if (change === 'detached')
          return run(db, 'DELETE FROM scanning_devices WHERE scanner_id=?', [s.scanner.id]);
        if (change === 'overrides')
          return run(
            db,
            `UPDATE scanning_devices SET overrides='{"lookup":false}' WHERE scanner_id=?`,
            [s.scanner.id],
          );
        if (change === 'scope')
          return run(db, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
            JSON.stringify({ templateIds: [s.templateId] }),
            sessionId,
          ]);
        if (change === 'malformed scope')
          return run(db, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
            JSON.stringify({ eventId: s.event.id, templateIds: [s.templateId] }),
            sessionId,
          ]);
        const sql =
          change === 'paused'
            ? "UPDATE scanning_sessions SET status='paused' WHERE id=?"
            : "UPDATE scanning_sessions SET mode='test' WHERE id=?";
        return run(db, sql, [sessionId]);
      });
    },
  );

  // updated_at, names and notes are labels, not epochs (authority-epochs.md section 1.1): a touch of
  // the event, scanner, staff member or session must not stop the count from being cached.
  it.each([
    ['event', 'UPDATE scan_events SET updated_at=updated_at+1, name=name || ? WHERE id=?'],
    ['scanner', 'UPDATE scanners SET updated_at=updated_at+1, name=name || ? WHERE id=?'],
    ['staff member', 'UPDATE scan_staff SET updated_at=updated_at+1, name=name || ? WHERE id=?'],
    [
      'scanning session',
      'UPDATE scanning_sessions SET updated_at=updated_at+1, name=name || ? WHERE id=?',
    ],
  ] as const)('still caches after a %s label or timestamp changes', async (kind, sql) => {
    const s = await scenario({
      staff: kind === 'staff member',
      session: kind === 'scanning session',
    });
    const id =
      kind === 'event'
        ? s.event.id
        : kind === 'scanner'
          ? s.scanner.id
          : kind === 'staff member'
            ? s.staff?.id
            : s.sessionId;
    if (!id) throw new Error('Missing fixture row');
    await expectCached(s, (db) => run(db, sql, [' (renamed)', id]));
  });

  it('does not cache after the organization is suspended', async () => {
    const s = await scenario();
    try {
      await expectBlocked(s, (db) =>
        run(db, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]),
      );
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status='active' WHERE id=?", [kit.org.id]);
    }
  });

  registerCountsCacheAdminCases();
}
