// An API key may mail a bundle only to the holder of every member pass, never to an address it names.
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { seedBundlePrincipal } from './test-auth-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores, clock: kit.clock });
});

type Headers = Record<string, string>;
const post = async (path: string, headers: Headers, body: unknown = {}) => {
  await seedBundlePrincipal(kit, fake, headers);
  return app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
};
const create = (headers: Headers, name: string, body: Record<string, unknown>) =>
  post('/bundles', headers, { orgId: kit.org.id, name, ...body });
const code = async (res: Response) => ((await res.json()) as { code: string }).code;
const bundles = (name: string) => all(kit.env.DB, 'SELECT id FROM bundles WHERE name = ?', [name]);
const mails = (passId: string) =>
  all<{ payload: string }>(
    kit.env.DB,
    "SELECT payload FROM outbox WHERE kind = 'email' AND pass_id = ?",
    [passId],
  );
const tag = () => Math.random().toString(36).slice(2, 8);

describe('bundle email from an API key', () => {
  it('create with sendEmail to another address is refused before anything is written', async () => {
    const holder = `holder-${tag()}@example.test`;
    const [a, b] = await Promise.all([
      kit.pass({ holderEmail: holder }),
      kit.pass({ holderEmail: holder }),
    ]);
    const name = `Relay ${tag()}`;
    const res = await create(fake.apiKey({ orgId: kit.org.id }), name, {
      passIds: [a.id, b.id],
      holderEmail: 'evil@example.test',
      sendEmail: true,
    });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('RECIPIENT_NOT_HOLDER');
    expect(await bundles(name)).toHaveLength(0);
    expect(await mails(a.id)).toHaveLength(0);
  });

  it('refuses when one member has another holder or none', async () => {
    const holder = `holder-${tag()}@example.test`;
    const [mine, theirs, none] = await Promise.all([
      kit.pass({ holderEmail: holder }),
      kit.pass({ holderEmail: `other-${tag()}@example.test` }),
      kit.pass(),
    ]);
    for (const other of [theirs, none]) {
      const res = await create(fake.apiKey({ orgId: kit.org.id }), `Mixed ${tag()}`, {
        passIds: [mine.id, other.id],
        holderEmail: holder,
        sendEmail: true,
      });
      expect(await code(res)).toBe('RECIPIENT_NOT_HOLDER');
    }
    expect(await mails(mine.id)).toHaveLength(0);
  });

  it('create with sendEmail to the holder of every member queues it', async () => {
    const holder = `holder-${tag()}@example.test`;
    const [a, b] = await Promise.all([
      kit.pass({ holderEmail: holder }),
      kit.pass({ holderEmail: holder }),
    ]);
    const res = await create(fake.apiKey({ orgId: kit.org.id }), `Own ${tag()}`, {
      passIds: [a.id, b.id],
      holderEmail: holder,
      sendEmail: true,
    });
    expect(res.status).toBe(201);
    const rows = await mails(a.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ to: holder });
  });

  it('a bundle created without sending cannot be sent to a non-holder later', async () => {
    const a = await kit.pass({ holderEmail: `holder-${tag()}@example.test` });
    const key = fake.apiKey({ orgId: kit.org.id });
    const created = BundleSchema.parse(
      await (
        await create(key, `Later ${tag()}`, { passIds: [a.id], holderEmail: 'evil@example.test' })
      ).json(),
    );
    const res = await post(`/bundles/${created.id}/send-email`, key);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('RECIPIENT_NOT_HOLDER');
    expect(await mails(a.id)).toHaveLength(0);
  });
});

describe('bundle email from an admin session', () => {
  it('still sends to the address the admin names', async () => {
    const a = await kit.pass({ holderEmail: `holder-${tag()}@example.test` });
    const res = await create(fake.admin(), `Admin ${tag()}`, {
      passIds: [a.id],
      holderEmail: 'parent@example.test',
      sendEmail: true,
    });
    expect(res.status).toBe(201);
    expect(await mails(a.id)).toHaveLength(1);
  });
});
