import { beforeAll, describe, expect, it } from 'vitest';
import { ScanningSessionDetailSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const read = async (id: string) =>
  ScanningSessionDetailSchema.parse(
    await (await fixture.call('GET', `/scanning-sessions/${id}`)).json(),
  );

describe('session customer settings', () => {
  it('persist through create, other updates and their own update', async () => {
    const made = await fixture.call('POST', '/scanning-sessions', {
      orgId: fixture.kit.org.id,
      name: 'Front desk',
      timeZone: 'UTC',
      settings: { customer: { welcome: 'Tap to enter', greet: false } },
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    expect((await read(id)).settings.customer).toEqual({ welcome: 'Tap to enter', greet: false });

    // A settings change that does not name the customer lines keeps them.
    const flow = await fixture.call('PATCH', `/scanning-sessions/${id}`, {
      settings: { flow: 'choose' },
    });
    expect(flow.status).toBe(200);
    expect((await read(id)).settings).toMatchObject({
      flow: 'choose',
      customer: { welcome: 'Tap to enter', greet: false },
    });

    const lines = await fixture.call('PATCH', `/scanning-sessions/${id}`, {
      settings: { customer: { refusedLine: 'See the desk', showReady: false } },
    });
    expect(lines.status).toBe(200);
    expect((await read(id)).settings.customer).toEqual({
      refusedLine: 'See the desk',
      showReady: false,
    });
  });

  it('refuses an unknown customer key and leaves scanner settings without one', async () => {
    const bad = await fixture.call('POST', '/scanning-sessions', {
      orgId: fixture.kit.org.id,
      name: 'Bad',
      timeZone: 'UTC',
      settings: { customer: { welcome: 'x', secret: 1 } },
    });
    expect(bad.status).toBe(422);
  });
});
