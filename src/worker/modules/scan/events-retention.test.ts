import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser, type ScannerFixture } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { deletePassRows } from '../passes/repo-ops-retention.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { captureEventAuthority, eventView, listEvents } from './events.ts';
import type { EventAuthority } from './repo-event-keyset.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';
import { codeOf, grantScanMembership, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let authority: EventAuthority;
let templateId: string;
let eventId: string;
let scanner: ScannerFixture;

beforeEach(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
  const session = await makeSession(kit.fx, { userId: user.id });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Missing event reader session.');
  authority = await captureEventAuthority(
    kit.ctx,
    auth,
    await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read'),
  );
  templateId = await kit.scanTemplate('Retained arrivals', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
  eventId = (await kit.event({ templateIds: [templateId] })).id;
  scanner = await kit.scanner({ eventId });
});

async function checkedInPass() {
  const pass = await kit.scanPass(templateId);
  const response = await kit.post(scanner.headers, '/actions', {
    input: codeOf(pass),
    actionId: 'check_in',
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
  });
  expect(response.status).toBe(200);
  const outcome = ScanOutcomeSchema.parse(await response.json());
  expect(outcome.kind).toBe('ok');
  if (!outcome.scanId) throw new Error('Missing check-in scan.');
  return { pass, scanId: outcome.scanId };
}

async function hardDelete(id: string) {
  const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
  const pass = await getPass(kit.env.DB, id);
  if (!pass) throw new Error('Missing pass to delete.');
  const retention = await prepareScanRetentionDelete(kit.env, pass);
  expect(
    (await deletePassRows(kit.env.DB, pass, retention, credentialKeysetCommitment)).deleted,
  ).toBe(true);
}

describe('event retained arrivals', () => {
  it('combines live and authenticated hard-deleted arrivals without double-counting live passes', async () => {
    const deleted = await checkedInPass();
    const live = await checkedInPass();
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(2);
    await hardDelete(deleted.pass.id);
    expect(
      await first(kit.env.DB, 'SELECT event_id FROM scan_retained_gates WHERE scan_id=?', [
        deleted.scanId,
      ]),
    ).toEqual({ event_id: eventId });
    // A live scan cannot acquire a forged tombstone outside the deletion transaction.
    await expect(
      run(
        kit.env.DB,
        `INSERT INTO scan_retained_gates
      (scan_id,org_id,mode,event_id,pass_ref,state,presence_state)
      SELECT scan_id,org_id,mode,?,pass_ref,'in','in' FROM scan_retention_proofs WHERE scan_id=?`,
        [eventId, live.scanId],
      ),
    ).rejects.toThrow();
    expect(await eventView(kit.ctx, eventId, authority)).toMatchObject({ arrived: 2, expected: 1 });
    const page = await listEvents(kit.ctx, 'live', { orgId: kit.org.id, limit: 50 }, authority);
    expect(page.items.find((item) => item.id === eventId)).toMatchObject({
      arrived: 2,
      expected: 1,
    });
  });

  it('keeps a pass whose re-entry was undone in the retained totals after the pass is deleted', async () => {
    const entry = await checkedInPass();
    const again = await kit.post(scanner.headers, '/actions', {
      input: codeOf(entry.pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    const second = ScanOutcomeSchema.parse(await again.json());
    if (!second.scanId) throw new Error('Missing re-entry scan.');
    const undone = await kit.post(scanner.headers, `/scans/${second.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ kind: 'ok' });
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(1);
    await hardDelete(entry.pass.id);
    // The undo row has no proof and the undone entry holds no occupancy: neither blocks capture.
    expect(
      await first(kit.env.DB, 'SELECT event_id FROM scan_retained_gates WHERE scan_id=?', [
        entry.scanId,
      ]),
    ).toEqual({ event_id: eventId });
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(1);
  });

  it('does not retain an arrival that was undone before the pass is deleted', async () => {
    const entry = await checkedInPass();
    const undone = await kit.post(scanner.headers, `/scans/${entry.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(0);
    await hardDelete(entry.pass.id);
    expect(
      await first(kit.env.DB, 'SELECT event_id FROM scan_retained_gates WHERE scan_id=?', [
        entry.scanId,
      ]),
    ).toBeNull();
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(0);
  });

  it('rejects a retained gate attached to another event', async () => {
    const entry = await checkedInPass();
    const other = await kit.event({ templateIds: [templateId] });
    const intent = await run(
      kit.env.DB,
      `INSERT INTO scan_retention_delete_intents
      (scan_id,org_id,mode,pass_ref)
      SELECT scan_id,org_id,mode,pass_ref FROM scan_retention_proofs WHERE scan_id=?`,
      [entry.scanId],
    );
    expect(intent.changes).toBe(1);
    try {
      await expect(
        run(
          kit.env.DB,
          `INSERT INTO scan_retained_gates
        (scan_id,org_id,mode,event_id,pass_ref,state,presence_state)
        SELECT scan_id,org_id,mode,?,pass_ref,'in','in' FROM scan_retention_proofs WHERE scan_id=?`,
          [other.id, entry.scanId],
        ),
      ).rejects.toThrow();
    } finally {
      await run(kit.env.DB, 'DELETE FROM scan_retention_delete_intents WHERE scan_id=?', [
        entry.scanId,
      ]);
    }
    await hardDelete(entry.pass.id);
    expect((await eventView(kit.ctx, other.id, authority)).arrived).toBe(0);
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(1);
  });

  it('keeps quarantined live history excluded after the pass is unquarantined', async () => {
    const entry = await checkedInPass();
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(1);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [entry.pass.id]);
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(0);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [entry.pass.id]);
    expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(0);
    const page = await listEvents(kit.ctx, 'live', { orgId: kit.org.id, limit: 50 }, authority);
    expect(page.items.find((item) => item.id === eventId)?.arrived).toBe(0);
  });

  it.each(['invalidated', 'quarantined'] as const)(
    'drops a retained arrival when its evidence is %s',
    async (change) => {
      const entry = await checkedInPass();
      await hardDelete(entry.pass.id);
      expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(1);
      if (change === 'invalidated')
        await run(kit.env.DB, 'UPDATE scan_retention_proofs SET invalidated=1 WHERE scan_id=?', [
          entry.scanId,
        ]);
      else
        await run(kit.env.DB, 'INSERT INTO scan_quarantine_exclusions (scan_id) VALUES (?)', [
          entry.scanId,
        ]);
      expect((await eventView(kit.ctx, eventId, authority)).arrived).toBe(0);
    },
  );
});
