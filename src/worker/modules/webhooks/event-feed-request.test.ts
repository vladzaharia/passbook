import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { EventDeliveriesSchema } from '../../../shared/contracts/workbench-read.ts';
import { workbenchKit } from '../workbench/workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => t.unstub());

describe('GET /events?requestId= and /events/{id}/deliveries', () => {
  it('filters the feed to one call, and lists where an event went', async () => {
    const s = await t.sandbox();
    const { endpointId } = await t.eventsFor(s, ['ray-a-SEA', 'ray-b-SEA']);

    const all = (await t.call('GET', '/events', s.key))[1];
    const some = (await t.call('GET', '/events?requestId=ray-a-SEA', s.key))[1];
    expect(some.items.length).toBeGreaterThan(0);
    expect(some.items.length).toBeLessThan(all.items.length);
    expect(some.items.every((e: { requestId?: string }) => e.requestId === 'ray-a-SEA')).toBe(true);
    expect((await t.call('GET', '/events?requestId=nope', s.key))[1].items).toEqual([]);

    const event = some.items[0];
    const [status, body] = await t.call('GET', `/events/${event.id}/deliveries`, s.key);
    expect(status).toBe(200);
    const parsed = EventDeliveriesSchema.parse(body);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      endpointId,
      target: 'capture',
      eventId: event.id,
      state: 'delivered',
    });
  });

  it('answers not found for an event of another sandbox', async () => {
    const a = await t.sandbox();
    const b = await t.sandbox();
    const { endpointId: _ } = await t.eventsFor(a, ['ray-c-SEA']);
    const event = (await t.call('GET', '/events', a.key))[1].items[0];
    await expectProblem(
      await t.app.request(
        `https://wallet.test/api/v1/events/${event.id}/deliveries`,
        { headers: b.key },
        t.kit.env,
      ),
      404,
      'EVENT_NOT_FOUND',
    );
  });
});
