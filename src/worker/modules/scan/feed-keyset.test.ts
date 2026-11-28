import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession, makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_HISTORY_PAGE, tagRe } from './race-tags.ts';
import {
  codeOf,
  DAY,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let admin: Record<string, string>;
let apiKey: Record<string, string>;

beforeEach(async () => {
  kit = await setupScanKit();
  const fake = fakeAuth(ORIGIN);
  fake.bindApiKeys(kit.env, kit.clock);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  admin = {
    ...(await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] })).headers,
    origin: ORIGIN,
  };
  apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
  app = createApp({
    stores: {
      ...fake.stores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const get = (path: string, headers = admin) =>
  Promise.resolve(app.request(`${ORIGIN}/api/v1/scans${path}`, { headers }, kit.env));
const exportPath = () =>
  `/export?orgId=${kit.org.id}&from=${kit.clock.now() - DAY}&to=${kit.clock.now() + DAY}`;

async function recorded(count = 1) {
  const templateId = await kit.scanTemplate('Keyset history', {
    actions: [{ id: 'check_in', label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await kit.scanPass(templateId, { memberName: 'Keyset private title' });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    kit.clock.advance(1000);
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('The signed scan must have an id.');
    ids.push(outcome.scanId);
  }
  return { scanner, pass, ids };
}

const TRIGGER = `CREATE TRIGGER credential_ref_keyset_no_update BEFORE UPDATE ON credential_ref_keyset
  BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`;

/** Replace the stored keyset commitment by `replacement`, as a deployment with other keys would see it. */
async function rekey(db: D1Database, replacement: string) {
  const original = await ensureCredentialRefKeyset(db, kit.env);
  await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
  await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [replacement]);
  return async () => {
    await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [original]);
    await run(db, TRIGGER);
  };
}

const OTHER = 'a'.repeat(64);

async function withOtherKeyset<T>(work: () => Promise<T>): Promise<T> {
  const restore = await rekey(kit.env.DB, OTHER);
  try {
    return await work();
  } finally {
    await restore();
  }
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
}

describe('scan history keyset', () => {
  it.each(['console', 'key'] as const)(
    'needs no keyset for an empty %s page, and a read never bootstraps one',
    async (surface) => {
      const db = kit.env.DB;
      await withoutTrigger(db, 'credential_ref_keyset_no_delete', async () => {
        await run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1');
      });
      const response =
        surface === 'console' ? await get(`?orgId=${kit.org.id}`) : await get('', apiKey);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], nextCursor: null });
      expect(
        await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
      ).toBeNull();
    },
  );

  it('keeps the staff-hidden API-key fast path independent of the keyset', async () => {
    await withOtherKeyset(async () => {
      const response = await get('?staffId=missing', apiKey);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], nextCursor: null });
    });
  });

  it.each(['console', 'key', 'detail'] as const)(
    "does not return signed %s history when the stored keyset is not this deployment's",
    async (surface) => {
      const { pass, ids } = await recorded();
      const path =
        surface === 'console' ? `?orgId=${kit.org.id}` : surface === 'key' ? '' : `/${ids[0]}`;
      const headers = surface === 'key' ? apiKey : admin;
      const baseline = await get(path, headers);
      expect(baseline.status).toBe(200);
      expect(await baseline.text()).toContain(pass.id);
      await withOtherKeyset(async () => expectUnavailable(await get(path, headers)));
    },
  );

  it('does not bootstrap a keyset when a page with a signed row finds none', async () => {
    const { ids } = await recorded();
    const db = kit.env.DB;
    await withoutTrigger(db, 'credential_ref_keyset_no_delete', async () => {
      await run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1');
    });
    await expectUnavailable(await get(`/${ids[0]}`));
    expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1')).toBeNull();
  });

  it.each(['console', 'key'] as const)(
    'fences a %s continuation and does not downgrade a stale keyset to minimal history',
    async (surface) => {
      await recorded(2);
      const headers = surface === 'key' ? apiKey : admin;
      const prefix = surface === 'key' ? '?limit=1' : `?orgId=${kit.org.id}&limit=1`;
      const page = await get(prefix, headers);
      expect(page.status).toBe(200);
      const { nextCursor } = (await page.json()) as { nextCursor: string | null };
      expect(nextCursor).toEqual(expect.any(String));
      await withOtherKeyset(async () =>
        expectUnavailable(
          await get(`${prefix}&cursor=${encodeURIComponent(nextCursor!)}`, headers),
        ),
      );
    },
  );

  it('fails an export stream instead of emitting a page whose keyset changed', async () => {
    const { pass } = await recorded();
    const db = kit.env.DB;
    let restore = async () => {};
    try {
      const { fired } = await beforeBatch(
        kit.env,
        tagRe(RACE_HISTORY_PAGE),
        async () => {
          restore = await rekey(db, OTHER);
        },
        async () => {
          const response = await get(exportPath());
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          const firstChunk = await reader.read();
          const header = new TextDecoder().decode(firstChunk.value);
          expect(header).not.toContain(pass.id);
          expect(header).not.toContain('Keyset private title');
          await expect(reader.read()).rejects.toMatchObject({
            code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
          });
        },
      );
      expect(fired).toBe(true);
    } finally {
      await restore();
    }
  });
});
