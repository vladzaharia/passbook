import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { actorAuthorityCurrent } from './repo-actor-authority.ts';
import { sessionReadFencesCurrent } from './repo-session-authority.ts';
import { registerSessionScopeReleaseCases } from './repo-session-authority-release-scope-cases-fixtures.ts';
import {
  attachSession,
  CHECK_IN,
  current,
  kit,
  scannerSnapshot,
  strict,
} from './repo-session-authority-test-fixtures.ts';
import { STAFF_IDLE_MS } from './staff-binding.ts';

export function registerSessionScopeCases() {
  it.each(['disabled', 'removed', 'rebound', 'role', 'binding-revision'] as const)(
    'rejects %s of the bound staff snapshot',
    async (change) => {
      const staff = await kit.staff('desk');
      const scanner = await kit.scanner({ staffId: staff.id, settings: { staffSignIn: true } });
      const actor = await scannerSnapshot(scanner.id);
      expect(actor.staff).toMatchObject({ id: staff.id, role: 'desk', updatedAt: kit.clock.now() });
      expect(await current(actor)).toBe(true);
      if (change === 'disabled')
        await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
          kit.clock.now(),
          staff.id,
        ]);
      else if (change === 'removed')
        await run(kit.env.DB, 'DELETE FROM scan_staff WHERE id=?', [staff.id]);
      else if (change === 'rebound') {
        const other = await kit.staff('manager');
        await run(
          kit.env.DB,
          'UPDATE scanners SET staff_id=?,staff_since=staff_since+1 WHERE id=?',
          [other.id, scanner.id],
        );
      } else if (change === 'role')
        await run(kit.env.DB, `UPDATE scan_staff SET role='door' WHERE id=?`, [staff.id]);
      else
        await run(kit.env.DB, 'UPDATE scanners SET staff_since=staff_since+1 WHERE id=?', [
          scanner.id,
        ]);
      expect(await current(actor)).toBe(false);
    },
  );

  it.each([
    ['name', `UPDATE scan_staff SET name='Changed' WHERE id=?`],
    ['revision', 'UPDATE scan_staff SET updated_at=updated_at+1 WHERE id=?'],
  ] as const)('accepts a staff %s change: it is not authority', async (_name, sql) => {
    const staff = await kit.staff('desk');
    const scanner = await kit.scanner({ staffId: staff.id, settings: { staffSignIn: true } });
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    await run(kit.env.DB, sql, [staff.id]);
    expect(await current(actor)).toBe(true);
  });

  it('rejects an unchanged staff binding that expires before release', async () => {
    const staff = await kit.staff('desk');
    const scanner = await kit.scanner({ staffId: staff.id, settings: { staffSignIn: true } });
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    kit.clock.advance(STAFF_IDLE_MS + 1);
    expect(await current(actor)).toBe(false);
  });

  it('accepts the guard’s intentional stale-staff unbind but not a new binding', async () => {
    const staff = await kit.staff('door');
    const scanner = await kit.scanner({ staffId: staff.id, settings: { staffSignIn: false } });
    const actor = await scannerSnapshot(scanner.id);
    expect(actor.staff).toBeNull();
    expect(await current(actor)).toBe(true);
    const replacement = await kit.staff('manager');
    await run(
      kit.env.DB,
      'UPDATE scanners SET staff_id=?,staff_since=?,staff_seen_at=? WHERE id=?',
      [replacement.id, kit.clock.now(), kit.clock.now(), scanner.id],
    );
    expect(await current(actor)).toBe(false);
  });

  it('retains the linked workspace snapshot after intentionally clearing stale staff', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({ staffId: staff.id, settings: { staffSignIn: false } });
    const sessionId = await attachSession(scanner.id);
    const actor = await scannerSnapshot(scanner.id);
    expect(actor.scanningSession?.id).toBe(sessionId);
    expect(actor.staff).toBeNull();
    expect(await current(actor)).toBe(true);
  });

  it.each(['paused', 'device-surface', 'device-overrides', 'removed-device'] as const)(
    'rejects an observed workspace after %s',
    async (change) => {
      const scanner = await kit.scanner();
      const sessionId = await attachSession(scanner.id);
      const actor = await scannerSnapshot(scanner.id);
      expect(await current(actor)).toBe(true);
      if (change === 'paused')
        await run(kit.env.DB, `UPDATE scanning_sessions SET status='paused' WHERE id=?`, [
          sessionId,
        ]);
      else if (change === 'device-surface')
        await run(kit.env.DB, `UPDATE scanning_devices SET surface='operator' WHERE scanner_id=?`, [
          scanner.id,
        ]);
      else if (change === 'device-overrides')
        await run(
          kit.env.DB,
          `UPDATE scanning_devices SET overrides='{"lookup":false}' WHERE scanner_id=?`,
          [scanner.id],
        );
      else await run(kit.env.DB, 'DELETE FROM scanning_devices WHERE scanner_id=?', [scanner.id]);
      expect(await current(actor)).toBe(false);
    },
  );

  it('accepts a session revision change: it is not authority', async () => {
    const scanner = await kit.scanner();
    const sessionId = await attachSession(scanner.id);
    const actor = await scannerSnapshot(scanner.id);
    await run(kit.env.DB, 'UPDATE scanning_sessions SET updated_at=updated_at+1 WHERE id=?', [
      sessionId,
    ]);
    expect(await current(actor)).toBe(true);
  });

  it('does not treat a missing workspace snapshot or a newly attached device as unassigned', async () => {
    const scanner = await kit.scanner();
    const original = await scannerSnapshot(scanner.id);
    expect(await current(original)).toBe(true);
    await attachSession(scanner.id);
    expect(await current(original)).toBe(false);
    const bound = await scannerSnapshot(scanner.id);
    expect(await current(bound)).toBe(true);
    if (!bound.scanningSession) throw new Error('Missing workspace binding.');
    // A reconstructed id/status/revision is not the original captured device record.
    expect(await current({ ...bound, scanningSession: { ...bound.scanningSession } })).toBe(false);
  });

  it.each(['event-templates'] as const)(
    'rejects changed %s for a returned event',
    async (change) => {
      const template = await kit.scanTemplate('Event scope', { actions: [CHECK_IN] });
      const event = await kit.event({ templateIds: [template] });
      const scanner = await kit.scanner({ eventId: event.id });
      const actor = await scannerSnapshot(scanner.id);
      expect(actor.event?.id).toBe(event.id);
      expect(await current(actor)).toBe(true);
      if (change === 'event-templates') {
        const other = await kit.scanTemplate('Added scope', { actions: [CHECK_IN] });
        await run(
          kit.env.DB,
          'INSERT INTO scan_event_templates(event_id,template_id) VALUES (?,?)',
          [event.id, other],
        );
      }
      expect(await current(actor)).toBe(false);
    },
  );

  it.each([
    ['revision', 'UPDATE scan_events SET updated_at=updated_at+1 WHERE id=?'],
    ['name', `UPDATE scan_events SET name='Changed' WHERE id=?`],
  ] as const)('accepts a returned event %s change: it is not authority', async (_name, sql) => {
    const template = await kit.scanTemplate('Event scope volatile', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const actor = await scannerSnapshot(scanner.id);
    expect(await current(actor)).toBe(true);
    await run(kit.env.DB, sql, [event.id]);
    expect(await current(actor)).toBe(true);
  });

  it('can redact a changed event without accepting a stale scanner credential', async () => {
    const template = await kit.scanTemplate('Redacted event', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const actor = await scannerSnapshot(scanner.id);
    await run(kit.env.DB, "UPDATE scan_events SET time_zone='America/Chicago' WHERE id=?", [
      event.id,
    ]);
    expect(await current(actor)).toBe(false);
    expect(
      await sessionReadFencesCurrent(kit.ctx, actor, kit.clock.now(), [], [], {
        scopeRedacted: true,
      }),
    ).toEqual({ authorityCurrent: true, stampsCurrent: true });
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      scanner.id,
    ]);
    // Stamps are content; the revoked credential alone denies the read.
    expect(
      await sessionReadFencesCurrent(kit.ctx, actor, kit.clock.now(), [], [], {
        scopeRedacted: true,
      }),
    ).toEqual({ authorityCurrent: false, stampsCurrent: true });
  });

  it('permits an unassigned session read without granting a template read', async () => {
    const template = await kit.scanTemplate('Not assigned', { actions: [CHECK_IN] });
    const scanner = await kit.scanner();
    const actor = await scannerSnapshot(scanner.id);
    expect(actor.templateIds).toEqual([]);
    expect(await current(actor)).toBe(true);
    expect(
      await actorAuthorityCurrent(kit.env.DB, {
        actor,
        now: kit.clock.now(),
        event: null,
        templateId: template,
        adminEventTemplates: false,
      }),
    ).toBe(false);
  });

  it('allows roleless staff sign-in, paused, and staffless standalone monitor reads, not pass operations', async () => {
    const awaitingStaff = await kit.scanner({ settings: { staffSignIn: true } });
    const staffless = await scannerSnapshot(awaitingStaff.id);
    expect(staffless.role).toBeNull();
    expect(await current(staffless)).toBe(true);
    expect(await strict(staffless)).toBe(false);

    const pausedScanner = await kit.scanner();
    await attachSession(pausedScanner.id, { status: 'paused' });
    const paused = await scannerSnapshot(pausedScanner.id);
    expect(paused.scanningSession?.status).toBe('paused');
    expect(await current(paused)).toBe(true);
    expect(await strict(paused)).toBe(false);

    const monitor = await kit.scanner({
      kind: 'display',
      deviceRole: 'monitor',
      settings: { staffSignIn: true },
    });
    const screen = await scannerSnapshot(monitor.id);
    expect(screen.role).toBeNull();
    expect(screen.scanningSession).toBeUndefined();
    expect(await current(screen)).toBe(true);
    expect(await strict(screen)).toBe(false);
  });

  it('allows only the empty projection for an originally invalid standalone or session scope', async () => {
    const missing = await kit.scanTemplate(
      'Unreleased scope',
      { actions: [CHECK_IN] },
      { releaseModes: [] },
    );
    const scanner = await kit.scanner({
      templateIds: [missing],
      settings: { acceptAllTemplates: true },
    });
    const invalid = await scannerSnapshot(scanner.id);
    expect(invalid).toMatchObject({
      invalidScannerScope: true,
      event: null,
      templateIds: [],
      settings: { acceptAllTemplates: false },
    });
    expect(await current(invalid)).toBe(true);
    expect(await strict(invalid)).toBe(false);
    expect(await current({ ...invalid, templateIds: [missing] })).toBe(false);
    expect(
      await current({ ...invalid, settings: { ...invalid.settings, acceptAllTemplates: true } }),
    ).toBe(false);

    const workspace = await kit.scanner();
    await attachSession(workspace.id, { accepts: '{"templateIds":[]}' });
    const invalidWorkspace = await scannerSnapshot(workspace.id);
    expect(invalidWorkspace).toMatchObject({
      invalidScannerScope: true,
      event: null,
      templateIds: [],
    });
    expect(await current(invalidWorkspace)).toBe(true);
    expect(await strict(invalidWorkspace)).toBe(false);
  });

  registerSessionScopeReleaseCases();
}
