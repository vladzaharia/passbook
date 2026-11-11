import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { BundleListSchema, BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP } from '../delivery/service.ts';
import { createPassRow } from '../passes/create.ts';
import { voidPass } from '../passes/service.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;
let other: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
  other = await makeOrg(kit.fx, { name: 'Other Org' });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const post = (path: string, headers: Headers, body: unknown = {}) =>
  api(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const create = (headers: Headers, body: Record<string, unknown>) =>
  post('/bundles', headers, { orgId: kit.org.id, name: 'Family', ...body });
const makePass = (orgId = kit.org.id, mode: 'live' | 'test' = 'live') =>
  createPassRow(kit.ctx, {
    orgId,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Bundle Test' },
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });
const bundleOf = async (res: Response) => BundleSchema.parse(await res.json());
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('POST /bundles', () => {
  it('creates a bundle in the caller mode with a /b link', async () => {
    const a = await makePass();
    const b = await makePass();
    const res = await create(fake.admin(), { passIds: [a.id, b.id] });
    expect(res.status).toBe(201);
    const bundle = await bundleOf(res);
    expect(bundle).toMatchObject({ orgId: kit.org.id, mode: 'live', name: 'Family' });
    expect(bundle.passes.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(bundle.url).toMatch(/^https:\/\/.+\/b\/[A-Za-z0-9_-]{43}$/);
  });

  it('holds at most 10 passes', async () => {
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await makePass()).id);
    expect((await create(fake.admin(), { passIds: ids })).status).toBe(422);
    expect((await create(fake.admin(), { passIds: ids.slice(0, 10) })).status).toBe(201);
  });

  it('refuses a duplicate pass and an empty list', async () => {
    const a = await makePass();
    const dup = await create(fake.admin(), { passIds: [a.id, a.id] });
    expect(dup.status).toBe(422);
    expect(await code(dup)).toBe('BUNDLE_DUPLICATE_PASS');
    expect((await create(fake.admin(), { passIds: [] })).status).toBe(422);
  });

  it('keeps to one org: a pass of another org is not found', async () => {
    const mine = await makePass();
    const theirs = await makePass(other.id);
    const res = await create(fake.admin(), { passIds: [mine.id, theirs.id] });
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('PASS_NOT_FOUND');
  });

  it('keeps to one mode: test passes need a test caller', async () => {
    const live = await makePass();
    const test = await makePass(kit.org.id, 'test');
    const mixed = await create(fake.admin(), { passIds: [live.id, test.id] });
    expect(mixed.status).toBe(422);
    expect(await code(mixed)).toBe('BUNDLE_MODE_MISMATCH');
    expect((await create(fake.admin(), { passIds: [test.id] })).status).toBe(422);
    const ok = await create(fake.admin({ mode: 'test' }), { passIds: [test.id] });
    expect((await bundleOf(ok)).mode).toBe('test');
  });

  it('an org-scoped API key cannot bundle for another org', async () => {
    const theirs = await makePass(other.id);
    const key = fake.apiKey({ orgId: kit.org.id });
    const res = await post('/bundles', key, { orgId: other.id, name: 'X', passIds: [theirs.id] });
    expect(res.status).toBe(403);
  });

  it('needs passes:write to create and passes:read to list', async () => {
    const a = await makePass();
    const readOnly = fake.apiKey({ scopes: ['passes:read'] });
    expect((await create(readOnly, { passIds: [a.id] })).status).toBe(403);
    expect((await api('/bundles', { headers: readOnly })).status).toBe(200);
    expect(
      (await api('/bundles', { headers: fake.apiKey({ scopes: ['templates:read'] }) })).status,
    ).toBe(403);
  });
});

describe('list and get', () => {
  it('filters by mode and org scope; get-by-id works in either mode', async () => {
    const org = await makeOrg(kit.fx, { name: 'List Org' });
    const live = await makePass(org.id);
    const test = await makePass(org.id, 'test');
    const l = await bundleOf(
      await post('/bundles', fake.admin(), { orgId: org.id, name: 'L', passIds: [live.id] }),
    );
    const t = await bundleOf(
      await post('/bundles', fake.admin({ mode: 'test' }), {
        orgId: org.id,
        name: 'T',
        passIds: [test.id],
      }),
    );
    const ids = async (headers: Headers, q = '') =>
      BundleListSchema.parse(
        await (await api(`/bundles?orgId=${org.id}${q}`, { headers })).json(),
      ).items.map((b) => b.id);
    expect(await ids(fake.admin())).toEqual([l.id]);
    expect(await ids(fake.admin({ mode: 'test' }))).toEqual([t.id]);
    expect(await ids(fake.apiKey({ mode: 'test' }))).toEqual([t.id]);
    expect(await ids(fake.admin(), `&passId=${live.id}`)).toEqual([l.id]);
    expect(await ids(fake.admin(), `&passId=${test.id}`)).toEqual([]);
    // Either mode by id, with its mode shown.
    const got = await bundleOf(await api(`/bundles/${t.id}`, { headers: fake.admin() }));
    expect(got.mode).toBe('test');
    // An org-scoped key sees only its own org, and another org's bundle is missing.
    const stranger = fake.apiKey({ orgId: kit.org.id });
    expect((await api(`/bundles/${l.id}`, { headers: stranger })).status).toBe(404);
    expect(
      BundleListSchema.parse(await (await api('/bundles', { headers: stranger })).json()).items.map(
        (b) => b.id,
      ),
    ).not.toContain(l.id);
  });
});

describe('rotate, delete and the public link', () => {
  const token = (url: string) => url.split('/b/')[1] ?? '';
  const pub = (path: string) => app.request(`${ORIGIN}${path}`, {}, kit.env);

  it('a rotated link returns 404 and the new one works', async () => {
    const a = await makePass();
    const bundle = await bundleOf(await create(fake.admin(), { passIds: [a.id] }));
    expect((await pub(`/b/${token(bundle.url)}`)).status).toBe(200);
    const rotated = await bundleOf(await post(`/bundles/${bundle.id}/rotate-link`, fake.admin()));
    expect(rotated.url).not.toBe(bundle.url);
    expect(rotated.linkRotatedAt).not.toBeNull();
    expect((await pub(`/b/${token(bundle.url)}`)).status).toBe(404);
    expect((await pub(`/b/${token(bundle.url)}/passes.pkpasses`)).status).toBe(404);
    expect((await pub(`/b/${token(rotated.url)}`)).status).toBe(200);
  });

  it('a deleted bundle returns 404 and keeps its passes', async () => {
    const a = await makePass();
    const bundle = await bundleOf(await create(fake.admin(), { passIds: [a.id] }));
    expect(
      (await api(`/bundles/${bundle.id}`, { method: 'DELETE', headers: fake.admin() })).status,
    ).toBe(200);
    expect((await pub(`/b/${token(bundle.url)}`)).status).toBe(404);
    expect((await api(`/bundles/${bundle.id}`, { headers: fake.admin() })).status).toBe(404);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [a.id])).not.toBeNull();
  });

  it("another org's key cannot rotate or delete", async () => {
    const a = await makePass();
    const bundle = await bundleOf(await create(fake.admin(), { passIds: [a.id] }));
    const stranger = fake.apiKey({ orgId: other.id });
    expect((await post(`/bundles/${bundle.id}/rotate-link`, stranger)).status).toBe(404);
    expect(
      (await api(`/bundles/${bundle.id}`, { method: 'DELETE', headers: stranger })).status,
    ).toBe(404);
    expect((await pub(`/b/${token(bundle.url)}`)).status).toBe(200);
  });

  it('deleting a pass leaves the bundle with the rest', async () => {
    const a = await makePass();
    const b = await makePass();
    const bundle = await bundleOf(await create(fake.admin(), { passIds: [a.id, b.id] }));
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [a.id]);
    const got = await bundleOf(await api(`/bundles/${bundle.id}`, { headers: fake.admin() }));
    expect(got.passes.map((p) => p.id)).toEqual([b.id]);
  });
});

describe('send-email', () => {
  it('queues through the outbox and sends the bundle email', async () => {
    const a = await makePass();
    const b = await makePass();
    const bundle = await bundleOf(
      await create(fake.admin(), { passIds: [a.id, b.id], holderEmail: 'Mia@Example.com' }),
    );
    expect(bundle.holderEmail).toBe('mia@example.com');
    const res = await post(`/bundles/${bundle.id}/send-email`, fake.admin());
    expect(res.status).toBe(202);
    const row = await first<{ id: string; payload: string }>(
      kit.env.DB,
      "SELECT id, payload FROM outbox WHERE kind = 'email' AND pass_id = ? ORDER BY created_at DESC",
      [a.id],
    );
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      to: 'mia@example.com',
      bundleId: bundle.id,
    });
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: row?.id ?? '' }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before + 1);
    const mail = kit.mailer.sent.at(-1);
    expect(mail?.to).toBe('mia@example.com');
    const token = bundle.url.split('/b/')[1];
    expect(mail?.html).toContain(`/b/${token}/passes.pkpasses`);
    expect(mail?.html).toContain(`/b/${token}/${a.id}/pass.pkpass`);
    expect(mail?.text).not.toContain('/p/');
    expect(mail?.html).not.toContain(a.downloadToken);
  });

  it('sendEmail on create queues the row; API keys cannot pick another recipient', async () => {
    const a = await makePass();
    const created = await bundleOf(
      await create(fake.admin(), {
        passIds: [a.id],
        holderEmail: 'kim@example.com',
        sendEmail: true,
      }),
    );
    const rows = await all(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [a.id],
    );
    expect(rows).toHaveLength(1);
    const key = fake.apiKey({ orgId: kit.org.id });
    const bad = await post(`/bundles/${created.id}/send-email`, key, { to: 'evil@example.com' });
    expect(await code(bad)).toBe('RECIPIENT_NOT_HOLDER');
    const noEmail = await bundleOf(await create(fake.admin(), { passIds: [a.id] }));
    expect(await code(await post(`/bundles/${noEmail.id}/send-email`, fake.admin()))).toBe(
      'NO_RECIPIENT',
    );
    expect(await code(await create(fake.admin(), { passIds: [a.id], sendEmail: true }))).toBe(
      'NO_RECIPIENT',
    );
  });

  it('a capped recipient still gets the bundle: 201, one bundle, no new email row', async () => {
    const a = await makePass();
    const body = { passIds: [a.id], name: 'Capped', holderEmail: 'capped@example.com' };
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++)
      expect((await create(fake.admin(), { ...body, sendEmail: true })).status).toBe(201);
    const before = await all(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [a.id],
    );
    const res = await create(fake.admin(), { ...body, name: 'Over cap', sendEmail: true });
    expect(res.status).toBe(201);
    const rows = await all(kit.env.DB, "SELECT id FROM bundles WHERE name = 'Over cap'");
    expect(rows).toHaveLength(1);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [a.id]),
    ).toHaveLength(before.length);
  });

  it("another org's key cannot send the bundle email", async () => {
    const a = await makePass();
    const bundle = await bundleOf(
      await create(fake.admin(), { passIds: [a.id], holderEmail: 'own@example.com' }),
    );
    const res = await post(`/bundles/${bundle.id}/send-email`, fake.apiKey({ orgId: other.id }));
    expect(res.status).toBe(404);
  });

  it('the email still sends when the first pass was deleted; a removed pass reads voided', async () => {
    const a = await makePass();
    const b = await makePass();
    const bundle = await bundleOf(
      await create(fake.admin(), {
        passIds: [a.id, b.id],
        holderEmail: 'first-gone@example.com',
        sendEmail: true,
      }),
    );
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [a.id],
    );
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [Date.now(), a.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [Date.now(), b.id]);
    const got = await bundleOf(await api(`/bundles/${bundle.id}`, { headers: fake.admin() }));
    expect(got.passes).toEqual([expect.objectContaining({ id: b.id, status: 'voided' })]);
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: row?.id ?? '' }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(kit.mailer.sent.at(-1)?.to).toBe('first-gone@example.com');
  });

  it('a test-mode bundle never sends: captured, sent/TEST_MODE, email.captured', async () => {
    const t = await makePass(kit.org.id, 'test');
    const bundle = await bundleOf(
      await create(fake.admin({ mode: 'test' }), {
        passIds: [t.id],
        holderEmail: 'test-bundle@example.com',
        sendEmail: true,
      }),
    );
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [t.id],
    );
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: row?.id ?? '' }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before);
    expect(
      await first(kit.env.DB, 'SELECT state, error_code FROM outbox WHERE id = ?', [row?.id]),
    ).toEqual({
      state: 'sent',
      error_code: 'TEST_MODE',
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT recipient, bundle_id, pass_id FROM captured_emails WHERE outbox_id = ?',
        [row?.id],
      ),
    ).toEqual({ recipient: 'test-bundle@example.com', bundle_id: bundle.id, pass_id: null });
    const events = await all<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'email.captured'",
      [t.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.data).not.toContain('example.com');
    const queued = await first<{ mode: string; data: string }>(
      kit.env.DB,
      "SELECT mode, data FROM pass_events WHERE pass_id = ? AND kind = 'email.queued'",
      [t.id],
    );
    expect(queued?.mode).toBe('test');
    expect(JSON.parse(queued?.data ?? '{}')).toEqual({ outboxId: row?.id, bundleId: bundle.id });
    expect(bundle.mode).toBe('test');
  });
});

describe('voided passes', () => {
  it('shows a voided pass but leaves it out of the add-all archive', async () => {
    const a = await makePass();
    const b = await makePass();
    const bundle = await bundleOf(await create(fake.admin(), { passIds: [a.id, b.id] }));
    await voidPass(kit.ctx, { type: 'user', id: 'admin-1' }, a.id, null);
    const token = bundle.url.split('/b/')[1];
    const html = await (await app.request(`${ORIGIN}/b/${token}`, {}, kit.env)).text();
    expect(html).toContain(`/b/${token}/${b.id}/pass.pkpass`);
    expect(html).not.toContain(`/b/${token}/${a.id}/pass.pkpass`);
    const zip = await app.request(`${ORIGIN}/b/${token}/passes.pkpasses`, {}, kit.env);
    expect(zip.status).toBe(200);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain(`${b.id}.pkpass`);
    expect(text).not.toContain(`${a.id}.pkpass`);
    expect(
      (await app.request(`${ORIGIN}/b/${token}/${a.id}/pass.pkpass`, {}, kit.env)).status,
    ).toBe(404);
  });
});
