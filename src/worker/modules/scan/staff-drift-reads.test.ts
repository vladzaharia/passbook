import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { RACE_AUTHORIZED } from './repo-read-authority.ts';
import {
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  noLeak,
} from './repo-session-activity-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

/** A staff change in the middle of a device read asks for the PIN again (409 `SCAN_STAFF_CHANGED`). */
const staffChanges = {
  'staff disabled': 'disabled_at = 1',
  'staff role': "role = 'manager'",
} as const;
type StaffChange = keyof typeof staffChanges;

const changeStaff = (staffId: string, change: StaffChange) => async (db: D1Database) =>
  void (await run(
    db,
    `UPDATE scan_staff SET ${staffChanges[change]}, updated_at = updated_at + 1 WHERE id = ?`,
    [staffId],
  ));

async function staffed() {
  const f = await activityFixture({ role: 'door' });
  if (!f.staff) throw new Error('Expected a signed-in staff member.');
  return { ...f, staffId: f.staff.id };
}

describe('device activity read', () => {
  it('serves the signed-in staff member when nothing moved (positive control)', async () => {
    const f = await staffed();
    const response = await atActivityRead(f.kit.env, f.device, async () => {});
    expect(response.status).toBe(200);
  });

  it.each(Object.keys(staffChanges) as StaffChange[])(
    'answers 409 SCAN_STAFF_CHANGED for a %s at the final read',
    async (change) => {
      const f = await staffed();
      const response = await atActivityRead(f.kit.env, f.device, changeStaff(f.staffId, change));
      await noLeak(response, 409, 'SCAN_STAFF_CHANGED', f.pass.id, ACTIVITY_NAME);
    },
  );

  it('keeps 409 SCAN_CONFIG_CHANGED for a scanner configuration change', async () => {
    const f = await staffed();
    const response = await atActivityRead(f.kit.env, f.device, async (db) => {
      await run(
        db,
        "UPDATE scanners SET time_zone = 'Europe/Paris', updated_at = updated_at + 1 WHERE id = ?",
        [f.scanner.id],
      );
    });
    await noLeak(response, 409, 'SCAN_CONFIG_CHANGED', f.pass.id, ACTIVITY_NAME);
  });
});

/** Runs `change` right before the invalid-scope resolve's redacted-scope authority read. */
async function resolveDuring(
  f: Awaited<ReturnType<typeof staffed>>,
  change: (db: D1Database) => Promise<void>,
) {
  const real = f.kit.env.DB;
  let fired = false;
  const intercept = (bound: D1PreparedStatement) =>
    new Proxy(bound, {
      get(target, member) {
        if (member === 'first')
          return async () => {
            fired = true;
            await change(real);
            return target.first();
          };
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  f.kit.env.DB = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (fired || !sql.includes(RACE_AUTHORIZED)) return statement;
          return new Proxy(statement, {
            get(inner, member) {
              if (member === 'bind')
                return (...values: unknown[]) => intercept(inner.bind(...values));
              const value = Reflect.get(inner, member, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const response = await f.kit.post(f.scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: codeOf(f.pass),
      clientTs: f.kit.clock.now(),
    });
    expect(fired).toBe(true);
    const text = await response.text();
    expect(text).not.toContain(f.pass.id);
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    f.kit.env.DB = real;
  }
}

describe('invalid-scope resolve', () => {
  async function invalid() {
    const f = await staffed();
    await run(f.kit.env.DB, 'DELETE FROM scan_event_templates WHERE event_id = ?', [f.event.id]);
    return f;
  }

  it('answers the bare refusal while the staff member is current (positive control)', async () => {
    const f = await invalid();
    const { status, body } = await resolveDuring(f, async () => {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
  });

  it.each(Object.keys(staffChanges) as StaffChange[])(
    'answers 409 SCAN_STAFF_CHANGED for a %s before the answer',
    async (change) => {
      const f = await invalid();
      const { status, body } = await resolveDuring(f, changeStaff(f.staffId, change));
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
    },
  );
});
