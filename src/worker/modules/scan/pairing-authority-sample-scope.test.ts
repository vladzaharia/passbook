import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  atCommit,
  kit,
  member,
  passState,
  request,
  scannerPath,
  scannerState,
  setupPairingAuthorityFixture,
  templateId,
} from './repo-pairing-authority-split-test-fixtures.ts';
import { approveScanReleases } from './test-kit.ts';

setupPairingAuthorityFixture();

describe('pairing tenant authority', () => {
  it('refuses to issue a sample without an active approved Test Apple release', async () => {
    const actor = await member();
    const unapproved = await kit.scanTemplate(
      'Unapproved sample',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { releaseModes: ['live'] },
    );
    const scanner = await kit.scanner({ mode: 'test', templateIds: [unapproved] });
    const beforeScanner = await scannerState(scanner.id);
    const beforePass = await passState();
    const response = await request(
      'POST',
      scannerPath(scanner.id, 'sample-pass'),
      actor.session.headers,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(await scannerState(scanner.id)).toEqual(beforeScanner);
    expect(await passState()).toEqual(beforePass);
  }, 60_000);

  it.each([
    ['templates', 'missing'],
    ['templates', 'wrong-mode'],
    ['event', 'missing'],
    ['event', 'wrong-mode'],
  ] as const)(
    'refuses a sample from a %s scope with a %s release',
    async (kind, reason) => {
      const actor = await member();
      const approved = await kit.registry.resolve(templateId, 'v1');
      const unapproved = kit.registry.add({
        id: `${templateId}-${kind}-${reason}`,
        orgId: kit.org.id,
        manifest: approved.manifest,
        passJson: approved.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, unapproved, { registry: kit.registry });
      if (reason === 'wrong-mode')
        await approveScanReleases(kit, unapproved.id, { modes: ['live'] });
      const templateIds = [templateId, unapproved.id];
      const event = kind === 'event' ? await kit.event({ mode: 'test', templateIds }) : null;
      const scanner = await kit.scanner({
        mode: 'test',
        ...(event ? { eventId: event.id } : { templateIds }),
      });
      const beforeScanner = await scannerState(scanner.id);
      const beforePass = await passState();
      const response = await request(
        'POST',
        scannerPath(scanner.id, 'sample-pass'),
        actor.session.headers,
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'SCANNER_UNASSIGNED' });
      expect(await scannerState(scanner.id)).toEqual(beforeScanner);
      expect(await passState()).toEqual(beforePass);
    },
    60_000,
  );

  it('refuses a sample when the assigned event is in Live mode', async () => {
    const actor = await member();
    const event = await kit.event({ mode: 'live', templateIds: [templateId] });
    const scanner = await kit.scanner({
      mode: 'test',
      eventId: event.id,
      templateIds: [templateId],
    });
    const beforePass = await passState();
    const response = await request(
      'POST',
      scannerPath(scanner.id, 'sample-pass'),
      actor.session.headers,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'SCANNER_UNASSIGNED' });
    expect(await passState()).toEqual(beforePass);
  }, 60_000);

  it.each([
    'scanner generation',
    'scanner mode',
    'scanner template',
    'event template',
    'event archived',
  ] as const)(
    'does not issue a sample after %s changes at commit',
    async (change) => {
      const actor = await member();
      const event = change.startsWith('event')
        ? await kit.event({ mode: 'test', templateIds: [templateId] })
        : null;
      const scanner = await kit.scanner({
        mode: 'test',
        ...(event ? { eventId: event.id } : { templateIds: [templateId] }),
      });
      const beforePass = await passState();
      const beforeAudit = await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE target_id=? AND action='scanner.sample_pass'",
        [scanner.id],
      );
      const response = await atCommit(
        'pass',
        async (db) => {
          if (change === 'scanner generation') {
            // A configuration change moves the scanner's config epoch; its stamp alone no longer does.
            await run(
              db,
              "UPDATE scanners SET time_zone=CASE time_zone WHEN 'Asia/Tokyo' THEN 'UTC' ELSE 'Asia/Tokyo' END WHERE id=?",
              [scanner.id],
            );
          } else if (change === 'scanner mode') {
            await run(db, "UPDATE scanners SET mode='live',updated_at=updated_at+1 WHERE id=?", [
              scanner.id,
            ]);
          } else if (change === 'scanner template') {
            await run(db, 'DELETE FROM scanner_templates WHERE scanner_id=? AND template_id=?', [
              scanner.id,
              templateId,
            ]);
          } else if (change === 'event template') {
            await run(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
              event?.id,
              templateId,
            ]);
          } else {
            await run(
              db,
              'UPDATE scan_events SET archived_at=?,updated_at=updated_at+1 WHERE id=?',
              [kit.clock.now(), event?.id],
            );
          }
        },
        () => request('POST', scannerPath(scanner.id, 'sample-pass'), actor.session.headers),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await passState()).toEqual(beforePass);
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM audit_log WHERE target_id=? AND action='scanner.sample_pass'",
          [scanner.id],
        ),
      ).toEqual(beforeAudit);
    },
    60_000,
  );

  it('does not issue when another accepted template becomes unusable at commit', async () => {
    const actor = await member();
    const other = await kit.scanTemplate('Other accepted sample', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const templateIds = [templateId, other].sort();
    const invalidated = templateIds[1];
    if (!invalidated) throw new Error('Expected two templates.');
    const scanner = await kit.scanner({ mode: 'test', templateIds });
    const beforePass = await passState();
    try {
      const response = await atCommit(
        'pass',
        async (db) => {
          await run(db, "UPDATE templates SET status='deleted' WHERE id=?", [invalidated]);
        },
        () => request('POST', scannerPath(scanner.id, 'sample-pass'), actor.session.headers),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await passState()).toEqual(beforePass);
    } finally {
      await run(kit.env.DB, "UPDATE templates SET status='active' WHERE id=?", [invalidated]);
    }
  }, 60_000);

  it.each(['session scope', 'session status', 'device overrides', 'device attachment'] as const)(
    'does not issue a sample after %s changes at commit',
    async (change) => {
      const actor = await member();
      const headers = { ...actor.session.headers, 'x-passbook-mode': 'test' };
      const sessionResponse = await request('POST', '/scanning-sessions', headers, {
        orgId: kit.org.id,
        name: `Sample ${kit.fx.ids.token(5)}`,
        timeZone: 'UTC',
        accepts: { templateIds: [templateId] },
      });
      expect(sessionResponse.status).toBe(201);
      const session = (await sessionResponse.json()) as { id: string };
      const deviceResponse = await request(
        'POST',
        `/scanning-sessions/${session.id}/devices`,
        headers,
        {
          name: `Device ${kit.fx.ids.token(5)}`,
          surface: 'phone',
        },
      );
      expect(deviceResponse.status).toBe(201);
      const device = (await deviceResponse.json()) as { id: string };
      const beforePass = await passState();
      const beforeAudit = await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE target_id=? AND action='scanner.sample_pass'",
        [device.id],
      );
      const response = await atCommit(
        'pass',
        async (db) => {
          if (change === 'session scope') {
            await run(
              db,
              'UPDATE scanning_sessions SET accepts=NULL,updated_at=updated_at+1 WHERE id=?',
              [session.id],
            );
          } else if (change === 'session status') {
            await run(
              db,
              "UPDATE scanning_sessions SET status='paused',updated_at=updated_at+1 WHERE id=?",
              [session.id],
            );
          } else if (change === 'device overrides') {
            await run(db, 'UPDATE scanning_devices SET overrides=? WHERE scanner_id=?', [
              JSON.stringify({ lookup: false }),
              device.id,
            ]);
          } else {
            await run(db, 'DELETE FROM scanning_devices WHERE scanner_id=?', [device.id]);
          }
        },
        () => request('POST', scannerPath(device.id, 'sample-pass'), headers),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await passState()).toEqual(beforePass);
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM audit_log WHERE target_id=? AND action='scanner.sample_pass'",
          [device.id],
        ),
      ).toEqual(beforeAudit);
    },
    60_000,
  );

  it('issues a sample for the device’s current session scope', async () => {
    const actor = await member();
    const headers = { ...actor.session.headers, 'x-passbook-mode': 'test' };
    const nextTemplate = await kit.scanTemplate('Updated session sample', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const sessionResponse = await request('POST', '/scanning-sessions', headers, {
      orgId: kit.org.id,
      name: `Sample ${kit.fx.ids.token(5)}`,
      timeZone: 'UTC',
      accepts: { templateIds: [templateId] },
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };
    const deviceResponse = await request(
      'POST',
      `/scanning-sessions/${session.id}/devices`,
      headers,
      {
        name: `Device ${kit.fx.ids.token(5)}`,
        surface: 'phone',
      },
    );
    expect(deviceResponse.status).toBe(201);
    const device = (await deviceResponse.json()) as { id: string };
    const updated = await request('PATCH', `/scanning-sessions/${session.id}`, headers, {
      accepts: { templateIds: [nextTemplate] },
    });
    expect(updated.status).toBe(200);
    const response = await request('POST', scannerPath(device.id, 'sample-pass'), headers);
    expect(response.status).toBe(201);
    const sample = (await response.json()) as { passId: string; templateId: string };
    expect(sample.templateId).toBe(nextTemplate);
    expect(
      await first(kit.env.DB, 'SELECT template_id,mode FROM passes WHERE id=?', [sample.passId]),
    ).toEqual({ template_id: nextTemplate, mode: 'test' });
  }, 60_000);
});
