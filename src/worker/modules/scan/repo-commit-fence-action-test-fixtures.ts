/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makeSession, makeUser, runOne } from '../../../../test/helpers/index.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import type { Pass } from '../passes/repo.ts';
import {
  accepted,
  atCommit,
  connect,
  type Effects,
  effects,
  expectFencedAction,
  expectRefusedWith,
  kit,
  managerTemplate,
  sessionCountAuthority,
  sessionCreator,
  sessionWriteAuthority,
  template,
  tracking,
} from './repo-commit-fence-test-fixtures.ts';
import { createScanningSession } from './scanning-sessions.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  startScanCredentialTransfer,
} from './test-kit.ts';

export function registerCommitFenceActions() {
  it.each(['link generation', 'owner', 'quarantine', 'version'] as const)(
    'commits or refuses an action by authority when the resolved pass changes its %s',
    async (change) => {
      const mode = change === 'quarantine' ? 'test' : 'live';
      const pass = await kit.scanPass(template, {}, { mode });
      const scanner = await kit.scanner({ mode, templateIds: [template], settings: tracking });
      if (mode === 'test') await accepted(scanner, await kit.scanPass(template, {}, { mode }));
      await expectFencedAction(
        scanner,
        pass,
        async (db) => {
          // The owner only changes through a credential transfer (a trigger refuses a bare update).
          if (change === 'owner')
            return void (await startScanCredentialTransfer(kit, pass.id, {
              db,
              target: { holderEmail: 'owner-change@example.test', ownerUserId: null },
            }));
          const set =
            change === 'link generation'
              ? 'link_generation = link_generation + 1'
              : change === 'quarantine'
                ? 'test_data_quarantined = 1'
                : 'version = version + 1';
          await runOne(db, `UPDATE passes SET ${set} WHERE id = ?`, [pass.id]);
        },
        // A transfer, void, removal or quarantine refuses; a version or link generation is content.
        { code: change === 'quarantine' || change === 'owner' ? 'SCAN_PASS_CHANGED' : 'admitted' },
      );
    },
  );

  it('admits a connected live pass when the connection generation changes after lookup', async () => {
    const control = await kit.scanPass(template);
    await connect(control);
    await accepted(await kit.scanner({ templateIds: [template], settings: tracking }), control);
    const pass = await kit.scanPass(template);
    const connection = await connect(pass);
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    await expectFencedAction(
      scanner,
      pass,
      async (db) => {
        await runOne(db, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          connection,
        ]);
      },
      { code: 'admitted' },
    );
  });

  // Session roles are immutable (0047): revocation is the only way a session stops being an admin's.
  it('fences an administrator whose real D1 session is revoked after resolution', async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const sessionId = await hashSessionCookie(session.cookieValue);
    const app = createApp({
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    const send = (pass: Pass, idempotencyKey: string) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scan/actions`,
          {
            method: 'POST',
            headers: {
              ...session.headers,
              origin: ORIGIN,
              'x-passbook-mode': 'live',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              idempotencyKey,
              input: codeOf(pass),
              clientTs: kit.clock.now(),
              actionId: 'check_in',
              scope: { orgId: kit.org.id, templateIds: [template], timeZone: 'UTC' },
            }),
          },
          kit.env,
        ),
      );
    const control = await send(await kit.scanPass(template), key());
    expect(control.status, await control.clone().text()).toBe(200);
    expect(await control.json()).toMatchObject({ kind: 'ok', replay: false });

    const pass = await kit.scanPass(template);
    const idempotencyKey = key();
    let before: Effects | undefined;
    let scanId = '';
    const response = await atCommit(
      'check-in',
      async (db) => {
        const claim = await first<{ id: string; state: string; pass_id: string | null }>(
          db,
          'SELECT id, state, pass_id FROM scans WHERE actor_key = ? AND idempotency_key = ?',
          [`u:${user.id}`, idempotencyKey],
        );
        expect(claim).toMatchObject({ state: 'pending', pass_id: null });
        if (!claim) throw new Error('The administrator did not reach its pending claim.');
        scanId = claim.id;
        await runOne(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          sessionId,
        ]);
        before = await effects(db, pass.id);
      },
      () => send(pass, idempotencyKey),
    );
    await expectRefusedWith(response, 'ACTOR_CHANGED', scanId, pass.id, before);
  });

  it.each(['revoked', 'device role', 'operator role'] as const)(
    'fences a scanner whose %s changes after resolution',
    async (change) => {
      const pass = await kit.scanPass(template);
      const scanner = await kit.scanner({
        templateIds: [template],
        settings: { ...tracking, roleWithoutSignIn: 'desk' },
      });
      await expectFencedAction(
        scanner,
        pass,
        async (db) => {
          const set =
            change === 'revoked'
              ? `revoked_at = ${kit.clock.now()}`
              : change === 'device role'
                ? "device_role = 'customer'"
                : "settings = json_set(settings, '$.roleWithoutSignIn', 'door')";
          await runOne(db, `UPDATE scanners SET ${set}, updated_at = updated_at + 1 WHERE id = ?`, [
            scanner.id,
          ]);
        },
        { code: change === 'revoked' ? 'SCANNER_REPAIR' : 'SCAN_CONFIG_CHANGED' },
      );
    },
  );

  it.each(['role', 'disabled'] as const)(
    'fences a signed-in staff member whose live %s changes',
    async (change) => {
      const staff = await kit.staff('manager');
      const pass = await kit.scanPass(managerTemplate);
      const scanner = await kit.scanner({
        templateIds: [managerTemplate],
        staffId: staff.id,
        settings: { ...tracking, staffSignIn: true },
      });
      await expectFencedAction(
        scanner,
        pass,
        async (db) => {
          const set = change === 'role' ? "role = 'door'" : `disabled_at = ${kit.clock.now()}`;
          await runOne(
            db,
            `UPDATE scan_staff SET ${set}, updated_at = updated_at + 1 WHERE id = ?`,
            [staff.id],
          );
        },
        { code: 'SCAN_STAFF_CHANGED' },
      );
    },
  );

  it.each(['role', 'disabled'] as const)(
    'fences a Manager approval if the approver becomes %s before commit',
    async (change) => {
      const manager = await kit.staff('manager');
      const pass = await kit.scanPass(managerTemplate);
      const scanner = await kit.scanner({ templateIds: [managerTemplate], settings: tracking });
      await expectFencedAction(
        scanner,
        pass,
        async (db) => {
          const set = change === 'role' ? "role = 'door'" : `disabled_at = ${kit.clock.now()}`;
          await runOne(
            db,
            `UPDATE scan_staff SET ${set}, updated_at = updated_at + 1 WHERE id = ?`,
            [manager.id],
          );
        },
        {
          extra: { approval: { staffId: manager.id, pin: manager.pin } },
          code: 'SCAN_STAFF_CHANGED',
        },
      );
    },
  );

  it.each(['archived', 'changed'] as const)(
    'fences an event that is %s after resolution',
    async (change) => {
      const event = await kit.event({ templateIds: [template] });
      const pass = await kit.scanPass(template);
      const scanner = await kit.scanner({ eventId: event.id, settings: tracking });
      await accepted(scanner, await kit.scanPass(template));
      await expectFencedAction(
        scanner,
        pass,
        async (db) => {
          const set = change === 'archived' ? `archived_at = ${kit.clock.now()}` : 'capacity = 1';
          await runOne(
            db,
            `UPDATE scan_events SET ${set}, updated_at = updated_at + 1 WHERE id = ?`,
            [event.id],
          );
        },
        { code: 'SCAN_CONFIG_CHANGED' },
      );
    },
  );

  it('fences a scanning session paused after resolution', async () => {
    const session = await createScanningSession(
      kit.ctx,
      sessionCreator,
      'live',
      CreateScanningSessionSchema.parse({
        orgId: kit.org.id,
        name: `Session ${key()}`,
        timeZone: 'UTC',
        accepts: { templateIds: [template] },
        settings: tracking,
      }),
      sessionWriteAuthority,
      sessionCountAuthority,
    );
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    await run(
      kit.env.DB,
      "INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode) VALUES (?, ?, ?, 'live')",
      [scanner.id, session.id, kit.org.id],
    );
    await accepted(scanner, await kit.scanPass(template));
    const pass = await kit.scanPass(template);
    await expectFencedAction(
      scanner,
      pass,
      async (db) => {
        await runOne(
          db,
          "UPDATE scanning_sessions SET status = 'paused', updated_at = updated_at + 1 WHERE id = ? AND status = 'active'",
          [session.id],
        );
      },
      { code: 'SCAN_CONFIG_CHANGED' },
    );
  });
}
