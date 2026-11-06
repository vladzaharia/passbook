import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { PassCheckInSchema } from '../../../shared/contracts/check-in.ts';
import { createApp } from '../../app.ts';
import { type ScanKit, setupScanKit } from '../scan/test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: ScanKit;
let app: ReturnType<typeof createApp>;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  app = createApp({ stores: fake.stores });
  template = await kit.scanTemplate('Dated check-in', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    window: { from: 'startsAt', until: 'endsAt' },
  });
});
const put = (id: string, rules: unknown, headers = fake.admin()) =>
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

  it('enforces role, organization and mode for policy writes', async () => {
    const pass = await dated();
    expect((await put(pass.id, { mode: 'single' }, fake.user())).status).toBe(403);
    expect(
      (await put(pass.id, {}, fake.apiKey({ orgId: 'another-org', scopes: ['passes:write'] })))
        .status,
    ).toBe(404);
    expect((await put(pass.id, {}, fake.admin({ mode: 'test' }))).status).toBe(409);
    expect((await put(pass.id, { eventId: 'missing-event' })).status).toBe(404);
  });
});
