import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeUser } from '../../../../test/helpers/index.ts';
import { PassDetailSchema, PassListSchema } from '../../../shared/contracts/passes.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { batch, run, stmt } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import { rotateLink } from './pass-service-delivery.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { removePass, restorePass } from './remove.ts';
import { getPass } from './repo-read-pass.ts';
import { voidPass } from './service.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const actor = { type: 'system', id: null } as const;
let kit: Kit;
let auth: TenantTestAuth;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
}, 60_000);

const request = async (path: string, headers = auth.admin()) =>
  app.request(`${ORIGIN}/api/v1${path}`, { headers }, kit.env);

/** START's actual D1 ordering and triggers, without completing retirement. */
async function reserve(db: D1Database, passId: string, advance = true): Promise<string> {
  const token = kit.fx.ids.token();
  await batch(db, [
    stmt(
      db,
      `INSERT INTO pass_credential_transfers
      (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
       source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
       requested_by_type, requested_by_id, requested_at)
      SELECT ?, id, org_id, mode, 'pending', credential_generation, version, revision, row_version,
        lifecycle_generation, link_generation + 1, 'target@example.test', NULL, 'system', NULL, ?
      FROM passes WHERE id = ?`,
      [kit.fx.ids.id(), kit.clock.now(), passId],
    ),
    ...(advance
      ? [
          stmt(
            db,
            `UPDATE passes SET credential_generation = credential_generation + 1,
      link_generation = link_generation + 1, download_token = ? WHERE id = ?`,
            [token, passId],
          ),
        ]
      : []),
  ]);
  return token;
}

async function recordReissue(passId: string, userId: string): Promise<void> {
  await run(
    kit.env.DB,
    `INSERT INTO pass_holder_reissue_required
    (pass_id, org_id, mode, user_id, credential_generation, version, revision,
     lifecycle_generation, link_generation, release_id, detected_at)
    SELECT id, org_id, mode, ?, credential_generation, version, revision,
      lifecycle_generation, link_generation, release_id, ? FROM passes WHERE id = ?`,
    [userId, kit.clock.now(), passId],
  );
}

/** Pause a real D1 statement, commit a competing change, then execute the original statement. */
async function withRace<T>(
  matches: (sql: string) => boolean,
  occurrence: number,
  change: (real: D1Database) => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let seen = 0;
  let intervened = false;
  const before = async (sql: string) => {
    if (intervened || !matches(sql)) return;
    if (++seen !== occurrence) return;
    intervened = true;
    await change(real);
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'first')
          return async (column?: string) => {
            await before(sql);
            return column === undefined ? target.first() : target.first(column);
          };
        if (prop === 'all')
          return async () => {
            await before(sql);
            return target.all();
          };
        if (prop === 'run')
          return async () => {
            await before(sql);
            return target.run();
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, statement);
    return wrapped;
  };
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return (items: D1PreparedStatement[]) =>
          target.batch(items.map((item) => statements.get(item) ?? item));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    return await operation();
  } finally {
    Object.assign(kit.env, { DB: real });
    expect(intervened, 'the competing D1 change ran at the intended statement').toBe(true);
  }
}

const detailFence = (sql: string) => sql.includes('AS reissue_required');
const listRead = (sql: string) =>
  /AS org_slug FROM passes\s+WHERE/i.test(sql) && /ORDER BY id DESC LIMIT/i.test(sql);

function noDisclosure(text: string, secrets: string[]) {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe('pass detail transfer disclosure fences', () => {
  it('returns current detail, but pending detail, history, and lists expose no holder data or bearer token', async () => {
    const pass = await kit.pass({
      memberName: 'Private current holder',
      holderEmail: 'private-old@example.test',
    });
    const good = await request(`/passes/${pass.id}`);
    expect(good.status).toBe(200);
    const detail = PassDetailSchema.parse(await good.json());
    expect(detail.publicUrl).toContain(pass.downloadToken);
    expect(detail.reissueRequired).toBe(false);
    const other = await kit.pass({ memberName: 'Other current pass' });
    const reserved = await reserve(kit.env.DB, pass.id);
    const secrets = [
      pass.downloadToken,
      reserved,
      pass.serial,
      'Private current holder',
      'private-old@example.test',
    ];
    for (const path of [
      `/passes/${pass.id}`,
      `/passes/${pass.id}/versions/${pass.version}`,
      `/passes/${pass.id}/diff?from=${pass.version}&to=${pass.version}`,
    ]) {
      const response = await request(path);
      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain('PASS_TRANSFER_PENDING');
      noDisclosure(body, secrets);
    }
    const unauthorized = await request(`/passes/${pass.id}`, auth.user());
    expect(unauthorized.status).toBe(403);
    noDisclosure(await unauthorized.text(), [...secrets, 'PASS_TRANSFER_PENDING']);
    const listed = await request(`/passes?orgId=${encodeURIComponent(pass.orgId)}&limit=200`);
    expect(listed.status).toBe(200);
    const body = await listed.text();
    const list = PassListSchema.parse(JSON.parse(body));
    expect(list.items.some((item) => item.id === pass.id)).toBe(false);
    expect(list.items.some((item) => item.id === other.id)).toBe(true);
    noDisclosure(body, secrets);
  }, 60_000);

  it('drops an in-flight detail when START commits just before its final SQL fence', async () => {
    const pass = await kit.pass({ memberName: 'Private raced holder' });
    let token = '';
    const response = await withRace(
      detailFence,
      2,
      async (db) => {
        token = await reserve(db, pass.id);
      },
      () => request(`/passes/${pass.id}`),
    );
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain('PASS_TRANSFER_PENDING');
    noDisclosure(body, [pass.downloadToken, token, pass.serial, 'Private raced holder']);
  }, 60_000);

  it('does not reveal even pending status if tenant authority is revoked at the final fence', async () => {
    const pass = await kit.pass({ memberName: 'Revoked tenant private' });
    const key = await makeApiKey(kit.fx, { orgId: pass.orgId, scopes: ['passes:read'] });
    const response = await withRace(
      detailFence,
      2,
      async (db) => {
        await reserve(db, pass.id);
        await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [kit.clock.now(), key.id]);
      },
      () => request(`/passes/${pass.id}`, key.headers),
    );
    expect(response.status).toBe(403);
    noDisclosure(await response.text(), [
      'PASS_TRANSFER_PENDING',
      pass.downloadToken,
      pass.serial,
      'Revoked tenant private',
    ]);
  }, 60_000);

  it('drops an in-flight detail after a complete transfer even when no pending row remains', async () => {
    const pass = await kit.pass({ memberName: 'Previous incarnation' });
    const response = await withRace(
      detailFence,
      2,
      async () => {
        const result = await reassignHolder(
          jobCtxOf(kit),
          actor,
          { passId: pass.id, email: 'new-holder@example.test' },
          null,
        );
        expect(result.transfer?.state).toBe('completed');
      },
      () => request(`/passes/${pass.id}`),
    );
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain('PASS_CONFLICT');
    noDisclosure(body, [
      pass.downloadToken,
      pass.serial,
      'Previous incarnation',
      'new-holder@example.test',
    ]);
  }, 60_000);

  it('drops an in-flight detail when its lifecycle incarnation changes', async () => {
    const pass = await kit.pass({ memberName: 'Lifecycle race private' });
    const response = await withRace(
      detailFence,
      2,
      async (db) => {
        await run(
          db,
          'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
          [pass.id],
        );
      },
      () => request(`/passes/${pass.id}`),
    );
    expect(response.status).toBe(409);
    noDisclosure(await response.text(), [
      pass.downloadToken,
      pass.serial,
      'Lifecycle race private',
    ]);
  }, 60_000);

  it('does not return a link rotated after the initial detail snapshot', async () => {
    const pass = await kit.pass({ memberName: 'Rotated link private' });
    const response = await withRace(
      detailFence,
      2,
      async (db) => {
        await run(
          db,
          `UPDATE passes SET download_token = ?, link_generation = link_generation + 1
        WHERE id = ?`,
          [kit.fx.ids.token(), pass.id],
        );
      },
      () => request(`/passes/${pass.id}`),
    );
    expect(response.status).toBe(409);
    noDisclosure(await response.text(), [pass.downloadToken, pass.serial, 'Rotated link private']);
  }, 60_000);

  it('excludes a pass whose transfer starts immediately before the list query', async () => {
    const pass = await kit.pass({ memberName: 'Raced list private' });
    let token = '';
    const response = await withRace(
      listRead,
      1,
      async (db) => {
        token = await reserve(db, pass.id);
      },
      () => request(`/passes?orgId=${encodeURIComponent(pass.orgId)}&limit=200`),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(PassListSchema.parse(JSON.parse(body)).items.some((item) => item.id === pass.id)).toBe(
      false,
    );
    noDisclosure(body, [pass.downloadToken, token, pass.serial, 'Raced list private']);
  }, 60_000);

  it('reports reissue only while the exact waiting pass and uniquely verified user remain eligible', async () => {
    const email = `reissue-${kit.fx.ids.id()}@example.test`;
    const pass = await kit.pass({ holderEmail: email });
    const user = await makeUser(kit.fx, { primaryEmail: email });
    await recordReissue(pass.id, user.id);
    expect(
      PassDetailSchema.parse(await (await request(`/passes/${pass.id}`)).json()).reissueRequired,
    ).toBe(true);
    const unauthorized = await request(`/passes/${pass.id}`, auth.user());
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.text()).not.toContain('reissueRequired');
    const raced = await withRace(
      detailFence,
      2,
      async (db) => {
        await run(db, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [user.id, email]);
      },
      () => request(`/passes/${pass.id}`),
    );
    expect(raced.status).toBe(200);
    expect(PassDetailSchema.parse(await raced.json()).reissueRequired).toBe(false);
  }, 60_000);

  it.each(['voided', 'removed'] as const)(
    'reports reissue for a still-eligible %s waiting pass',
    async (state) => {
      const email = `reissue-${kit.fx.ids.id()}@example.test`;
      const pass = await kit.pass({ holderEmail: email });
      const user = await makeUser(kit.fx, { primaryEmail: email });
      if (state === 'voided') await voidPass(jobCtxOf(kit), actor, pass.id, null);
      else await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
      await recordReissue(pass.id, user.id);
      const response = await request(`/passes/${pass.id}`);
      expect(response.status).toBe(200);
      expect(PassDetailSchema.parse(await response.json()).reissueRequired).toBe(true);
    },
    60_000,
  );

  it.each(['void', 'remove', 'restore', 'rotate'] as const)(
    'does not return the %s response after a transfer starts before disclosure',
    async (action) => {
      const pass = await kit.pass({ memberName: `Private ${action}` });
      const result = withRace(
        detailFence,
        1,
        async (db) => {
          await reserve(db, pass.id);
        },
        async () => {
          if (action === 'void') return voidPass(jobCtxOf(kit), actor, pass.id, null);
          if (action === 'remove') return removePass(jobCtxOf(kit), actor, pass.id, {}, null);
          if (action === 'restore') return restorePass(jobCtxOf(kit), actor, pass.id, null);
          return rotateLink(kit.ctx, actor, pass.id, null);
        },
      );
      await expect(result).rejects.toMatchObject({ code: 'PASS_TRANSFER_PENDING' });
    },
    60_000,
  );

  it('does not rotate or disclose a link after START wins the rotation CAS', async () => {
    const pass = await kit.pass();
    let token = '';
    await expect(
      withRace(
        (sql) => /UPDATE passes SET download_token = \?/i.test(sql),
        1,
        async (db) => {
          token = await reserve(db, pass.id);
        },
        () => rotateLink(kit.ctx, actor, pass.id, null),
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect((await getPass(kit.env.DB, pass.id))?.downloadToken).toBe(token);
  }, 60_000);

  it('does not rotate a system link for a pending reservation at the same generation', async () => {
    const pass = await kit.pass();
    await expect(
      withRace(
        (sql) => /UPDATE passes SET download_token = \?/i.test(sql),
        1,
        async (db) => {
          await reserve(db, pass.id, false);
        },
        () => rotateLink(kit.ctx, actor, pass.id, null),
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      downloadToken: pass.downloadToken,
      credentialGeneration: pass.credentialGeneration,
    });
  }, 60_000);

  it('does not rotate a system link after a remove-and-restore lifecycle ABA', async () => {
    const pass = await kit.pass();
    await expect(
      withRace(
        (sql) => /UPDATE passes SET download_token = \?/i.test(sql),
        1,
        async () => {
          await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
          await restorePass(jobCtxOf(kit), actor, pass.id, null);
        },
        () => rotateLink(kit.ctx, actor, pass.id, null),
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    const current = await getPass(kit.env.DB, pass.id);
    expect(current?.removedAt).toBeNull();
    expect(current?.downloadToken).toBe(pass.downloadToken);
    expect(current?.lifecycleGeneration).toBeGreaterThan(pass.lifecycleGeneration);
  }, 60_000);
});
