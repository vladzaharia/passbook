import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  CHECK_IN,
  kit,
  request,
  sessionWithDevice,
  setupScanningAuthorityFixture,
} from './scanning-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupScanningAuthorityFixture);

/** Runs `change` right before the resolve's redacted-scope authority read. */
function beforeAuthorityRead(change: () => Promise<unknown>) {
  const real = kit.env.DB;
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (fired || !sql.startsWith('SELECT (') || !sql.endsWith(') AS current'))
            return statement;
          return new Proxy(statement, {
            get(inner, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  return new Proxy(bound, {
                    get(b, m) {
                      if (m === 'first')
                        return async () => {
                          fired = true;
                          await change();
                          return b.first();
                        };
                      const value = Reflect.get(b, m, b);
                      return typeof value === 'function' ? value.bind(b) : value;
                    },
                  });
                };
              const value = Reflect.get(inner, member, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  return { fired: () => fired, restore: () => Object.assign(kit.env, { DB: real }) };
}

async function invalidScope() {
  const templateId = await kit.scanTemplate(`Emptied ${kit.fx.ids.token(4)}`, {
    actions: [CHECK_IN],
  });
  const pass = await kit.scanPass(templateId);
  const event = await kit.event({ templateIds: [templateId] });
  const { device, headers } = await sessionWithDevice({ eventId: event.id });
  await run(kit.env.DB, 'DELETE FROM scan_event_templates WHERE event_id=?', [event.id]);
  return { pass, scannerId: device.id, headers };
}

async function resolveDuring(
  f: Awaited<ReturnType<typeof invalidScope>>,
  change: () => Promise<unknown>,
) {
  const hook = beforeAuthorityRead(change);
  try {
    const response = await request(
      'POST',
      '/scan/resolve',
      { idempotencyKey: key(), input: codeOf(f.pass), clientTs: kit.clock.now() },
      f.headers,
    );
    expect(hook.fired()).toBe(true);
    const text = await response.text();
    expect(text).not.toContain(f.pass.id);
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    hook.restore();
  }
}

describe('resolve with an invalid scope', () => {
  it('answers the bare not_accepted refusal while the actor is current', async () => {
    const f = await invalidScope();
    const { status, body } = await resolveDuring(f, async () => {});
    expect(status).toBe(200);
    expect(body).toMatchObject({
      kind: 'refused',
      reason: 'not_accepted',
      card: null,
      display: null,
      template: null,
    });
  });

  it('unpairs a scanner revoked before the answer', async () => {
    const f = await invalidScope();
    const { status, body } = await resolveDuring(f, () =>
      run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        f.scannerId,
      ]),
    );
    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'SCANNER_REPAIR' });
  });

  it('refuses a configuration change before the answer', async () => {
    const f = await invalidScope();
    const { status, body } = await resolveDuring(f, () =>
      run(kit.env.DB, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [f.scannerId]),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
  });
});
