import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { startOidcAs } from './helpers/auth.ts';
import { seedDeviceTest } from './helpers/platform-root.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/**
 * S4, the device pass, on the real stack with the flag on (the e2e server turns DEVICE_PASS_ENABLED on and this
 * spec seeds the device-test identity the owner provisions for real). A developer makes a device pass of a Test
 * pass, opens its one-time code, adds it to a "phone" through Wallet's web service, changes the pass, voids it and
 * adds it again. The flag-off behaviour is pinned by the Worker tests (`modules/workbench/device-pass*.test.ts`).
 */
const PASS_TYPE = 'pass.mobile.passbook.devtest';
const decoder = new TextDecoder();

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** A call from the signed-in page: its cookie, a CSRF token without a bearer, a new Idempotency-Key, and an optional Workbench token beside the cookie. */
async function call<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  bearer?: string,
): Promise<Reply<T>> {
  return page.evaluate(
    async ({ method, path, body, bearer }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      else {
        const me = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
        headers['x-csrf-token'] = me.csrfToken;
      }
      headers['idempotency-key'] = crypto.randomUUID();
      const res = await fetch(`/api/v1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    { method, path, body, bearer },
  ) as Promise<Reply<T>>;
}

async function sandbox(page: Page): Promise<string> {
  await stubTurnstile(page);
  await startOidcAs(page, 'developer', '/workbench/quickstart');
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  const switcher = page.getByRole('button', { name: /Sandbox · Test\s*, Switch context$/ });
  await expect(create.or(switcher).first()).toBeVisible();
  if (await create.isVisible()) await create.click();
  await expect(switcher).toBeVisible({ timeout: 90_000 });
  return sandboxOrgId(page);
}

const pkpass = async (request: APIRequestContext, path: string) => {
  const res = await request.get(path);
  return { res, files: res.status() === 200 ? unzipSync(new Uint8Array(await res.body())) : {} };
};
const passJsonOf = (files: Record<string, Uint8Array>) =>
  JSON.parse(decoder.decode(files['pass.json'])) as Record<string, unknown> & {
    authenticationToken: string;
    serialNumber: string;
  };
const wallet = (
  request: APIRequestContext,
  method: 'POST' | 'DELETE',
  device: string,
  serial: string,
  token: string,
) =>
  request.fetch(`/wallet/v1/devices/${device}/registrations/${PASS_TYPE}/${serial}`, {
    method,
    headers: { authorization: `ApplePass ${token}`, 'content-type': 'application/json' },
    data: method === 'POST' ? { pushToken: 'ab'.repeat(16) } : undefined,
  });

test('Device pass: make, open once, add to a phone, update, void, add again', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await seedDeviceTest();
  const org = await sandbox(page);

  // A Test pass of the sandbox, made on the Workbench token (the sandbox's own key).
  const minted = await call<{ token: string }>(page, 'POST', '/workbench/token', { orgId: org });
  expect(minted.status).toBe(201);
  const token = minted.body.token;
  const templates = await call<{ items: { id: string }[] }>(
    page,
    'GET',
    '/templates',
    undefined,
    token,
  );
  expect(templates.status, JSON.stringify(templates.body)).toBe(200);
  const templateId = templates.body.items[0]?.id ?? '';
  const detail = await call<{ manifest: { sample?: Record<string, unknown> } }>(
    page,
    'GET',
    `/templates/${templateId}`,
    undefined,
    token,
  );
  const sample = detail.body.manifest.sample ?? {};
  const made = await call<{ id: string }>(
    page,
    'POST',
    '/passes',
    { templateId, input: sample },
    token,
  );
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const passId = made.body.id;

  // Make: pending, with a one-time code and a 24-hour life.
  const created = await call<{
    devicePass: {
      id: string;
      state: string;
      code: { url: string };
      expiresAt: number;
      createdAt: number;
    };
  }>(page, 'POST', '/developer/device-passes', { passId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const dp = created.body.devicePass;
  expect(dp.state).toBe('pending');
  expect(dp.expiresAt - dp.createdAt).toBe(24 * 3_600_000);
  const codePath = new URL(dp.code.url).pathname;
  expect(codePath).toMatch(/^\/d\/[\w-]{40,}$/);

  // A pass of a Live org or another developer's sandbox is refused: the call is the same 409 for both.
  const refused = await call(page, 'POST', '/developer/device-passes', { passId: 'not-a-pass' });
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: 'DEVICE_PASS_NOT_SANDBOX' });

  // Open: the signed pass, once. It is PassBook Test, unshareable, and nothing on it is tappable.
  const opened = await pkpass(request, codePath);
  expect(opened.res.status()).toBe(200);
  expect(opened.res.headers()['content-type']).toBe('application/vnd.apple.pkpass');
  expect(opened.res.headers()['cache-control']).toBe('no-store');
  expect(Object.keys(opened.files)).toEqual(
    expect.arrayContaining(['pass.json', 'manifest.json', 'signature']),
  );
  const json = passJsonOf(opened.files);
  expect(json).toMatchObject({
    passTypeIdentifier: PASS_TYPE,
    organizationName: 'PassBook Test',
    sharingProhibited: true,
    serialNumber: `dp_${dp.id}`,
  });
  expect(json).not.toHaveProperty('nfc');
  expect(json).not.toHaveProperty('appLaunchURL');
  expect((await request.get(codePath)).status()).toBe(410);

  // Add to a phone: Wallet registers it, and the source pass's stream shows the install.
  const serial = json.serialNumber;
  expect(
    (await wallet(request, 'POST', 'e2e-phone-1', serial, json.authenticationToken)).status(),
  ).toBe(201);
  expect((await wallet(request, 'POST', 'e2e-phone-1', serial, 'wrong-token')).status()).toBe(401);
  await expect
    .poll(
      async () => {
        const feed = await call<{ items: { type: string; data: { devicePass?: boolean } }[] }>(
          page,
          'GET',
          `/events?passId=${passId}`,
          undefined,
          token,
        );
        return feed.body.items.some(
          (e) => e.type === 'pass.installed' && e.data.devicePass === true,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // The pass changes: the phone's tag moves, and the push (unavailable here, so it fails) reaches the stream.
  const before = await request.get(`/wallet/v1/devices/e2e-phone-1/registrations/${PASS_TYPE}`);
  const tag = ((await before.json()) as { lastUpdated: string }).lastUpdated;
  const key = Object.keys(sample).find((k) => typeof sample[k] === 'string') ?? '';
  await new Promise((r) => setTimeout(r, 1100));
  const patched = await call(
    page,
    'PATCH',
    `/passes/${passId}`,
    { input: { ...sample, [key]: 'Updated' } },
    token,
  );
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `/wallet/v1/devices/e2e-phone-1/registrations/${PASS_TYPE}?passesUpdatedSince=${tag}`,
        );
        return res.status();
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  const rebuilt = await request.get(`/wallet/v1/passes/${PASS_TYPE}/${serial}`, {
    headers: { authorization: `ApplePass ${json.authenticationToken}` },
  });
  expect(rebuilt.status()).toBe(200);
  expect(decoder.decode(unzipSync(new Uint8Array(await rebuilt.body()))['pass.json'])).toContain(
    'Updated',
  );
  await expect
    .poll(
      async () => {
        const feed = await call<{ items: { type: string; data: { devicePass?: boolean } }[] }>(
          page,
          'GET',
          `/events?passId=${passId}`,
          undefined,
          token,
        );
        return feed.body.items.some((e) => e.type === 'push.failed' && e.data.devicePass === true);
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // Void: the phone is told, and the pass it fetches next is the voided copy.
  const voided = await call<{ devicePass: { state: string } }>(
    page,
    'DELETE',
    `/developer/device-passes/${dp.id}`,
  );
  expect(voided.body.devicePass.state).toBe('voided');
  const last = await request.get(`/wallet/v1/passes/${PASS_TYPE}/${serial}`, {
    headers: { authorization: `ApplePass ${json.authenticationToken}` },
  });
  expect(last.status()).toBe(200);
  expect(passJsonOf(unzipSync(new Uint8Array(await last.body())))).toMatchObject({ voided: true });
  expect(
    (await wallet(request, 'POST', 'e2e-phone-2', serial, json.authenticationToken)).status(),
  ).toBe(401);

  // Add again: a new device pass of the same source, with a code of its own.
  const again = await call<{ devicePass: { id: string; state: string; code: { url: string } } }>(
    page,
    'POST',
    `/developer/device-passes/${dp.id}/again`,
  );
  expect(again.status, JSON.stringify(again.body)).toBe(201);
  expect(again.body.devicePass).toMatchObject({ state: 'pending' });
  expect(again.body.devicePass.id).not.toBe(dp.id);
  const second = await pkpass(request, new URL(again.body.devicePass.code.url).pathname);
  expect(second.res.status()).toBe(200);

  // The list names the new pass as pending, and the voided one as voided.
  const listed = await call<{ items: { id: string; state: string }[]; limit: number }>(
    page,
    'GET',
    '/developer/device-passes',
  );
  expect(listed.body.limit).toBe(5);
  expect(Object.fromEntries(listed.body.items.map((i) => [i.id, i.state]))).toMatchObject({
    [dp.id]: 'voided',
    [again.body.devicePass.id]: 'active',
  });
});
