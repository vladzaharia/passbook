import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { create as createConnection } from '../connections/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setBinding } from '../passes/repo-write.ts';
import { scannerActor, withRole } from './actor.ts';
import { actorAuthorityCurrent } from './repo-actor-authority.ts';
import { getScanner } from './repo-device.ts';
import {
  fixture,
  kit,
  noDisclosure,
  racedResolve,
  raceFence,
  system,
  templateId,
} from './repo-output-authority-split-test-fixtures.ts';
import { passSnapshotCurrent } from './repo-pass-authority.ts';
import { readScannerScope } from './repo-scope.ts';
import { key, proofedScanActor } from './test-kit.ts';

describe('atomic scanner response authority', () => {
  it('keeps the authorized ready, heads-up, audit and lookup responses unchanged', async () => {
    const ready = await fixture({ photo: true });
    const response = await kit.post(ready.scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { passId: ready.pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(await response.json()).toMatchObject({ kind: 'ready', card: { passId: ready.pass.id } });
    const lookup = await kit.post(ready.scanner.headers, '/lookup', { q: ready.pass.id });
    expect(await lookup.json()).toMatchObject({
      items: [{ passId: ready.pass.id, photoUrl: expect.any(String) }],
      more: false,
    });

    const held = await fixture({ tier: 'overdue' });
    const headsUp = await kit.post(held.scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { passId: held.pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(await headsUp.json()).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      card: { passId: held.pass.id },
    });

    const stopped = await fixture();
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [stopped.pass.id]);
    const refusal = await kit.post(stopped.scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { passId: stopped.pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(await refusal.json()).toMatchObject({
      kind: 'refused',
      reason: 'voided',
      card: null,
      display: null,
    });
  });

  it('renders visit history from the ledger, on the card and on the action result', async () => {
    const id = await kit.scanTemplate('Authenticated history display', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
      display: {
        v: 1,
        header: { title: 'First visit' },
        variants: [
          {
            id: 'returning',
            name: 'Returning',
            when: { path: 'history.visits.total', gte: 1 },
            header: { title: 'Returning member' },
          },
          {
            id: 'generic',
            name: 'Generic',
            when: { path: 'history.scans.total', gte: 1 },
            header: { title: 'Previous scan' },
          },
        ],
      },
    });
    const pass = await kit.scanPass(id, { memberName: 'Verified History Member' });
    const scanner = await kit.scanner({ templateIds: [id] });
    const input = { passId: pass.id, method: 'manual' as const };
    const entry = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input,
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    const firstEntry = (await entry.json()) as { kind: string; scanId: string | null };
    expect(firstEntry).toMatchObject({
      kind: 'ok',
      display: { variant: 'returning', header: { title: 'Returning member' } },
    });
    if (!firstEntry.scanId) throw new Error('Missing first scan.');
    const resolve = await kit.post(scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input,
      clientTs: kit.clock.now(),
    });
    expect(await resolve.json()).toMatchObject({
      kind: 'ready',
      card: {
        passId: pass.id,
        // The ready screen drops the band title by design (display-model.md); the variant is the proof.
        display: { variant: 'returning', header: { title: null } },
      },
    });

    const real = kit.env.DB;
    const actionRace = raceFence(real, () =>
      run(
        real,
        `UPDATE pass_events SET data=json_set(data,'$.authority.identityRevision',999999)
       WHERE pass_id=? AND kind='scan.checked_in' AND json_extract(data,'$.scanId')=?`,
        [pass.id, firstEntry.scanId],
      ),
    );
    Object.assign(kit.env, { DB: actionRace.db });
    try {
      const response = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input,
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
      expect(actionRace.fired()).toBe(true);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'ok',
        // Visit history is the scan ledger; rewriting an event's plain data does not unprove it.
        display: { variant: 'returning', header: { title: 'Returning member' } },
      });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    const race = raceFence(real, () =>
      run(
        real,
        "UPDATE pass_events SET data=json_set(data,'$.authority.identityRevision',999998) WHERE pass_id=? AND kind LIKE 'scan.%'",
        [pass.id],
      ),
    );
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input,
        clientTs: kit.clock.now(),
      });
      expect(race.fired()).toBe(true);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'ready',
        card: {
          passId: pass.id,
          lastScans: [],
          // History that changed under the final batch is dropped whole, not shown unproven.
          display: { variant: null, header: { title: null } },
        },
      });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it.each([true, false])(
    'does not disclose a committed action display after actor revocation (revoked=%s)',
    async (revoke) => {
      const f = await fixture({ photo: true });
      const real = kit.env.DB;
      const race = raceFence(real, async () => {
        if (revoke)
          await run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
            kit.clock.now(),
            f.scanner.id,
          ]);
      });
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(f.scanner.headers, '/actions', {
          idempotencyKey: key(),
          input: { passId: f.pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
          actionId: 'check_in',
        });
        expect(race.fired()).toBe(true);
        const text = await response.text();
        if (!revoke) {
          // Positive control: the same action with the scanner still paired is admitted.
          expect(response.status).toBe(200);
          expect(JSON.parse(text)).toMatchObject({ kind: 'ok' });
          return;
        }
        // A revoked scanner is told to pair again (401), with no pass, card, display or grant.
        expect(response.status).toBe(401);
        expect(JSON.parse(text)).toMatchObject({ code: 'SCANNER_REPAIR' });
        noDisclosure(text, f.pass.id);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it.each([
    'scanner',
    'quarantine',
    'wallet',
    'wallet-personalization',
    'wallet-lineage',
    'wallet-version',
    'identity-aba',
    'credential-generation',
    'lifecycle-generation',
    'release',
    'rules',
    'photo',
    'photo-version',
    'photo-key',
    'photo-digest',
    'photo-inclusion',
    'photo-aba',
    'source-privacy',
  ] as const)('suppresses a ready card when %s changes after projection', async (change) => {
    const f = await fixture({ photo: true, lagWallet: change === 'wallet-version' });
    await racedResolve(f, change);
  });

  it('rejects when separately successful actor and Wallet checks never shared a snapshot', async () => {
    const f = await fixture();
    const real = kit.env.DB;
    const scanner = await getScanner(real, f.scanner.id);
    if (!scanner || !f.candidate.passJsonSnapshot) throw new Error('Missing original snapshot.');
    const scope = await readScannerScope(real, scanner, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope), null),
    );
    const originalWallet = f.candidate.passJsonSnapshot;
    const race = raceFence(real, async () => {
      await run(
        real,
        "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.description','changed') WHERE pass_id=? AND version=?",
        [f.pass.id, f.candidate.walletVersion],
      );
      expect(
        await actorAuthorityCurrent(real, {
          actor,
          event: actor.event,
          now: kit.clock.now(),
          templateId,
          adminEventTemplates: false,
        }),
      ).toBe(true);
      await run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        f.scanner.id,
      ]);
      await run(real, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=? AND version=?', [
        originalWallet,
        f.pass.id,
        f.candidate.walletVersion,
      ]);
      expect(
        await passSnapshotCurrent(
          real,
          f.candidate.pass,
          f.candidate.connectionGeneration,
          f.candidate.activeTemplateVersion,
          f.candidate.orgRevision,
          f.candidate.templateRevision,
          kit.clock.now(),
          f.candidate,
        ),
      ).toBe(true);
    });
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(f.scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { passId: f.pass.id, method: 'manual' },
        clientTs: kit.clock.now(),
      });
      expect(race.fired()).toBe(true);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        card: null,
        display: null,
      });
      noDisclosure(text, f.pass.id);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it.each(['event', 'staff', 'scanning session'] as const)(
    'rejects after the original %s changes before the output fence',
    async (change) => {
      const f = await fixture();
      let scanner = f.scanner;
      let target: string;
      if (change === 'event') {
        const event = await kit.event({ templateIds: [templateId] });
        scanner = await kit.scanner({ eventId: event.id });
        target = event.id;
      } else if (change === 'staff') {
        const staff = await kit.staff('manager');
        scanner = await kit.scanner({
          templateIds: [templateId],
          staffId: staff.id,
          settings: { staffSignIn: true },
          staffSince: kit.clock.now(),
          staffSeenAt: kit.clock.now(),
        });
        target = staff.id;
      } else {
        target = kit.fx.ids.id();
        const now = kit.clock.now();
        await run(
          kit.env.DB,
          `INSERT INTO scanning_sessions
          (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
          SELECT ?,org_id,mode,'Output session','active',?,settings,time_zone,?,? FROM scanners WHERE id=?`,
          [target, JSON.stringify({ templateIds: [templateId] }), now, now, scanner.id],
        );
        await run(
          kit.env.DB,
          `INSERT INTO scanning_devices
          (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
          SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
          [target, scanner.id],
        );
      }
      const baseline = await kit.post(scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { passId: f.pass.id, method: 'manual' },
        clientTs: kit.clock.now(),
      });
      expect(await baseline.json()).toMatchObject({ kind: 'ready', card: { passId: f.pass.id } });
      const real = kit.env.DB;
      const race = raceFence(real, () => {
        if (change === 'event')
          // A real configuration change; touching the stamp alone no longer moves authority.
          return run(real, 'UPDATE scan_events SET closes_at=closes_at+1 WHERE id=?', [target]);
        if (change === 'staff')
          return run(real, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
            kit.clock.now(),
            target,
          ]);
        return run(real, "UPDATE scanning_sessions SET status='paused' WHERE id=?", [target]);
      });
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(scanner.headers, '/resolve', {
          idempotencyKey: key(),
          input: { passId: f.pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
        });
        expect(race.fired()).toBe(true);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          kind: 'refused',
          reason: 'not_found',
          card: null,
          display: null,
        });
        noDisclosure(text, f.pass.id);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it('rejects when the original connection generation changes after projection', async () => {
    const f = await fixture();
    const connection = await createConnection(jobCtxOf(kit), system, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Output race connection',
      config: { count: 1 },
      mode: 'manual',
    });
    const pass = await getPass(kit.env.DB, f.pass.id);
    if (!pass) throw new Error('Missing pass.');
    expect(
      await setBinding(jobCtxOf(kit), pass, {
        connectionId: connection.id,
        generation: 1,
        connectionMode: 'manual',
        externalRef: 'output-race',
        fieldSources: pass.fieldSources,
      }),
    ).toBe(true);
    const real = kit.env.DB;
    const race = raceFence(real, () =>
      run(real, 'UPDATE connections SET generation=generation+1 WHERE id=?', [connection.id]),
    );
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(f.scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { passId: f.pass.id, method: 'manual' },
        clientTs: kit.clock.now(),
      });
      expect(race.fired()).toBe(true);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        card: null,
        display: null,
      });
      noDisclosure(text, f.pass.id);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });
});
