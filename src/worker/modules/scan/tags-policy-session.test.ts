import { beforeAll, describe, expect, it } from 'vitest';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

type Tags = { types?: string[]; confirmBasic?: string; level?: string };
type Detail = { id: string; settings: { tags?: Tags }; devices: { settings: { tags?: Tags } }[] };
const body = async (res: Response) => (await res.json()) as Detail;

describe("a session's tag rules over the API", () => {
  it('keeps types, confirmBasic and level on the session and on every device', async () => {
    const { kit, call } = fixture;
    const rules = { level: 'basic', types: ['standard', kit.fx.ids.id()], confirmBasic: 'staff' };
    const made = await call('POST', '/scanning-sessions', {
      orgId: kit.org.id,
      name: 'Tag rules',
      timeZone: 'UTC',
      settings: { tags: rules },
    });
    expect(made.status).toBe(201);
    const session = await body(made);
    expect(session.settings.tags).toMatchObject(rules);
    const device = await call('POST', `/scanning-sessions/${session.id}/devices`, {
      name: 'Door',
      surface: 'phone',
    });
    expect(device.status).toBe(201);
    expect(
      ((await body(device)) as unknown as { settings: { tags?: Tags } }).settings.tags,
    ).toMatchObject(rules);
    const changed = await call('PATCH', `/scanning-sessions/${session.id}`, {
      settings: { tags: { types: [], confirmBasic: 'manager' } },
    });
    expect(changed.status).toBe(200);
    const detail = await body(changed);
    expect(detail.settings.tags).toMatchObject({ types: [], confirmBasic: 'manager' });
    expect(detail.devices[0]?.settings.tags).toMatchObject({ types: [], confirmBasic: 'manager' });
  });

  it('refuses a rule it cannot enforce', async () => {
    const { kit, call } = fixture;
    for (const tags of [
      { confirmBasic: 'owner' },
      { types: Array.from({ length: 13 }, () => kit.fx.ids.id()) },
      { level: 'strict' },
    ]) {
      const res = await call('POST', '/scanning-sessions', {
        orgId: kit.org.id,
        name: 'Bad rules',
        timeZone: 'UTC',
        settings: { tags },
      });
      expect(res.status, JSON.stringify(tags)).toBe(422);
    }
  });
});
