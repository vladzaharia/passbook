import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { PassCheckInSchema } from '../../../shared/contracts/check-in.ts';
import { createApp } from '../../app.ts';
import { type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: ScanKit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  template = await kit.scanTemplate('Dated check-in', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    window: { from: 'startsAt', until: 'endsAt' },
  });
});
const put = (id: string, rules: unknown, headers = auth.admin()) =>
  app.request(
    `${ORIGIN}/api/v1/passes/${id}/check-in`,
    {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ rules }),
    },
    kit.env,
  );
async function dated() {
  const from = kit.clock.now();
  return kit.scanPass(template, {
    startsAt: new Date(from).toISOString(),
    endsAt: new Date(from + 3_600_000).toISOString(),
  });
}

describe('pass check-in configuration', () => {
  it('validates inherited windows before saving and permits explicitly clearing an end', async () => {
    const pass = await dated();
    const invalid = await put(pass.id, { validFrom: kit.clock.now() + 7_200_000 });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: 'SCAN_WINDOW_INVALID' });
    const response = await put(pass.id, { mode: 'in_out', validUntil: null });
    expect(response.status).toBe(200);
    const settings = PassCheckInSchema.parse(await response.json());
    expect(settings.effective).toMatchObject({
      mode: 'in_out',
      validFrom: kit.clock.now(),
      validUntil: null,
    });
  });

  it('enforces membership, organization and mode for policy writes', async () => {
    const pass = await dated();
    await expectProblem(await put(pass.id, { mode: 'single' }, auth.user()), 403, 'FORBIDDEN');
    const other = await makeOrg(kit.fx);
    const key = await auth.apiKey({ orgId: other.id, scopes: ['passes:write'] });
    await expectProblem(await put(pass.id, {}, key), 404, 'PASS_NOT_FOUND');
    await expectProblem(await put(pass.id, {}, auth.admin({ mode: 'test' })), 409, 'MODE_MISMATCH');
    await expectProblem(
      await put(pass.id, { eventId: 'missing-event' }),
      404,
      'SCAN_EVENT_NOT_FOUND',
    );
  });
});
