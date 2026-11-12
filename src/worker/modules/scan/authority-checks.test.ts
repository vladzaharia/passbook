import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/exact-rows.ts';
import {
  type makeEnv,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { grant } from '../../platform/authority.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { captureScanEpochs, scanActorChecks, scanPrincipal } from './authority-checks.ts';
import { createGuardHarness, get } from './guard-test-fixtures.ts';
import { actorAuthorityCurrent } from './repo-actor-authority.ts';
import { getEvent } from './repo-scope.ts';
import { copyScanEpochs, scanEpochsOf } from './scan-epochs.ts';

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

describe('scan actor authority: epochs and grant checks', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  /** A scanner request through the guard, then a grant built from the captured actor. */
  async function act(headers: Record<string, string>) {
    expect((await get(app, env, '/capture-read', headers)).status).toBe(200);
    const actor = harness.capturedActor;
    if (!actor) throw new Error('no actor');
    const scannerId = actor.scanner?.id ?? '';
    const send = () => {
      const g = grant(createServiceContext(env, { clock }), {
        purpose: 'org_mode.scan.checkin',
        principal: scanPrincipal(actor),
        checks: scanActorChecks(actor, { now: clock.now() }),
      });
      g.update('scanners', { set: { last_seen_at: clock.now() }, where: { id: scannerId } });
      return g.commit();
    };
    const refused = (): Promise<[number, string] | 'ok'> =>
      send().then(
        () => 'ok' as const,
        (e: { status: number; code: string }) => [e.status, e.code] as [number, string],
      );
    return { actor, scannerId, send, refused };
  }
  const authority = (actor: NonNullable<typeof harness.capturedActor>) =>
    actorAuthorityCurrent(env.DB, {
      actor,
      now: clock.now(),
      event: actor.event,
      adminEventTemplates: false,
    });

  describe('captured epochs', () => {
    it('are the ones stored in the scanner row the credential was verified against', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor, scannerId } = await act(s.headers);
      const row = await first<{ credential_epoch: number; config_epoch: number }>(
        env.DB,
        'SELECT credential_epoch, config_epoch FROM scanners WHERE id = ?',
        [scannerId],
      );
      expect(scanEpochsOf(actor)?.scanner).toEqual({
        id: scannerId,
        credential: row?.credential_epoch,
        config: row?.config_epoch,
      });
    });

    it('a spread keeps the epochs, a structuredClone needs copyScanEpochs', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor } = await act(s.headers);
      expect(scanEpochsOf({ ...actor, event: null })).toBe(scanEpochsOf(actor));
      const clone = structuredClone(actor);
      expect(scanEpochsOf(clone)).toBeUndefined();
      copyScanEpochs(actor, clone);
      expect(scanEpochsOf(clone)).toEqual(scanEpochsOf(actor));
      expect(JSON.stringify(actor)).not.toContain('epoch');
    });

    it('an actor without epochs is a 500 SCAN_EPOCHS_MISSING, never a refusal that unpairs', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor } = await act(s.headers);
      const bare = structuredClone(actor);
      const code = (fn: () => unknown) => {
        try {
          fn();
        } catch (e) {
          return [(e as { status: number }).status, (e as { code: string }).code];
        }
        return null;
      };
      expect(code(() => scanPrincipal(bare))).toEqual([500, 'SCAN_EPOCHS_MISSING']);
      expect(code(() => scanActorChecks(bare, { now: clock.now() }))).toEqual([
        500,
        'SCAN_EPOCHS_MISSING',
      ]);
      await expect(captureScanEpochs(env.DB, bare)).rejects.toMatchObject({
        status: 500,
        code: 'SCAN_EPOCHS_MISSING',
      });
    });
  });

  describe('safety: must refuse', () => {
    it('a credential rotated between auth and grant is a re-pair (401)', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor, scannerId, send, refused } = await act(s.headers);
      expect(await send().then(() => 'ok')).toBe('ok');
      await runOne(
        env.DB,
        "UPDATE scanners SET token_hash = 'rotated', updated_at = updated_at + 1 WHERE id = ?",
        [scannerId],
      );
      expect(await refused()).toEqual([401, 'SCANNER_REPAIR']);
      expect(await authority(actor)).toBe(false);
    });

    it('a rotated CSRF secret is a credential change too', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor, scannerId, refused } = await act(s.headers);
      await runOne(
        env.DB,
        "UPDATE scanners SET csrf_secret = 'rotated', updated_at = updated_at + 1 WHERE id = ?",
        [scannerId],
      );
      expect(await refused()).toEqual([401, 'SCANNER_REPAIR']);
      expect(await authority(actor)).toBe(false);
    });

    it('an expired scanner (expires_at) is refused by the clock alone, with no epoch moved', async () => {
      const s = await makeScanner(f, { orgId, expiresAt: clock.now() + 60_000 });
      const { actor, refused } = await act(s.headers);
      expect(await refused()).toBe('ok');
      clock.advance(61_000);
      expect(await refused()).toEqual([401, 'SCANNER_REPAIR']);
      expect(await authority(actor)).toBe(false);
    });

    it('a device idle past DEVICE_IDLE_MS is refused by the grant', async () => {
      const s = await makeScanner(f, { orgId });
      const { refused, scannerId } = await act(s.headers);
      await runOne(env.DB, 'UPDATE scanners SET last_seen_at = ? WHERE id = ?', [
        clock.now() - 31 * 86_400_000,
        scannerId,
      ]);
      expect(await refused()).toEqual([401, 'SCANNER_REPAIR']);
    });

    it('a revoked scanner is refused', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor, scannerId, refused } = await act(s.headers);
      await runOne(env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
        clock.now(),
        scannerId,
      ]);
      expect(await refused()).toEqual([401, 'SCANNER_REPAIR']);
      expect(await authority(actor)).toBe(false);
    });

    it('disabled staff are refused without unpairing the device', async () => {
      const staff = await makeScanStaff(f, { orgId, role: 'manager' });
      const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: staff.id });
      const { actor, refused } = await act(s.headers);
      expect(actor.staff?.id).toBe(staff.id);
      await runOne(env.DB, 'UPDATE scan_staff SET disabled_at = ? WHERE id = ?', [
        clock.now(),
        staff.id,
      ]);
      expect(await refused()).toEqual([409, 'SCAN_STAFF_CHANGED']);
      expect(await authority(actor)).toBe(false);
    });

    it('a staff role or PIN change is refused', async () => {
      const staff = await makeScanStaff(f, { orgId, role: 'manager' });
      const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: staff.id });
      const first = await act(s.headers);
      await runOne(env.DB, "UPDATE scan_staff SET role = 'door' WHERE id = ?", [staff.id]);
      expect(await first.refused()).toEqual([409, 'SCAN_STAFF_CHANGED']);
      expect(await authority(first.actor)).toBe(false);
      // a fresh request re-reads the role: the device is still signed in, as a door
      const again = await act(s.headers);
      expect(again.actor.role).toBe('door');
      expect(await again.refused()).toBe('ok');
      await runOne(env.DB, "UPDATE scan_staff SET pin_hash = 'new' WHERE id = ?", [staff.id]);
      expect(await again.refused()).toEqual([409, 'SCAN_STAFF_CHANGED']);
    });

    it('an archived or reconfigured event is refused', async () => {
      const template = makeTemplate({ id: f.ids.id(), orgId });
      await harness.persistApprovedTemplate(template);
      const event = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
      const s = await makeScanner(f, { orgId, eventId: event.id });
      const { actor, refused } = await act(s.headers);
      expect(scanEpochsOf(actor)?.events[event.id]).toBeDefined();
      await runOne(env.DB, 'UPDATE scan_events SET archived_at = ? WHERE id = ?', [
        clock.now(),
        event.id,
      ]);
      expect(await refused()).toEqual([409, 'SCAN_CONFIG_CHANGED']);
      expect(await authority(actor)).toBe(false);
    });
  });

  describe('liveness: must succeed', () => {
    it('staff sign-in on another device does not break this one', async () => {
      const staff = await makeScanStaff(f, { orgId, role: 'desk' });
      const mine = await makeScanner(f, {
        orgId,
        settings: { staffSignIn: true },
        staffId: staff.id,
      });
      const { actor, refused } = await act(mine.headers);
      const other = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
      await runOne(
        env.DB,
        'UPDATE scanners SET staff_id = ?, staff_since = ?, staff_seen_at = ? WHERE id = ?',
        [staff.id, clock.now(), clock.now(), other.id],
      );
      await runOne(env.DB, 'UPDATE scanners SET staff_seen_at = ? WHERE id = ?', [
        clock.now(),
        other.id,
      ]);
      expect(await refused()).toBe('ok');
      expect(await authority(actor)).toBe(true);
      expect((await get(app, env, '/ping', mine.headers)).status).toBe(200);
    });

    it('volatile edits to the scanner and staff never move an epoch', async () => {
      const staff = await makeScanStaff(f, { orgId, role: 'desk' });
      const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: staff.id });
      const { actor, scannerId, refused } = await act(s.headers);
      await runOne(
        env.DB,
        'UPDATE scanners SET name = ?, last_seen_at = ?, last_ip_prefix = ?, updated_at = updated_at + 5 WHERE id = ?',
        ['Renamed', clock.now(), '10.0.0', scannerId],
      );
      await runOne(
        env.DB,
        "UPDATE scan_staff SET name = 'Renamed', updated_at = updated_at + 5 WHERE id = ?",
        [staff.id],
      );
      expect(await refused()).toBe('ok');
      expect(await authority(actor)).toBe(true);
    });

    it('touching the updated_at stamp of the scanner, staff or event refuses nothing', async () => {
      const template = makeTemplate({ id: f.ids.id(), orgId });
      await harness.persistApprovedTemplate(template);
      const event = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
      const staff = await makeScanStaff(f, { orgId, role: 'desk' });
      const s = await makeScanner(f, {
        orgId,
        eventId: event.id,
        settings: { staffSignIn: true },
        staffId: staff.id,
      });
      const { actor, scannerId, refused } = await act(s.headers);
      await runOne(env.DB, 'UPDATE scan_events SET updated_at = updated_at + 7 WHERE id = ?', [
        event.id,
      ]);
      await runOne(env.DB, 'UPDATE scan_staff SET updated_at = updated_at + 7 WHERE id = ?', [
        staff.id,
      ]);
      await runOne(env.DB, 'UPDATE scanners SET updated_at = updated_at + 7 WHERE id = ?', [
        scannerId,
      ]);
      expect(await refused()).toBe('ok');
      expect(await authority(actor)).toBe(true);
    });

    it('an actor derived without staff passes while the device has no valid binding', async () => {
      const staff = await makeScanStaff(f, { orgId, role: 'desk' });
      const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: staff.id });
      const { actor, scannerId } = await act(s.headers);
      const noStaff = { ...actor, staff: null, role: null };
      expect(scanEpochsOf(noStaff)).toBe(scanEpochsOf(actor));
      const send = () => {
        const g = grant(createServiceContext(env, { clock }), {
          purpose: 'org_mode.scan.checkin',
          principal: scanPrincipal(noStaff),
          checks: scanActorChecks(noStaff, { now: clock.now() }),
        });
        g.update('scanners', { set: { last_seen_at: clock.now() }, where: { id: scannerId } });
        return g.commit();
      };
      // the binding is valid: someone signed in after this actor was derived
      await expect(send()).rejects.toMatchObject({ status: 409, code: 'SCAN_STAFF_CHANGED' });
      // an expired binding is the same as none
      await runOne(env.DB, 'UPDATE scanners SET staff_seen_at = ? WHERE id = ?', [
        clock.now() - 16 * 60_000,
        scannerId,
      ]);
      await expect(send()).resolves.toBeDefined();
    });

    it("an operation's own event is checked by its configuration, not refused for lacking an epoch", async () => {
      const template = makeTemplate({ id: f.ids.id(), orgId });
      await harness.persistApprovedTemplate(template);
      const event = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
      const s = await makeScanner(f, { orgId });
      const { actor, scannerId } = await act(s.headers);
      const row = await getEvent(env.DB, orgId, event.id);
      if (!row) throw new Error('no event');
      const send = () => {
        const g = grant(createServiceContext(env, { clock }), {
          purpose: 'org_mode.scan.checkin',
          principal: scanPrincipal(actor),
          checks: scanActorChecks(actor, { now: clock.now(), event: row }),
        });
        g.update('scanners', { set: { last_seen_at: clock.now() }, where: { id: scannerId } });
        return g.commit();
      };
      await expect(send()).resolves.toBeDefined();
      await runOne(
        env.DB,
        'UPDATE scan_events SET name = ?, updated_at = updated_at + 3 WHERE id = ?',
        ['Renamed', event.id],
      );
      await expect(send()).resolves.toBeDefined();
      await runOne(env.DB, 'UPDATE scan_events SET closes_at = closes_at + 1 WHERE id = ?', [
        event.id,
      ]);
      await expect(send()).rejects.toMatchObject({ status: 409, code: 'SCAN_CONFIG_CHANGED' });
    });

    it('a config-only edit is a 409, never a 401, and the device stays paired', async () => {
      const s = await makeScanner(f, { orgId });
      const { actor, scannerId, refused } = await act(s.headers);
      await runOne(env.DB, "UPDATE scanners SET time_zone = 'Asia/Tokyo' WHERE id = ?", [
        scannerId,
      ]);
      expect(await refused()).toEqual([409, 'SCAN_CONFIG_CHANGED']);
      expect(await authority(actor)).toBe(false);
      // the next request re-reads the configuration with the same credential
      expect((await get(app, env, '/ping', s.headers)).status).toBe(200);
      const next = await act(s.headers);
      expect(scanEpochsOf(next.actor)?.scanner?.credential).toBe(
        scanEpochsOf(actor)?.scanner?.credential,
      );
      expect(await next.refused()).toBe('ok');
    });
  });
});
