import { expect, it, vi } from 'vitest';
import { fakeAuth, makeSession, makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from './auth-store.ts';
import { afterBatch } from './batch-interceptor-test-support.ts';
import { RACE_HISTORY_PAGE, tagRe } from './race-tags.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  setupScanKit,
  startScanCredentialTransfer,
} from './test-kit.ts';

async function scenario(count: number) {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Cursor race', {
    actions: [{ id: 'check_in', label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await kit.scanPass(templateId, { memberName: 'Original credential holder' });
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
  const fake = fakeAuth(ORIGIN);
  fake.bindApiKeys(kit.env, kit.clock);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  const admin = { ...session.headers, origin: ORIGIN };
  const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
  const app = createApp({
    stores: {
      ...fake.stores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  const get = (path: string, headers: Record<string, string> = admin) =>
    Promise.resolve(app.request(`${ORIGIN}/api/v1/scans${path}`, { headers }, kit.env));
  return { kit, pass, ids, admin, apiKey, get };
}

type Page = { items: { id: string; passId: string | null }[]; nextCursor: string | null };

/*
 * A page is one snapshot: its rows, their pass state and their disclosure policy were read in one
 * statement. A change that lands while the cursor is encrypted is not in the snapshot, so this
 * page answers as it read, and the next one (a new statement) sees the change.
 */
it.each(['console', 'key'] as const)(
  'answers a %s page from its snapshot when a credential transfer races cursor encryption',
  async (surface) => {
    const s = await scenario(2);
    const path = surface === 'console' ? `?orgId=${s.kit.org.id}&limit=1` : '?limit=1';
    const headers = surface === 'console' ? s.admin : s.apiKey;
    const baseline = await s.get(path, headers);
    expect(baseline.status).toBe(200);
    expect(await baseline.json()).toMatchObject({ items: [{ id: s.ids[1], passId: s.pass.id }] });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let transferred = false;
    const spy = vi
      .spyOn(crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        const result = await encrypt(algorithm, key, data);
        if (!transferred) {
          transferred = true;
          expect(await startScanCredentialTransfer(s.kit, s.pass.id)).toMatchObject({
            state: 'completed',
          });
        }
        return result;
      });
    try {
      const response = await s.get(path, headers);
      expect(response.status).toBe(200);
      const page = (await response.json()) as Page;
      expect(transferred).toBe(true);
      expect(page.items).toMatchObject([{ id: s.ids[1], passId: s.pass.id }]);
      expect(page.nextCursor).toEqual(expect.any(String));
      const next = await s.get(`${path}&cursor=${encodeURIComponent(page.nextCursor!)}`, headers);
      expect(next.status).toBe(200);
      const rest = (await next.json()) as Page;
      expect(rest).toMatchObject({ items: [{ id: s.ids[0], passId: null }], nextCursor: null });
      expect(JSON.stringify(rest)).not.toContain(s.pass.id);
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(['console', 'key'] as const)(
  'serves the %s page it pinned the keyset for, and fails the next page when the keyset changes during cursor encryption',
  async (surface) => {
    const s = await scenario(2);
    const path = surface === 'console' ? `?orgId=${s.kit.org.id}&limit=1` : '?limit=1';
    const headers = surface === 'console' ? s.admin : s.apiKey;
    const db = s.kit.env.DB;
    const original = await first<{ commitment: string }>(
      db,
      'SELECT commitment FROM credential_ref_keyset WHERE id=1',
    );
    if (!original) throw new Error('The keyset must already be initialized.');
    const replacement = original.commitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let changed = false;
    await withoutTrigger(db, 'credential_ref_keyset_no_update', async () => {
      const spy = vi
        .spyOn(crypto.subtle, 'encrypt')
        .mockImplementation(async (algorithm, key, data) => {
          const result = await encrypt(algorithm, key, data);
          if (!changed) {
            changed = true;
            await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id=1', [
              replacement,
            ]);
          }
          return result;
        });
      try {
        const response = await s.get(path, headers);
        expect(changed).toBe(true);
        expect(response.status).toBe(200);
        const page = (await response.json()) as Page;
        expect(page.items).toMatchObject([{ id: s.ids[1], passId: s.pass.id }]);
        const next = await s.get(`${path}&cursor=${encodeURIComponent(page.nextCursor!)}`, headers);
        expect(next.status).toBe(503);
        const body = await next.text();
        expect(JSON.parse(body)).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
        expect(body).not.toContain(s.pass.id);
      } finally {
        spy.mockRestore();
        await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id=1', [
          original.commitment,
        ]);
      }
    });
  },
);

it.each(['console', 'key'] as const)(
  'continues a %s page from its snapshot position when its hidden boundary is quarantined after it',
  async (surface) => {
    const s = await scenario(1);
    await run(
      s.kit.env.DB,
      `WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50
    ) INSERT INTO scans
      (id, org_id, mode, pass_id, template_id, scanner_id, actor_type, actor_id, actor_key,
       idempotency_key, request_hash, method, state, outcome, reason, at)
      SELECT printf('boundary-%s-%03d', ?, n), s.org_id, s.mode, s.pass_id, s.template_id,
        s.scanner_id, s.actor_type, s.actor_id, s.actor_key, printf('boundary:%s:%03d', ?, n),
        'seeded', 'manual', 'done', 'refused', 'not_found', s.at - n
      FROM scans s CROSS JOIN seq WHERE s.id = ?`,
      [surface, surface, s.ids[0]!],
    );
    const path =
      surface === 'console'
        ? `?orgId=${s.kit.org.id}&limit=1&passId=missing-pass`
        : '?limit=1&passId=missing-pass';
    const headers = surface === 'console' ? s.admin : s.apiKey;
    const baseline = await s.get(path, headers);
    expect(baseline.status).toBe(200);
    const page = (await baseline.json()) as Page;
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let quarantined = false;
    const spy = vi
      .spyOn(crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        const result = await encrypt(algorithm, key, data);
        if (!quarantined) {
          quarantined = true;
          await run(s.kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
            s.pass.id,
          ]);
        }
        return result;
      });
    try {
      const response = await s.get(path, headers);
      expect(quarantined).toBe(true);
      expect(response.status).toBe(200);
      const raced = (await response.json()) as Page;
      expect(raced.items).toEqual([]);
      expect(raced.nextCursor).toEqual(expect.any(String));
      // The position is a row of the snapshot; the next page applies the quarantine.
      const next = await s.get(`${path}&cursor=${encodeURIComponent(raced.nextCursor!)}`, headers);
      expect(next.status).toBe(200);
      expect(JSON.stringify(await next.json())).not.toContain(s.pass.id);
    } finally {
      spy.mockRestore();
    }
  },
);

it('does not initialize a missing keyset on the staff-hidden key feed', async () => {
  const s = await scenario(1);
  const db = s.kit.env.DB;
  await withoutTrigger(db, 'credential_ref_keyset_no_delete', () =>
    run(db, 'DELETE FROM credential_ref_keyset WHERE id=1'),
  );
  const response = await s.get('?staffId=missing', s.apiKey);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], nextCursor: null });
  expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id=1')).toBeNull();
});

it('answers a detail from its snapshot when a credential transfer follows the read', async () => {
  const s = await scenario(1);
  const path = `/${s.ids[0]}`;
  const baseline = await s.get(path);
  expect(baseline.status).toBe(200);
  expect(await baseline.json()).toMatchObject({ id: s.ids[0], passId: s.pass.id });
  const db = s.kit.env.DB;
  const { result: response, fired } = await afterBatch(
    s.kit.env,
    tagRe(RACE_HISTORY_PAGE),
    async () => {
      expect(await startScanCredentialTransfer(s.kit, s.pass.id, { db })).toMatchObject({
        state: 'completed',
      });
    },
    () => s.get(path),
  );
  expect(fired).toBe(true);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: s.ids[0], passId: s.pass.id });
  const next = await s.get(path);
  expect(next.status).toBe(200);
  const body = await next.text();
  expect(JSON.parse(body)).toMatchObject({ id: s.ids[0], passId: null, actionId: null });
  expect(body).not.toContain(s.pass.id);
});
