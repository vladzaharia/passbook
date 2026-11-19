import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { deviceToken, linkToken, rememberAuthToken } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { clearSettingsCache } from '../settings/service.ts';

const ORIGIN = 'https://wallet.test';
const TYPE = 'pass.im.plrs.wallet';
const MAC = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' };

async function setup() {
  const kit = await ruleKit();
  const pass = await rememberAuthToken(kit.env, await kit.datedPass());
  /** Runs the queued jobs, as the queue consumer would. */
  const drain = async () => {
    for (const job of kit.queue.sent.splice(0)) await runJob(job as never, jobCtxOf(kit));
  };
  const put = async (channels: Record<string, string | null>, id = pass.id) => {
    kit.clock.advance(1000);
    const res = await kit.send('PUT', `/passes/${id}/channels`, { channels });
    await drain();
    return res;
  };
  const get = (path: string, headers: Record<string, string> = MAC) =>
    kit.app.request(`${ORIGIN}${path}`, { headers }, kit.env);
  const page = async () => `/p/${await linkToken(kit.env, pass)}`;
  const text = async (path: string) => (await get(path)).text();
  const setting = async (scope: string, key: string, value: unknown) => {
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      [scope, key, JSON.stringify(value), 'test', 1],
    );
    clearSettingsCache(kit.env.DB);
  };
  const copies = async () =>
    (
      await kit.env.DB.prepare('SELECT channel FROM pass_channel_copies WHERE pass_id = ?')
        .bind(pass.id)
        .all<{ channel: string }>()
    ).results
      .map((r) => r.channel)
      .sort();
  return { kit, pass, drain, put, get, page, text, setting, copies };
}

describe('channel gate on /p', () => {
  it('offers the barcode and the Apple badge by default', async () => {
    const { page, text, get } = await setup();
    const html = await text(await page());
    expect(html).toContain('/pass.pkpass"');
    expect(html).toContain(`${await page()}/barcode`);
    expect((await get(`${await page()}/pass.pkpass`)).status).toBe(200);
  });

  it('hides the badge and refuses the download while Apple is off for the pass', async () => {
    const { page, text, get, put } = await setup();
    expect((await put({ apple: 'off' })).status).toBe(200);
    const html = await text(await page());
    expect(html).not.toContain('/pass.pkpass"');
    expect(html).not.toContain('alt="Add to Apple Wallet"');
    expect(html).toContain(`${await page()}/barcode`);
    const res = await get(`${await page()}/pass.pkpass`);
    expect(res.status).toBe(404);
  });

  it('removes the barcode, its page and the presentation while mobile is off', async () => {
    const { page, text, get, put } = await setup();
    await put({ mobile: 'off' });
    const html = await text(await page());
    expect(html).not.toContain(`${await page()}/barcode`);
    expect((await get(`${await page()}/barcode`)).status).toBe(404);
  });

  it('says no ticket is available when nothing is on', async () => {
    const { page, text, put, kit } = await setup();
    await put({ apple: 'off', mobile: 'off' });
    const html = await text(await page());
    expect(html).toContain('No ticket available. Contact');
    expect(html).not.toContain('/pass.pkpass"');
    expect(html).not.toContain('/barcode');
    expect(kit.org.name).toBeTruthy();
  });

  it('honours the template never and an org block', async () => {
    const { kit, pass, page, text, get, setting } = await setup();
    const res = await kit.send('PUT', `/templates/${pass.templateId}/channels`, {
      orgId: kit.org.id,
      revision: 0,
      channels: { apple: 'never' },
    });
    expect(res.status).toBe(200);
    expect((await get(`${await page()}/pass.pkpass`)).status).toBe(404);
    // A pass override cannot beat never.
    await kit.send('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'on' } });
    expect((await get(`${await page()}/pass.pkpass`)).status).toBe(404);
    await kit.send('PUT', `/templates/${pass.templateId}/channels`, {
      orgId: kit.org.id,
      revision: 1,
      channels: { apple: 'on' },
    });
    expect((await get(`${await page()}/pass.pkpass`)).status).toBe(200);
    await setting(`org:${kit.org.id}`, 'channels.blocked', ['mobile']);
    expect((await get(`${await page()}/barcode`)).status).toBe(404);
    expect(await text(await page())).not.toContain(`${await page()}/barcode`);
  });

  it('records copy evidence once where a copy is delivered', async () => {
    const { page, get, copies, kit, pass } = await setup();
    expect(await copies()).toEqual([]);
    await get(`${await page()}/pass.pkpass`);
    await get(`${await page()}/barcode`);
    await kit.settle();
    expect(await copies()).toEqual(['apple', 'mobile']);
    const first1 = await first<{ copy_at: number }>(
      kit.env.DB,
      "SELECT copy_at FROM pass_channel_copies WHERE pass_id = ? AND channel = 'apple'",
      [pass.id],
    );
    await get(`${await page()}/pass.pkpass`);
    const again = await first<{ copy_at: number }>(
      kit.env.DB,
      "SELECT copy_at FROM pass_channel_copies WHERE pass_id = ? AND channel = 'apple'",
      [pass.id],
    );
    expect(again?.copy_at).toBe(first1?.copy_at);
  });
});

describe('pass DTO channels', () => {
  it('carries the effective state with source, reason, retirement and its cause', async () => {
    const { kit, pass, put } = await setup();
    await put({ apple: 'off' });
    const res = await kit.api(`/passes/${pass.id}`, { headers: kit.auth.admin() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: Record<
        string,
        { on: boolean; source: string; reason?: string; retiredAt?: number; retiredCause?: string }
      >;
    };
    expect(body.channels.apple).toMatchObject({
      on: false,
      source: 'pass',
      reason: 'pass_off',
      retiredCause: 'pass',
    });
    expect(body.channels.apple?.retiredAt).toBeTypeOf('number');
    expect(body.channels.mobile).toEqual({ on: true, source: 'template' });
  });
});

describe('Apple voided variant', () => {
  const fetchPass = (
    kit: Awaited<ReturnType<typeof setup>>['kit'],
    pass: { serial: string },
    auth: string,
  ) =>
    kit.app.request(
      `${ORIGIN}/wallet/v1/passes/${TYPE}/${pass.serial}`,
      { headers: { authorization: `ApplePass ${auth}` } },
      kit.env,
    );
  const passJsonOf = async (res: Response) => {
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return JSON.parse(new TextDecoder().decode(files['pass.json'])) as Record<string, unknown>;
  };

  it('serves a voided copy after the flip, caches it by version and restores the live pass', async () => {
    const { kit, pass, put } = await setup();
    const auth = deviceToken(pass);
    const reg = await kit.app.request(
      `${ORIGIN}/wallet/v1/devices/dev-1/registrations/${TYPE}/${pass.serial}`,
      {
        method: 'POST',
        headers: { authorization: `ApplePass ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({ pushToken: 'ab'.repeat(32) }),
      },
      kit.env,
    );
    expect(reg.status).toBe(201);
    const live = await passJsonOf(await fetchPass(kit, pass, auth));
    expect(live.voided).toBeUndefined();

    expect((await put({ apple: 'off' })).status).toBe(200);
    const flipped = await getPass(kit.env.DB, pass.id);
    // N4: the version bumps so passesUpdatedSince and Last-Modified move and the push goes out.
    expect(flipped?.version).toBe(pass.version + 1);
    const listed = await kit.app.request(
      `${ORIGIN}/wallet/v1/devices/dev-1/registrations/${TYPE}?passesUpdatedSince=${pass.revision}`,
      {},
      kit.env,
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { serialNumbers: string[] }).serialNumbers).toEqual([
      pass.serial,
    ]);

    const voided = await fetchPass(kit, pass, auth);
    expect(voided.status).toBe(200);
    const json = await passJsonOf(voided);
    expect(json.voided).toBe(true);
    expect(json.barcodes).toBeUndefined();
    expect(json.expirationDate).toBeTypeOf('string');
    expect(json.authenticationToken).toBe(auth);
    const key = `passes/${pass.id}/v${flipped?.version}-voided.pkpass`;
    const cached = await kit.env.BUCKET.head(key);
    expect(cached).not.toBeNull();
    await fetchPass(kit, pass, auth);
    expect((await kit.env.BUCKET.head(key))?.uploaded).toEqual(cached?.uploaded);

    expect((await put({ apple: null })).status).toBe(200);
    const restored = await getPass(kit.env.DB, pass.id);
    expect(restored?.version).toBe((flipped?.version ?? 0) + 1);
    const back = await passJsonOf(await fetchPass(kit, pass, auth));
    expect(back.voided).toBeUndefined();
  });

  it('keeps serving the live pass under an org block, which never retires copies', async () => {
    const { kit, pass, setting } = await setup();
    const auth = deviceToken(pass);
    await setting(`org:${kit.org.id}`, 'channels.blocked', ['apple']);
    const json = await passJsonOf(await fetchPass(kit, pass, auth));
    expect(json.voided).toBeUndefined();
  });

  it('keeps a retired copy voided when an org block lands on top and the pass is bumped again', async () => {
    const { kit, pass, put, setting } = await setup();
    const auth = deviceToken(pass);
    await put({ apple: 'off' });
    await setting(`org:${kit.org.id}`, 'channels.blocked', ['apple']);
    // Any later publish bumps the version; the device then fetches the copy.
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      force: true,
    });
    const json = await passJsonOf(await fetchPass(kit, pass, auth));
    expect(json.voided).toBe(true);
  });

  it('re-queues a lost bump on the next PUT and the job is idempotent', async () => {
    const { kit, pass, put, drain } = await setup();
    kit.clock.advance(1000);
    await kit.send('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } });
    kit.queue.sent.splice(0); // the message is lost
    const before = (await getPass(kit.env.DB, pass.id))?.version;
    await kit.send('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } });
    expect(kit.queue.sent).toHaveLength(1);
    await drain();
    const after = (await getPass(kit.env.DB, pass.id))?.version;
    expect(after).toBe((before ?? 0) + 1);
    await put({ apple: 'off' });
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(after);
  });

  it('refuses personalization while Apple is off', async () => {
    const { kit, pass, put } = await setup();
    await put({ apple: 'off' });
    const res = await kit.app.request(
      `${ORIGIN}/wallet/v1/passes/${TYPE}/${pass.serial}/personalize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizationToken: 'tok',
          requiredPersonalizationInfo: { fullName: 'A B' },
        }),
      },
      kit.env,
    );
    expect(res.status).toBe(404);
  });
});
