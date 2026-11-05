import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { bundleAssetPath, bundleImages } from './assets.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

type Headers = Record<string, string>;
const call = (method: string, path: string, headers: Headers, body: unknown = {}) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const makePass = (mode: 'live' | 'test' = 'live') =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    input: { memberName: 'Bundle Mode' },
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });
async function makeBundle(headers: Headers, mode: 'live' | 'test', holderEmail?: string) {
  const pass = await makePass(mode);
  const res = await call('POST', '/bundles', headers, {
    orgId: kit.org.id,
    name: 'Mode',
    passIds: [pass.id],
    ...(holderEmail ? { holderEmail } : {}),
  });
  expect(res.status).toBe(201);
  return BundleSchema.parse(await res.json());
}
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('bundle by-id changes respect mode', () => {
  it('a test key gets 404 for a live bundle: rotate, send, delete, get', async () => {
    const bundle = await makeBundle(fake.admin(), 'live', 'own@example.com');
    const key = fake.apiKey({ mode: 'test' });
    expect((await call('POST', `/bundles/${bundle.id}/rotate-link`, key)).status).toBe(404);
    expect((await call('POST', `/bundles/${bundle.id}/send-email`, key)).status).toBe(404);
    expect((await call('DELETE', `/bundles/${bundle.id}`, key)).status).toBe(404);
    expect((await call('GET', `/bundles/${bundle.id}`, key)).status).toBe(404);
    expect((await call('GET', `/bundles/${bundle.id}`, fake.admin())).status).toBe(200);
  });

  it('a Test-mode session gets 409 MODE_MISMATCH and may still read', async () => {
    const bundle = await makeBundle(fake.admin(), 'live', 'own@example.com');
    const session = fake.admin({ mode: 'test' });
    for (const [method, path] of [
      ['POST', `/bundles/${bundle.id}/rotate-link`],
      ['POST', `/bundles/${bundle.id}/send-email`],
      ['DELETE', `/bundles/${bundle.id}`],
    ] as const) {
      const res = await call(method, path, session);
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('MODE_MISMATCH');
    }
    expect((await call('GET', `/bundles/${bundle.id}`, session)).status).toBe(200);
  });

  it('writes each change and its audit row together', async () => {
    const bundle = await makeBundle(fake.admin(), 'live');
    await call('POST', `/bundles/${bundle.id}/rotate-link`, fake.admin());
    await call('DELETE', `/bundles/${bundle.id}`, fake.admin());
    const actions = await all<{ action: string }>(
      kit.env.DB,
      'SELECT action FROM audit_log WHERE target_id = ? ORDER BY id',
      [bundle.id],
    );
    expect(actions.map((a) => a.action)).toEqual([
      'bundle.create',
      'bundle.rotate_link',
      'bundle.delete',
    ]);
  });
});

describe('bundle email outcome', () => {
  const queued = async (bundleId: string) =>
    all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND json_extract(payload, '$.bundleId') = ?",
      [bundleId],
    );
  const eventKinds = async (passId: string) =>
    (
      await all<{ kind: string; data: string }>(
        kit.env.DB,
        "SELECT kind, data FROM pass_events WHERE pass_id = ? AND kind LIKE 'email.%' ORDER BY at, id",
        [passId],
      )
    ).map((e) => e.kind);

  it('records email.sent with the bundle and an outbox id', async () => {
    const pass = await makePass();
    const res = await call('POST', '/bundles', fake.admin(), {
      orgId: kit.org.id,
      name: 'Sent',
      passIds: [pass.id],
      holderEmail: 'sent-bundle@example.com',
      sendEmail: true,
    });
    const bundle = BundleSchema.parse(await res.json());
    const [row] = await queued(bundle.id);
    await handleEmailSend({ kind: 'email.send', outboxId: row?.id ?? '' }, kit.ctx);
    expect((await eventKinds(pass.id)).sort()).toEqual(['email.queued', 'email.sent']);
    const sent = await all<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'email.sent'",
      [pass.id],
    );
    expect(JSON.parse(sent[0]?.data ?? '{}')).toMatchObject({
      bundleId: bundle.id,
      outboxId: row?.id,
    });
  });

  it('records email.failed when the mailer throws', async () => {
    const pass = await makePass();
    const res = await call('POST', '/bundles', fake.admin(), {
      orgId: kit.org.id,
      name: 'Fails',
      passIds: [pass.id],
      holderEmail: 'fails-bundle@example.com',
      sendEmail: true,
    });
    const bundle = BundleSchema.parse(await res.json());
    const [row] = await queued(bundle.id);
    kit.mailer.fail = new Error('provider down');
    try {
      // A transient failure is retried: the job throws so the queue redelivers it.
      await expect(
        handleEmailSend({ kind: 'email.send', outboxId: row?.id ?? '' }, kit.ctx),
      ).rejects.toThrow();
    } finally {
      kit.mailer.fail = null;
    }
    expect((await eventKinds(pass.id)).sort()).toEqual(['email.failed', 'email.queued']);
  });

  it('a failed enqueue keeps the bundle and returns it (no duplicate on retry)', async () => {
    const pass = await makePass();
    await run(
      kit.env.DB,
      "CREATE TRIGGER outbox_block BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    try {
      const res = await call('POST', '/bundles', fake.admin(), {
        orgId: kit.org.id,
        name: 'Enqueue fails',
        passIds: [pass.id],
        holderEmail: 'enqueue-fails@example.com',
        sendEmail: true,
      });
      expect(res.status).toBe(201);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER outbox_block');
    }
    expect(
      await all(kit.env.DB, "SELECT id FROM bundles WHERE name = 'Enqueue fails'"),
    ).toHaveLength(1);
  });
});

describe('bundle asset paths fail closed', () => {
  it('rewrites a pass asset path and drops anything else', () => {
    expect(bundleAssetPath('/p/PT/assets/logo.png', 'PT', 'BT', 'pid')).toBe(
      '/b/BT/pid/assets/logo.png',
    );
    expect(bundleAssetPath('/p/OTHER/assets/logo.png', 'PT', 'BT', 'pid')).toBeNull();
    const kept = bundleImages(
      [
        { name: 'a', path: '/p/PT/assets/a.png' },
        { name: 'b', path: '/p/PT/other/b.png' },
      ] as never,
      'PT',
      'BT',
      'pid',
    );
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain('/p/PT');
  });
});
