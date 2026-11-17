import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { createPassRow } from './create.ts';
import type { CreateParams } from './create-types.ts';
import { overrideDeps } from './deps.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';
import { setupTenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let release: TemplateRelease;
let app: ReturnType<typeof createApp>;
let key: Record<string, string>;

const admin = { type: 'user', id: 'admin-1' } as const;
const flag = (blueprint: 0 | 1) =>
  run(kit.env.DB, 'UPDATE templates SET blueprint = ? WHERE id = ?', [blueprint, kit.template.id]);
const params = (name: string): CreateParams => ({
  orgId: kit.org.id,
  templateId: kit.template.id,
  templateVersion: release.version,
  releaseId: release.id,
  releaseGeneration: release.generation,
  input: { memberName: name },
  holderEmail: null,
  source: 'manual',
  mode: 'live',
  execution: { kind: 'system' },
  actor: { type: 'system', id: null },
});
const viaApi = (name: string) =>
  app.request(
    'https://wallet.test/api/v1/passes',
    {
      method: 'POST',
      headers: { ...key, 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: kit.template.id, input: { memberName: name } }),
    },
    kit.env,
  );
const passesNamed = (name: string) =>
  first<{ n: number }>(
    kit.env.DB,
    "SELECT COUNT(*) AS n FROM passes WHERE json_extract(personalization, '$.memberName') = ?",
    [name],
  ).then((r) => r?.n ?? 0);

/** Runs `action` right before the batch that inserts the pass: after every read the create makes. */
function beforePassInsert(db: D1Database, action: () => Promise<unknown>): D1Database {
  const text = new WeakMap<D1PreparedStatement, string>();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          text.set(statement, sql);
          return wrap(statement, sql);
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((s) => /INSERT INTO passes\b/i.test(text.get(s) ?? '')))
            await action();
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // Bound statements are new objects: keep their text too.
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind')
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            text.set(bound, sql);
            return bound;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

beforeAll(async () => {
  kit = await setupKit();
  const live = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  if (!live) throw new Error('The default Live release is missing');
  release = live;
  const auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read', 'passes:write'] });
});

describe('issuing from a blueprint', () => {
  it('is refused on every issue path with TEMPLATE_IS_BLUEPRINT', async () => {
    await flag(1);
    try {
      const error = await createPassRow(jobCtxOf(kit), params('Refused')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        code: 'TEMPLATE_IS_BLUEPRINT',
        status: 409,
        message: 'Passes come from templates. Use this blueprint to make one first.',
      });
      const api = await viaApi('Refused');
      expect(api.status).toBe(409);
      expect(await api.json()).toMatchObject({ code: 'TEMPLATE_IS_BLUEPRINT' });
      expect(await passesNamed('Refused')).toBe(0);
    } finally {
      await flag(0);
    }
    // Positive control: the same paths issue from a template.
    expect((await createPassRow(jobCtxOf(kit), params('Issued'))).templateId).toBe(kit.template.id);
    expect((await viaApi('Issued')).status).toBe(201);
    expect(await passesNamed('Issued')).toBe(2);
  });

  it('fences the flag in the create grant when it changes during the create', async () => {
    const racingCtx = (action: () => Promise<unknown>) => {
      const env = { ...kit.env, DB: beforePassInsert(kit.env.DB, action) };
      overrideDeps(env, { registry: kit.registry, apns: kit.apns, mailer: kit.mailer });
      return { ...jobCtxOf(kit), env };
    };
    let fired = 0;
    const racing = racingCtx(() => {
      fired++;
      return flag(1);
    });
    try {
      // Every read before the commit saw a template; only the grant can refuse it now.
      await expect(createPassRow(racing, params('Raced'))).rejects.toMatchObject({
        code: 'TEMPLATE_IS_BLUEPRINT',
      });
      expect(fired).toBeGreaterThanOrEqual(1);
      expect(await passesNamed('Raced')).toBe(0);
    } finally {
      await flag(0);
    }
    const control = racingCtx(() => flag(0));
    expect((await createPassRow(control, params('Raced'))).templateId).toBe(kit.template.id);
  });

  it('keeps passes already on a blueprint updating', async () => {
    const pass = await kit.pass({ memberName: 'Before' });
    await flag(1);
    try {
      await updatePass(
        jobCtxOf(kit),
        admin,
        pass.id,
        { input: { memberName: 'After' } },
        { scope: null },
      );
      expect((await getPass(kit.env.DB, pass.id))?.personalization).toMatchObject({
        memberName: 'After',
      });
    } finally {
      await flag(0);
    }
  });
});
