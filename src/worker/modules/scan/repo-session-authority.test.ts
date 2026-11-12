import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { managedAdminActor } from './admin-setup.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import {
  packedScanAuthorityPredicate,
  sessionReadAuthorityCurrent,
  sessionReadAuthorityPredicate,
  sessionReadFencesCurrent,
} from './repo-session-authority.ts';
import { registerSessionHistoryCases } from './repo-session-authority-history-cases-fixtures.ts';
import { registerSessionScopeCases } from './repo-session-authority-scope-cases-fixtures.ts';
import {
  adminSnapshot,
  current,
  kit,
  registerSessionAuthorityFixture,
  scannerSnapshot,
} from './repo-session-authority-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { grantScanMembership } from './test-kit.ts';

registerSessionAuthorityFixture();

describe('session DTO actor authority', () => {
  it.each([
    'membership-removed',
    'membership-role-changed',
    'session-revoked',
    'user-disabled',
    'org-suspended',
  ] as const)('rejects a captured admin after %s', async (change) => {
    const { actor, user, membershipId, sessionId } = await adminSnapshot();
    expect(await current(actor)).toBe(true);
    const now = kit.clock.now();
    if (change === 'membership-removed' || change === 'membership-role-changed') {
      await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
        now,
        membershipId,
      ]);
      if (change === 'membership-role-changed')
        await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    } else if (change === 'session-revoked') {
      await run(kit.env.DB, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [now, sessionId]);
    } else if (change === 'user-disabled') {
      await run(kit.env.DB, `UPDATE users SET status='disabled' WHERE id=?`, [user.id]);
    } else {
      await run(kit.env.DB, `UPDATE orgs SET status='suspended' WHERE id=?`, [kit.org.id]);
    }
    expect(await current(actor)).toBe(false);
  });

  it('stays current when the session roles are edited: the edit is refused', async () => {
    const { actor, sessionId } = await adminSnapshot();
    expect(await current(actor)).toBe(true);
    await expect(
      run(kit.env.DB, `UPDATE sessions SET roles='["admin","user"]' WHERE id_hash=?`, [sessionId]),
    ).rejects.toThrow(/immutable/);
    expect(await current(actor)).toBe(true);
  });

  it('requires the captured admin identity, session, role, tenant and mode', async () => {
    const { actor } = await adminSnapshot();
    expect(await current(actor)).toBe(true);
    expect(await current({ ...actor, platformSessionId: 'other' })).toBe(false);
    expect(await current({ ...actor, actor: { type: 'user', id: 'other' } })).toBe(false);
    expect(await current({ ...actor, orgId: 'other' })).toBe(false);
    expect(await current({ ...actor, mode: 'test' })).toBe(false);
    expect(await current({ ...actor, tenantAuthority: undefined })).toBe(false);
    expect(await current({ ...actor, role: null })).toBe(false);
  });

  // The CSRF proof read is gone; the final read still uses the current clock, not the captured time.
  it.each(['idle', 'absolute'] as const)(
    'rejects %s session expiry reached after the captured time',
    async (expiry) => {
      const { actor, sessionId } = await adminSnapshot();
      const row = await first<{ expires_at: number; idle_expires_at: number }>(
        kit.env.DB,
        'SELECT expires_at,idle_expires_at FROM sessions WHERE id_hash=?',
        [sessionId],
      );
      if (!row) throw new Error('Missing session lifetime.');
      if (expiry === 'absolute') {
        await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at=? WHERE id_hash=?', [
          row.expires_at + 60_000,
          sessionId,
        ]);
      }
      const deadline = expiry === 'idle' ? row.idle_expires_at : row.expires_at;
      const before = deadline - 1;
      const at = (now: number) => ({ ...kit.ctx, clock: { now: () => now } });
      expect(await current(actor)).toBe(true);
      expect(await sessionReadAuthorityCurrent(at(before), actor, before)).toBe(true);
      expect(await sessionReadAuthorityCurrent(at(deadline), actor, before)).toBe(false);
      expect(await sessionReadFencesCurrent(at(before), actor, before, [], [])).toMatchObject({
        authorityCurrent: true,
      });
      expect(await sessionReadFencesCurrent(at(deadline), actor, before, [], [])).toMatchObject({
        authorityCurrent: false,
      });
    },
  );

  it('checks the real tenant session and setup owner for a tokenless admin device', async () => {
    const admin = await adminSnapshot();
    const scanner = await kit.scanner();
    await run(
      kit.env.DB,
      'UPDATE scanners SET token_hash=NULL,token_prefix=NULL,csrf_secret=NULL,updated_at=updated_at+1 WHERE id=?',
      [scanner.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanner_setups
      (scanner_id,org_id,mode,admin_session,admin_user_id) VALUES (?,?,'live',1,?)`,
      [scanner.id, kit.org.id, admin.user.id],
    );
    const actor = await managedAdminActor(kit.ctx, admin.auth, 'live', kit.org.id, scanner.id);
    actor.platformSessionId = admin.auth.sessionId;
    actor.tenantAuthority = admin.actor.tenantAuthority;
    actor.role = admin.actor.role;
    await bindScanningSession(kit.ctx, actor);
    const row = await getScanner(kit.env.DB, scanner.id);
    if (!row) throw new Error('Missing scanner fixture.');
    await captureScanEpochs(kit.env.DB, actor, scannerEpochsOf(row));
    expect(await current(actor)).toBe(true);
    await run(kit.env.DB, 'UPDATE scanner_setups SET admin_user_id=NULL WHERE scanner_id=?', [
      scanner.id,
    ]);
    expect(await current(actor)).toBe(false);
  });

  it.each([
    [
      'token hash',
      'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
      'different-hash',
    ],
    [
      'token prefix',
      'UPDATE scanners SET token_prefix=?,updated_at=updated_at+1 WHERE id=?',
      'different-prefix',
    ],
    [
      'CSRF secret',
      'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
      'different-secret',
    ],
    ['revocation', 'UPDATE scanners SET revoked_at=? WHERE id=?', 1],
    [
      'scanner settings',
      `UPDATE scanners SET settings=json_set(settings,'$.lookup',json('false')) WHERE id=?`,
      null,
    ],
    ['expiry', 'UPDATE scanners SET expires_at=? WHERE id=?', 1],
  ] as const)('rejects a %s change after scanner authentication', async (_name, sql, value) => {
    const scanner = await kit.scanner();
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    await run(kit.env.DB, sql, value === null ? [scanner.id] : [value, scanner.id]);
    expect(await current(actor)).toBe(false);
  });

  it.each([
    ['scanner revision', 'UPDATE scanners SET updated_at=updated_at+? WHERE id=?', 1],
    ['scanner name', 'UPDATE scanners SET name=? WHERE id=?', 'Different scanner'],
  ] as const)('accepts a %s change: it is not authority', async (_name, sql, value) => {
    const scanner = await kit.scanner();
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    await run(kit.env.DB, sql, [value, scanner.id]);
    expect(await current(actor)).toBe(true);
  });

  it('keeps scanner CSRF out of packed session authority and rejects rotation', async () => {
    const scanner = await kit.scanner();
    const raw = await getScanner(kit.env.DB, scanner.id);
    if (!raw?.csrfSecret) throw new Error('Missing scanner credential.');
    const actor = await scannerSnapshot(scanner.id);
    const csrf = await actorCsrfFence(kit.ctx, actor);
    if (!csrf) throw new Error('Missing scalar CSRF fence.');
    const predicate = packedScanAuthorityPredicate(
      actor,
      sessionReadAuthorityPredicate(actor, kit.clock.now()),
    );
    expect(actor.scanner?.csrfSecret).toBeNull();
    expect(JSON.stringify(predicate.params).includes(raw.csrfSecret)).toBe(false);
    expect(csrf.params.includes(raw.csrfSecret)).toBe(true);
    const current = () =>
      first<{ ok: number }>(kit.env.DB, `SELECT ((${predicate.sql}) AND (${csrf.sql})) AS ok`, [
        ...predicate.params,
        ...csrf.params,
      ]);
    expect(await current()).toEqual({ ok: 1 });
    await run(kit.env.DB, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
      'rotated-secret',
      scanner.id,
    ]);
    expect(await current()).toEqual({ ok: 0 });
  });

  it('rechecks scanner idle expiry even without changing its captured generation', async () => {
    const scanner = await kit.scanner();
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    await run(kit.env.DB, 'UPDATE scanners SET last_seen_at=? WHERE id=?', [
      kit.clock.now() - DEVICE_IDLE_MS,
      scanner.id,
    ]);
    expect(await current(actor)).toBe(false);
  });

  it('rejects a scanner whose original credential expires before release', async () => {
    const scanner = await kit.scanner({ expiresAt: kit.clock.now() + 1_000 });
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    kit.clock.advance(1_000);
    expect(await current(actor)).toBe(false);
  });

  it.each(['authority', 'fences'] as const)(
    'rechecks scanner expiry at the final read for %s',
    async (check) => {
      const expiresAt = kit.clock.now() + 1_000;
      const scanner = await kit.scanner({ expiresAt });
      const actor = await scannerSnapshot(scanner.id);
      const now = kit.clock.now();
      expect(await current(actor)).toBe(true);
      expect(await sessionReadFencesCurrent(kit.ctx, actor, now, [], [])).toEqual({
        authorityCurrent: true,
        stampsCurrent: true,
      });
      // The request captured `now` before expiry; the read happens at expiry.
      kit.clock.set(expiresAt);
      if (check === 'authority') {
        expect(await sessionReadAuthorityCurrent(kit.ctx, actor, now)).toBe(false);
      } else {
        expect(await sessionReadFencesCurrent(kit.ctx, actor, now, [], [])).toEqual({
          authorityCurrent: false,
          stampsCurrent: true,
        });
      }
    },
  );

  registerSessionScopeCases();
});

describe('minimal historical receipt authority', () => {
  registerSessionHistoryCases();
});
