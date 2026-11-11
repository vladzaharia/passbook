import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { run } from '../../platform/db.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act } from './act.ts';
import { captureScanTenantAuthority, scannerActor, tenantScanRole, withRole } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { liveAttachment, publishScan, scanHub } from './live.ts';
import { liveRecipient } from './live-auth.ts';
import { isAcquisition } from './live-catchup-batch-test-fixtures.ts';
import type { InternalLiveRow } from './live-provenance.ts';
import { liveRowsFor } from './live-render.ts';
import { asDeskDisplay } from './live-screen-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { contextWithDb, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { kit } from './scan-hub-test-fixtures.ts';
import {
  createScanningDevice,
  joinAdminScanningSession,
  updateScanningDevice,
} from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { codeOf, grantScanMembership, key, proofedScanActor } from './test-kit.ts';

export function registerCatchupSessionTests() {
  it.each(['platform-session', 'membership', 'workspace'] as const)(
    'prevents multirow catch-up after the recipient %s changes at the final fence',
    async (change) => {
      const user = await makeUser(kit.fx);
      await grantScanMembership(kit.fx, kit.org.id, user.id);
      const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
      const admin = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
      if (!admin) throw new Error('Missing platform session.');
      const manage = await tenantAuthorityOf(kit.ctx, admin, kit.org.id, 'scanning:manage');
      if (manage.kind !== 'session') throw new Error('Missing management membership.');
      const read = await tenantAuthorityOf(kit.ctx, admin, kit.org.id, 'scanning:read');
      if (read.kind !== 'session') throw new Error('Missing read membership.');
      const template = await kit.scanTemplate('Session batch template', {
        actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
      });
      const workspace = await createScanningSession(
        kit.ctx,
        admin.userId,
        'live',
        CreateScanningSessionSchema.parse({
          orgId: kit.org.id,
          name: `Batch workspace ${kit.ctx.ids.token(5)}`,
          timeZone: 'UTC',
          accepts: { templateIds: [template] },
        }),
        manage,
        await captureConsoleSessionCountAuthority(kit.ctx, admin, read),
      );
      const joined = await joinAdminScanningSession(
        kit.ctx,
        admin.userId,
        'live',
        {
          sessionId: workspace.id,
          deviceKey: '33333333-3333-4333-8333-333333333333',
        },
        'https://wallet.test',
        manage,
      );
      const desk = await updateScanningDevice(
        kit.ctx,
        admin.userId,
        workspace.id,
        joined.setupId,
        { surface: 'desk' },
        manage,
      );
      await asDeskDisplay(kit.env.DB, desk.id);
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const device = await createScanningDevice(
          kit.ctx,
          admin.userId,
          'live',
          workspace.id,
          { name: `Batch source ${index}`, surface: 'phone', overrides: {} },
          'https://wallet.test',
          manage,
        );
        if (!device.pairing) throw new Error('Missing pairing code.');
        expect(
          (
            await kit.post({ origin: 'https://wallet.test' }, '/pair', {
              code: device.pairing.code,
            })
          ).status,
        ).toBe(200);
        ids.push(device.id);
      }
      const screenActor = await managedAdminActor(
        kit.ctx,
        admin,
        'live',
        kit.org.id,
        joined.setupId,
      );
      screenActor.platformSessionId = admin.sessionId;
      screenActor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, admin, read);
      screenActor.role = tenantScanRole(screenActor.tenantAuthority);
      await bindScanningSession(kit.ctx, screenActor);
      const attachment = liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, screenActor));
      const passes = [
        await kit.scanPass(template, { memberName: 'Session Ordinary' }),
        await kit.scanPass(template, { memberName: 'Session Photo' }),
      ] as const;
      await putMemberPhoto(
        kit.ctx,
        { type: 'system', id: null },
        passes[1].id,
        { png: btoa(String.fromCharCode(...makePng(270, 270))), includeInPass: false },
        null,
      );
      const inputs = [
        codeOf(passes[0]),
        codeOf(passes[1]),
        {
          code: `SESSION-UNKNOWN-${kit.ctx.ids.token()}`,
          method: 'camera' as const,
        },
      ];
      for (const [index, id] of ids.entries()) {
        const scanner = await getScanner(kit.env.DB, id);
        if (!scanner) throw new Error('Missing paired session source.');
        const raw = scannerActor(
          kit.ctx,
          scanner,
          'live',
          'cookie',
          await readScannerScope(kit.env.DB, scanner, scanner.staffId),
        );
        await bindScanningSession(kit.ctx, raw);
        const actor = await proofedScanActor(kit.ctx, withRole(raw, null));
        const input = inputs[index];
        if (!input) throw new Error('Missing session source input.');
        const evaluation = await act(kit.ctx, actor, {
          input,
          actionId: 'auto',
          clientTs: kit.clock.now(),
          idempotencyKey: key(),
        });
        if (
          !evaluation.credentialContext ||
          (index < 2 && !evaluation.evaluatedSnapshot) ||
          (index === 2 && evaluation.evaluatedSnapshot)
        )
          throw new Error('Invalid session evaluation.');
        publishScan(
          kit.ctx,
          actor,
          evaluation.outcome,
          evaluation.evaluatedSnapshot,
          evaluation.credentialContext,
          'camera',
        );
        await kit.settle();
      }
      const hub = scanHub(kit.ctx, kit.org.id, 'live');
      const idSet = new Set(ids);
      const rows = await runInDurableObject(hub, async (_object, state) =>
        ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter((row) =>
          idSet.has(row.scannerId),
        ),
      );
      expect(rows.map((row) => row.scannerId)).toEqual(ids);
      const budget = traceLiveD1(kit.env.DB);
      const observed = contextWithDb(kit.ctx, budget.db);
      const recipient = await liveRecipient(observed, attachment);
      if (!recipient) throw new Error('Missing managed recipient.');
      const initial = await liveRowsFor(observed, recipient, rows);
      expect(budget.trips.length).toBeLessThanOrEqual(5);
      const sql = budget.trips
        .flatMap((trip) => trip.statements)
        .map((statement) => statement.sql)
        .join('\n');
      expect(sql).toContain('scan-ephemeral-csrf:recipient:session');
      expect(sql).toContain('scan-ephemeral-csrf:source:scanner');
      expect(initial.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      expect(initial[0]).toMatchObject({ passId: passes[0].id, holder: 'Session Ordinary' });
      expect(initial[1]).toMatchObject({ passId: passes[1].id, holder: 'Session Photo' });
      if (!initial[1]) throw new Error('Missing session photo row.');
      expect(initial[1].photoUrl).toBeTruthy();
      expect(initial[2]).toMatchObject({ passId: null, holder: null, photoUrl: null });
      let raced = false;
      const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
        if (!isAcquisition(statements) || raced) return results;
        raced = true;
        if (change === 'platform-session')
          await revokeSession(kit.env.DB, admin.sessionId, kit.clock.now());
        else if (change === 'membership')
          await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
            kit.clock.now(),
            manage.membershipId,
          ]);
        else
          await run(
            kit.env.DB,
            "UPDATE scanning_sessions SET status='paused',updated_at=updated_at+1 WHERE id=?",
            [workspace.id],
          );
        return results;
      });
      const output = await liveRowsFor(contextWithDb(kit.ctx, trace.db), recipient, rows);
      expect(raced).toBe(true);
      expect(output).toEqual([]);
      expect(trace.trips.length).toBeLessThanOrEqual(5);
    },
  );
}
