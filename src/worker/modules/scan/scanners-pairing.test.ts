import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { createScannerStore } from './auth-store.ts';
import {
  auditActions,
  clock,
  consoleCall,
  cookieOf,
  create,
  device,
  env,
  orgId,
  pairCall,
  problem,
  send,
  setupScannerFixture,
} from './scanners-split-test-fixtures.ts';

setupScannerFixture();

describe('pairing', () => {
  it('pairs a browser end to end: preview, pair, cookie, session, poll', async () => {
    const { body } = await create({ name: 'Front door' });
    const code = body.pairing?.code ?? '';
    const preview = await pairCall('/preview', code);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
      scannerName: 'Front door',
      orgName: 'Test Org',
      mode: 'live',
    });
    expect(cookieOf(preview).token).toBe('');
    const poll = async () =>
      (await (await consoleCall('GET', `/${body.id}/pairing`)).json()) as {
        state: string;
        device: { label: string } | null;
      };
    expect((await poll()).state).toBe('waiting');
    // Typed with a space, in lower case and with Crockford's look-alikes.
    const typed = `${code.slice(0, 5).toLowerCase()} ${code.slice(5)}`;
    const paired = await pairCall('', typed);
    expect(paired.status).toBe(200);
    const { raw, token } = cookieOf(paired);
    expect(raw).toMatch(/Path=\/;/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Max-Age=15552000');
    expect(raw).toContain('__Host-wallet_scan=wls_');
    const session = (await paired.json()) as {
      principal: string;
      state: string;
      csrfToken: string;
      scanner: { id: string; mode: string; orgName: string };
    };
    expect(session).toMatchObject({
      principal: 'scanner',
      state: 'ready',
      scanner: { id: body.id, mode: 'live', orgName: 'Test Org' },
    });
    expect(session.csrfToken).toBeTruthy();
    const auth = await createScannerStore(env, clock).resolve(token, 'cookie');
    expect(auth).toMatchObject({
      scannerId: body.id,
      orgId,
      mode: 'live',
      csrfSecret: session.csrfToken,
    });
    const state = await poll();
    expect(state.state).toBe('paired');
    expect(state.device?.label).toBe('iPhone · Safari');
    const dto = (await (await consoleCall('GET', `/${body.id}`)).json()) as {
      status: string;
      pairedLabel: string;
    };
    expect(dto).toMatchObject({ status: 'paired', pairedLabel: 'iPhone · Safari' });
  });

  it('does not widen a stale session assignment in the initial paired session', async () => {
    const { body } = await create({ settings: { acceptAllTemplates: true } });
    await run(
      env.DB,
      `UPDATE scanning_sessions SET accepts=?,
        settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [JSON.stringify({ templateIds: [] }), body.id],
    );
    const paired = await pairCall('', body.pairing?.code ?? '');
    expect(paired.status).toBe(200);
    expect(await paired.json()).toMatchObject({
      state: 'unassigned',
      scanner: { id: body.id, settings: { acceptAllTemplates: false } },
      templates: [],
      workspace: null,
    });
    expect(cookieOf(paired).token).not.toBe('');
  });

  it('unknown, expired and used codes give byte-equal PAIRING_INVALID', async () => {
    const { body } = await create();
    const code = body.pairing?.code ?? '';
    await pairCall('', code);
    const used = await pairCall('', code);
    const expired = await create();
    clock.advance(10 * 60_000 + 1);
    const late = await pairCall('', expired.body.pairing?.code ?? '');
    const unknown = await pairCall('', 'ABCDEFGHJK');
    const junk = await pairCall('', 'UUUUUUUUUU');
    const preview = await pairCall('/preview', code);
    for (const res of [used, late, unknown, junk, preview]) expect(res.status).toBe(400);
    const expected = await problem(unknown);
    expect(expected.code).toBe('PAIRING_INVALID');
    for (const res of [used, late, junk, preview]) expect(await problem(res)).toEqual(expected);
  });

  it('two concurrent pairs give one winner and one audit row', async () => {
    const { body } = await create();
    const code = body.pairing?.code ?? '';
    const results = await Promise.all([
      pairCall('', code, device()),
      pairCall('', code, { ...device(), 'cf-connecting-ip': '198.51.100.7' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await auditActions()).filter((a) => a === 'scanner.pair')).toHaveLength(1);
  });

  it('a new code voids the old one', async () => {
    const { body } = await create();
    const old = body.pairing?.code ?? '';
    const fresh = (await (await consoleCall('POST', `/${body.id}/pairing`)).json()) as {
      code: string;
    };
    expect(fresh.code).not.toBe(old);
    expect((await pairCall('/preview', old)).status).toBe(400);
    expect((await pairCall('/preview', fresh.code)).status).toBe(200);
  });

  it('re-pairing replaces the old token at completion', async () => {
    const { body } = await create();
    const first1 = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const store = createScannerStore(env, clock);
    expect(await store.resolve(first1, 'cookie')).not.toBeNull();
    const fresh = (await (await consoleCall('POST', `/${body.id}/pairing`)).json()) as {
      code: string;
    };
    expect(await store.resolve(first1, 'cookie')).not.toBeNull();
    const second = cookieOf(await pairCall('', fresh.code)).token;
    expect(await store.resolve(first1, 'cookie')).toBeNull();
    expect((await store.resolve(second, 'cookie'))?.scannerId).toBe(body.id);
  });

  it('caps misses per IP: the 31st is a 429, even for a good code', async () => {
    const { body } = await create();
    const headers = device();
    for (let i = 0; i < 30; i++)
      expect((await pairCall('', 'ABCDEFGHJK', headers)).status).toBe(400);
    const capped = await pairCall('', body.pairing?.code ?? '', headers);
    expect(capped.status).toBe(429);
    expect(capped.headers.get('retry-after')).toBeTruthy();
    expect(
      (
        await pairCall('', body.pairing?.code ?? '', {
          ...headers,
          'cf-connecting-ip': '198.51.100.9',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a cross-site request', async () => {
    const { body } = await create();
    const res = await pairCall('', body.pairing?.code ?? '', {
      ...device(),
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
  });

  it('a suspended org cannot pair', async () => {
    const { body } = await create();
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
    expect((await pairCall('', body.pairing?.code ?? '')).status).toBe(400);
  });

  it('unpair always answers 204, clears the cookie, and the token with it', async () => {
    const { body } = await create();
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const res = await send('POST', '/api/v1/scan/unpair', {
      ...device(),
      cookie: `__Host-wallet_scan=${token}`,
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('__Host-wallet_scan=;');
    expect(await createScannerStore(env, clock).resolve(token, 'cookie')).toBeNull();
    const again = await send('POST', '/api/v1/scan/unpair', device());
    expect(again.status).toBe(204);
    expect(await auditActions()).toContain('scanner.unpair');
  });

  it('pair here sets the cookie on the admin browser', async () => {
    const { body } = await create();
    const res = await consoleCall('POST', `/${body.id}/pair-here`);
    expect(res.status).toBe(200);
    const { token } = cookieOf(res);
    expect((await createScannerStore(env, clock).resolve(token, 'cookie'))?.scannerId).toBe(
      body.id,
    );
    expect(((await res.json()) as { status: string }).status).toBe('paired');
  });
});
