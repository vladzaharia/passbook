import { beforeAll, describe, expect, it } from 'vitest';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const post = (id: string) =>
  fixture.call('POST', `/templates/${id}/scan-setup`, {
    orgId: fixture.kit.org.id,
    timeZone: 'UTC',
  });

/** The wire answer clients already parse: its keys and value types are frozen, whatever builds it. */
describe('template scan setup wire answer', () => {
  it('keeps its golden shape, new session and repeat', async () => {
    const id = await eventTemplate(fixture.kit, 'Golden ticket');
    const now = fixture.kit.clock.now();
    await fixture.kit.scanPass(id, {
      eventName: 'Golden night',
      startsAt: iso(now - HOUR / 6),
      endsAt: iso(now + HOUR),
    });
    const first = await post(id);
    expect(first.status).toBe(200);
    const made = (await first.json()) as { session: { id: string } };
    expect(made).toEqual({
      session: { id: expect.any(String), name: 'Golden ticket' },
      created: true,
      events: [{ id: expect.any(String), name: 'Golden night', created: true }],
      noEvents: false,
      truncated: false,
    });
    expect(Object.keys(made).sort()).toEqual([
      'created',
      'events',
      'noEvents',
      'session',
      'truncated',
    ]);
    const again = await post(id);
    expect(await again.json()).toEqual({
      session: { id: made.session.id, name: 'Golden ticket' },
      created: false,
      events: [],
      noEvents: false,
      truncated: false,
    });
  });
});
