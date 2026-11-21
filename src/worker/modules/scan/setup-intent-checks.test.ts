import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import type { AccessManifest } from '../../../passkit/types.ts';
import { all } from '../../platform/db.ts';
import { door, fixture, made, post } from './setup-intent-test-fixtures.ts';

const ACTIONS = [{ id: 'entry', label: 'Check in', kind: 'check_in' as const }];
let templateId: string;
let accessId: string;
beforeAll(async () => {
  await fixture.setup();
  templateId = await fixture.kit.scanTemplate('Checks pass', { actions: ACTIONS });
  const access: AccessManifest = {
    input: { plan: 'plan' },
    plans: [{ id: 'pool_only', label: 'Pool only', kind: 'always', zones: [{ zone: 'pool' }] }],
  };
  accessId = await fixture.kit.scanTemplate('Access card', { actions: ACTIONS, access });
});

const orgId = () => fixture.kit.org.id;
const codes = (r: { checks: { code: string }[] }) => r.checks.map((c) => c.code);

describe('setup checks on a real plan', () => {
  it('warns when an admitted Access card has no plan for the place', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        places: [{ ref: 'gym', name: 'Gym floor', key: 'gym', max: 30 }],
        doors: [door(accessId, { name: 'Gym door', place: 'gym' })],
      }),
    );
    const check = result.checks.find((c) => c.code === 'PLAN_MISSES_PLACE');
    expect(check).toMatchObject({ level: 'warn', door: 'door-1' });
  });

  it('is quiet when a plan grants the place', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        places: [{ ref: 'pool', name: 'Pool deck', key: 'pool', max: 30 }],
        doors: [
          door(accessId, {
            name: 'Pool door',
            place: 'pool',
            devices: [{ layout: 'phone', direction: 'both' }],
          }),
        ],
      }),
    );
    expect(codes(result)).not.toContain('PLAN_MISSES_PLACE');
  });

  it('warns that no device can scan out of a counted place', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        places: [{ ref: 'room', name: 'Counted room', max: 10 }],
        doors: [
          door(templateId, { name: 'In only', place: 'room', devices: [{ direction: 'in' }] }),
        ],
      }),
    );
    expect(result.checks.find((c) => c.code === 'NO_EXIT')).toMatchObject({ level: 'warn' });
  });

  it('refuses a direction on a check-in type that does not track, writing nothing', async () => {
    const sessions = async () =>
      (
        await all(fixture.kit.env.DB, 'SELECT id FROM scanning_sessions WHERE org_id = ?', [
          orgId(),
        ])
      ).length;
    const before = await sessions();
    const res = await post({
      orgId: orgId(),
      doors: [
        door(templateId, {
          name: 'Bad direction',
          devices: [{ direction: 'out' }],
          more: { checkIn: { mode: 'single' } },
        }),
      ],
    });
    await expectProblem(res, 422, 'SCAN_SETUP_CHECKS_FAILED');
    expect(await sessions()).toBe(before);
    const dry = await post(
      {
        orgId: orgId(),
        doors: [
          door(templateId, {
            name: 'Bad direction',
            devices: [{ direction: 'out' }],
            more: { checkIn: { mode: 'single' } },
          }),
        ],
      },
      fixture.fake.admin(),
      null,
      '?dryRun=true',
    );
    const plan = (await dry.json()) as { checks: { code: string; level: string }[] };
    expect(plan.checks).toContainEqual(
      expect.objectContaining({ code: 'DIRECTION_NEEDS_TRACKING', level: 'error' }),
    );
  });

  it('refuses a name that matches nothing in the setup, with its path', async () => {
    const res = await post({
      orgId: orgId(),
      doors: [door(templateId, { name: 'Lost', place: 'nowhere' })],
    });
    await expectProblem(res, 422, 'SCAN_SETUP_INVALID');
  });
});

describe('end with remove its devices', () => {
  const end = (id: string, body: Record<string, unknown>) =>
    fixture.call('PATCH', `/scanning-sessions/${id}`, { status: 'ended', ...body });
  const revoked = async (ids: string[]) =>
    (
      await all<{ revoked_at: number | null }>(
        fixture.kit.env.DB,
        'SELECT revoked_at FROM scanners WHERE id IN (SELECT value FROM json_each(?))',
        [JSON.stringify(ids)],
      )
    ).map((r) => r.revoked_at !== null);

  it('revokes every device in the same write, and only when asked', async () => {
    const a = await made(
      await post({ orgId: orgId(), doors: [door(templateId, { name: 'End keep' })] }),
    );
    const keep = a.sessions[0];
    expect((await end(keep?.id ?? '', {})).status).toBe(200);
    expect(await revoked(keep?.devices.map((d) => d.id) ?? [])).toEqual([false]);
    const b = await made(
      await post({
        orgId: orgId(),
        doors: [door(templateId, { name: 'End drop', devices: [{}, { layout: 'phone' }] })],
      }),
    );
    const drop = b.sessions[0];
    const res = await end(drop?.id ?? '', { removeDevices: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await revoked(drop?.devices.map((d) => d.id) ?? [])).toEqual([true, true]);
  });

  it('is refused without ending', async () => {
    const a = await made(
      await post({ orgId: orgId(), doors: [door(templateId, { name: 'Pause drop' })] }),
    );
    const res = await fixture.call('PATCH', `/scanning-sessions/${a.sessions[0]?.id}`, {
      status: 'paused',
      removeDevices: true,
    });
    await expectProblem(res, 422, 'SCANNING_SESSION_REMOVE_DEVICES');
  });
});

describe('a device without a name', () => {
  it('takes the next free number after its session name', async () => {
    const a = await made(
      await post({ orgId: orgId(), doors: [door(templateId, { name: 'Namer' })] }),
    );
    const id = a.sessions[0]?.id;
    const add = async () => {
      const res = await fixture.call('POST', `/scanning-sessions/${id}/devices`, {
        surface: 'phone',
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { name: string }).name;
    };
    expect(await add()).toBe('Namer 2');
    expect(await add()).toBe('Namer 3');
  });
});
