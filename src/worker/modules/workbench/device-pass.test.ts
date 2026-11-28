import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { DevicePassResponseSchema } from '../../../shared/contracts/device-passes.ts';
import { all, first } from '../../platform/db.ts';
import { bearer } from '../developer/try-token-test-fixtures.ts';
import { type DevicePassKit, devicePassKit } from './device-pass-test-fixtures.ts';

let t: DevicePassKit;
beforeAll(async () => {
  t = await devicePassKit();
});
afterAll(() => t.unstub());

const make = async (headers: Record<string, string>, passId: string) => {
  const res = await t.api('POST', '/developer/device-passes', headers, { passId });
  expect(res.status, await res.clone().text()).toBe(201);
  return DevicePassResponseSchema.parse(await res.json()).devicePass;
};

describe('L10: device pass guards', () => {
  it('makes a pending pass with a one-time code (201), and audits it without the code', async () => {
    const d = await t.developer();
    const dp = await make(d.browser, d.passId);
    expect(dp).toMatchObject({
      passId: d.passId,
      state: 'pending',
      deviceCount: 0,
      voidReason: null,
    });
    expect(dp.code?.url).toMatch(/\/d\/[A-Za-z0-9_-]{40,}$/);
    expect(dp.expiresAt - dp.createdAt).toBe(24 * 3_600_000);
    expect((dp.code?.expiresAt ?? 0) - dp.createdAt).toBe(10 * 60_000);
    const audit = await all<{ action: string; detail: string | null }>(
      t.kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action LIKE 'device_pass.%'",
      [dp.id],
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      'device_pass.code_issued',
      'device_pass.created',
    ]);
    expect(JSON.stringify(audit)).not.toContain(dp.code?.url.split('/d/')[1] ?? 'x');
  });

  it('refuses a pass outside the caller own sandbox with 409 DEVICE_PASS_NOT_SANDBOX', async () => {
    const d = await t.developer();
    const other = await t.developer();
    const org = await makeOrg(t.kit.f);
    const { resolved, registry } = makeTemplate({ id: `tpl-${org.id}`, orgId: org.id });
    const live = await makePass(t.kit.f, {
      orgId: org.id,
      template: resolved,
      registry,
      mode: 'test',
    });
    for (const passId of [live.id, other.passId, 'missing']) {
      const res = await t.api('POST', '/developer/device-passes', d.browser, { passId });
      await expectProblem(res, 409, 'DEVICE_PASS_NOT_SANDBOX');
    }
  });

  it('refuses a non-developer with 403, and a key or a try token', async () => {
    const d = await t.developer();
    const person = await t.outsider();
    await expectProblem(
      await t.api('POST', '/developer/device-passes', person.headers, { passId: d.passId }),
      403,
      'DEVELOPER_ACCESS_REQUIRED',
    );
    const key = await t.api('POST', '/developer/device-passes', bearer(d.key.secret), {
      passId: d.passId,
    });
    expect(key.status).toBeGreaterThanOrEqual(401);
    const { token } = await t.mint(d.browser);
    const tried = await t.api(
      'POST',
      '/developer/device-passes',
      { ...d.browser, ...bearer(token) },
      {
        passId: d.passId,
      },
    );
    expect(tried.status).toBeGreaterThanOrEqual(401);
    expect(
      await all(t.kit.env.DB, 'SELECT 1 FROM device_passes WHERE pass_id = ?', [d.passId]),
    ).toEqual([]);
  });

  it('holds 5 open passes per sandbox: the sixth is 409 DEVICE_PASS_LIMIT, and a void frees a place', async () => {
    const d = await t.developer();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await make(d.browser, await d.make()));
    await expectProblem(
      await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId }),
      409,
      'DEVICE_PASS_LIMIT',
    );
    const listed = await (await t.api('GET', '/developer/device-passes', d.browser)).json();
    expect(listed).toMatchObject({ active: 5, limit: 5 });
    const voided = await t.api('DELETE', `/developer/device-passes/${made[0]?.id}`, d.browser);
    expect(voided.status).toBe(200);
    expect(((await voided.json()) as { devicePass: { state: string } }).devicePass.state).toBe(
      'voided',
    );
    await make(d.browser, d.passId);
  });

  it('needs a step-up within 10 minutes for make, code and Add again, not for read or void', async () => {
    const d = await t.developer();
    const dp = await make(d.browser, d.passId);
    t.kit.clock.advance(700_000);
    for (const [method, path, body] of [
      ['POST', '/developer/device-passes', { passId: d.passId }],
      ['POST', `/developer/device-passes/${dp.id}/code`, undefined],
      ['POST', `/developer/device-passes/${dp.id}/again`, undefined],
    ] as const)
      await expectProblem(await t.api(method, path, d.browser, body), 403, 'STEP_UP_REQUIRED');
    expect((await t.api('GET', '/developer/device-passes', d.browser)).status).toBe(200);
    expect((await t.api('DELETE', `/developer/device-passes/${dp.id}`, d.browser)).status).toBe(
      200,
    );
  });

  it('needs an Idempotency-Key, and a replay answers the first pass', async () => {
    const d = await t.developer();
    await expectProblem(
      await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId }, null),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    const a = await t.api(
      'POST',
      '/developer/device-passes',
      d.browser,
      { passId: d.passId },
      'same',
    );
    const b = await t.api(
      'POST',
      '/developer/device-passes',
      d.browser,
      { passId: d.passId },
      'same',
    );
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(((await b.json()) as { devicePass: { id: string } }).devicePass.id).toBe(
      ((await a.json()) as { devicePass: { id: string } }).devicePass.id,
    );
  });

  it('makes at most 10 an hour', async () => {
    const d = await t.developer();
    for (let i = 0; i < 10; i++) {
      const dp = await make(d.browser, d.passId);
      await t.api('DELETE', `/developer/device-passes/${dp.id}`, d.browser);
    }
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    await expectProblem(res, 429, 'DEVICE_PASS_RATE_LIMITED');
    expect(res.headers.get('retry-after')).toBe('3600');
  });

  it('refuses a voided source pass', async () => {
    const d = await t.developer();
    const res = await t.api('POST', `/passes/${d.passId}/void`, d.headers, {});
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    await expectProblem(
      await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId }),
      409,
      'DEVICE_PASS_SOURCE_VOIDED',
    );
  });
});

describe('the flag and the identity', () => {
  it('with the flag off, every route is 404 and nothing is written', async () => {
    const d = await t.developer();
    t.flag(false);
    for (const [method, path] of [
      ['POST', '/developer/device-passes'],
      ['GET', '/developer/device-passes'],
      ['POST', '/developer/device-passes/x/code'],
      ['POST', '/developer/device-passes/x/again'],
      ['DELETE', '/developer/device-passes/x'],
    ] as const) {
      const body = method === 'POST' ? { passId: d.passId } : undefined;
      const res = await t.api(method, path, d.browser, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await t.raw(`/d/${'a'.repeat(43)}`)).status).toBe(404);
    expect(
      await first(t.kit.env.DB, 'SELECT 1 AS n FROM device_passes WHERE pass_id = ?', [d.passId]),
    ).toBeNull();
    // Anyone who is not a signed-in developer meets the guards as on any route: the flag is not readable.
    expect((await t.api('GET', '/developer/device-passes', {})).status).toBe(401);
    expect(
      (await t.api('GET', '/developer/device-passes', bearer(d.key.secret))).status,
    ).toBeGreaterThanOrEqual(401);
    t.flag(true);
  });

  it('without the device-test identity it is 503 and never signs as the platform identity', async () => {
    const d = await t.developer();
    await t.identityIssuing(false);
    await expectProblem(
      await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId }),
      503,
      'DEVICE_PASS_IDENTITY_NOT_READY',
    );
    expect(
      await first(t.kit.env.DB, 'SELECT 1 AS n FROM device_passes WHERE pass_id = ?', [d.passId]),
    ).toBeNull();
    await t.identityIssuing(true);
  });
});
