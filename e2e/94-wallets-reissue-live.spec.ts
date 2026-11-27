import { expect, test } from '@playwright/test';
import {
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from '../src/worker/modules/wallet-providers/google-callback-test-kit.ts';
import { type Api, apiAs, BASE } from './helpers/api.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import {
  enrolTestAccount,
  googleCredential,
  LIVE,
  MOCK,
  mockRequests,
  mockState,
  passPath,
  releaseSystem,
  requireE2eRelease,
  runCredentialCheck,
  samplePass,
  syncUntil,
  TEST,
  type WalletOrg,
  walletOrg,
} from './helpers/wallets.ts';
import { samsungKit, saveToGoogle } from './helpers/wallets-phone.ts';

// The wallet reissue and Live isolation journeys on the mock wallets. Needs playwright.wallets.config.ts.
test.describe.configure({ mode: 'serial' });

let admin: Api;

test.beforeAll(async () => {
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
});

test.afterAll(async () => {
  await admin?.dispose();
});

const reissue = (orgId: string, provider: 'google' | 'samsung', headers: object = TEST) =>
  admin.send<{ reissueId: string; instances: number; operationId: string | null }>(
    'POST',
    '/api/v1/wallet-providers/reissue',
    { orgId, provider },
    headers,
  );

test('a Google reissue sends every added copy again, and one nobody added has nothing to send', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const credential = googleCredential();
  const w = await walletOrg(admin, 'g-reissue', credential);
  await releaseSystem(admin, w, 'google');
  expect(await reissue(w.org.id, 'google')).toMatchObject({ instances: 0, operationId: null });

  const holder = await samplePass(admin, w);
  await saveToGoogle(browser, holder.path);
  const writes = async () =>
    (await mockRequests()).filter(
      (r) =>
        r.provider === 'google' &&
        r.method !== 'GET' &&
        r.path.includes('/genericObject') &&
        r.status < 300,
    ).length;
  const before = await writes();
  const started = await reissue(w.org.id, 'google');
  expect(started.instances).toBe(1);
  expect(started.operationId).not.toBeNull();
  await syncUntil(async () => (await writes()) > before, 'Google got the reissued object');
});

test('a Samsung reissue sends every added card an update', async () => {
  test.setTimeout(150_000);
  const kit = await samsungKit('loyalty');
  const w = await walletOrg(admin, 's-reissue', kit.credential, {
    blueprint: 'baked:starter-store-card',
  });
  await releaseSystem(admin, w, 'samsung');
  const holder = await samplePass(admin, w);
  await kit.add(holder.path);
  const updates = async () =>
    (await mockRequests()).filter(
      (r) =>
        r.provider === 'samsung' &&
        r.method === 'POST' &&
        r.path === `/US/wltex/cards/${kit.cardId}/updates` &&
        r.status === 200,
    ).length;
  await syncUntil(async () => (await updates()) > 0, 'the add settled');
  const before = await updates();
  const started = await reissue(w.org.id, 'samsung');
  expect(started.instances).toBe(1);
  await syncUntil(async () => (await updates()) > before, 'Samsung got the reissue update');
});

/** The org's Test round trip for Google: a signed save callback, which Live enabling asks for (planEnable). */
async function googleTestRoundTrip(issuerId: string) {
  const keys = await makeCallbackSigningKeys();
  await fetch(`${MOCK}/__mock/google-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await callbackKeyset(keys.root, Date.now() + 86_400_000)),
  });
  const state = (await mockState()).google as unknown as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const object = Object.values(state.genericObject ?? {}).find((o) =>
    String(o.id).startsWith(`${issuerId}.`),
  );
  const klass = state.genericClass?.[String(object?.classId)];
  const url = new URL(String((klass?.callbackOptions as { url?: string } | undefined)?.url));
  const body = await signedGoogleEvent(
    keys,
    issuerId,
    {
      classId: object?.classId,
      objectId: object?.id,
      eventType: 'save',
      nonce: 'round-trip',
      expTimeMillis: String(Date.now() + 3_600_000),
    },
    { keyExpiration: Date.now() + 86_400_000 },
  );
  const res = await fetch(`${BASE}${url.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  expect(res.status).toBe(204);
}

/** The Live release of the template and its pass, once the Live account is on. */
async function livePass(w: WalletOrg, provider: 'google' | 'samsung') {
  await publishTemplateVersion(admin, w.org.id, w.template.id, w.apple.version, 'live');
  const live = { ...w, mode: 'live' as const };
  await releaseSystem(admin, live, provider, { mode: 'live' });
  const releases = await admin.get<{ active: WalletOrg['apple'] }>(
    `/api/v1/templates/${encodeURIComponent(w.template.id)}/releases?orgId=${encodeURIComponent(w.org.id)}&mode=live&provider=apple`,
  );
  return samplePass(admin, { ...live, apple: releases.active });
}

test('a Live Google offer saves to the Live issuer and never to the Test one', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const testIssuer = googleCredential();
  const liveIssuer = googleCredential();
  const w = await walletOrg(admin, 'g-live', testIssuer);
  await releaseSystem(admin, w, 'google');
  await saveToGoogle(browser, (await samplePass(admin, w)).path);
  await googleTestRoundTrip(testIssuer.issuerId);
  await enrolTestAccount(admin, w.org.id, liveIssuer, 'live');
  const holder = await livePass(w, 'google');
  await saveToGoogle(browser, holder.path);
  const saved = (await mockState()).google.saves.flatMap((s) => s.objectIds);
  expect(saved.filter((id) => id.startsWith(`${liveIssuer.issuerId}.`))).toHaveLength(1);
  const live = (await mockRequests()).filter(
    (r) =>
      r.provider === 'google' &&
      r.method !== 'GET' &&
      JSON.stringify(r.body ?? {}).includes(`${liveIssuer.issuerId}.`),
  );
  expect(live.length).toBeGreaterThan(0);
  // Nothing written for the Live pass carries the Test issuer.
  expect(live.some((r) => JSON.stringify(r.body).includes(`${testIssuer.issuerId}.`))).toBe(false);
});

test('a Live Samsung add reaches the Live card and never the Test one', async () => {
  test.setTimeout(300_000);
  const testKit = await samsungKit('loyalty');
  const liveKit = await samsungKit('loyalty');
  const w = await walletOrg(admin, 's-live', testKit.credential, {
    blueprint: 'baked:starter-store-card',
  });
  await releaseSystem(admin, w, 'samsung');
  const testHolder = await samplePass(admin, w);
  const testRef = await testKit.add(testHolder.path);
  await enrolTestAccount(admin, w.org.id, liveKit.credential, 'live');
  const holder = await livePass(w, 'samsung');
  const liveRef = await liveKit.add(holder.path);
  // Samsung's state is what the platform sent: an edit to each pass in its own mode.
  await admin.send('PATCH', passPath(testHolder.id), { input: { note: 'Test edit.' } }, TEST);
  await admin.send('PATCH', passPath(holder.id), { input: { note: 'Live edit.' } }, LIVE);
  const sent = async () => (await mockState()).samsung.refs;
  await syncUntil(
    async () => Boolean((await sent())[testRef] && (await sent())[liveRef]),
    'Samsung got both updates',
  );
  const refs = await sent();
  expect(refs[testRef]?.cardId).toBe(testKit.cardId);
  expect(refs[liveRef]?.cardId).toBe(liveKit.cardId);
  expect(liveKit.cardId).not.toBe(testKit.cardId);
  // Each edit's own note reached its own card, and neither card saw the other's.
  const testCard = JSON.stringify(await testKit.card(testRef));
  const liveCard = JSON.stringify(await liveKit.card(liveRef));
  expect(testCard).toContain('Test edit.');
  expect(testCard).not.toContain('Live edit.');
  expect(liveCard).toContain('Live edit.');
  expect(liveCard).not.toContain('Test edit.');
});

test('a Samsung card still in testing mode passes the Test check and fails the Live one', async () => {
  test.setTimeout(120_000);
  const kit = await samsungKit('loyalty', { testingModeOff: 'N' });
  const w = await walletOrg(admin, 's-launch', kit.credential, {
    blueprint: 'baked:starter-store-card',
  });
  const base = `/api/v1/orgs/${encodeURIComponent(w.org.id)}/wallet-credentials`;
  const { provider, ...credentials } = kit.credential;
  const saved = await admin.send<{ id: string }>(
    'PUT',
    base,
    { provider, expectedRevision: 0, credentials },
    LIVE,
  );
  expect(await runCredentialCheck(admin, w.org.id, saved.id, 'live')).toBe('failed');
  const testCredential = Object.values(w.accounts)[0];
  expect(testCredential).toBeTruthy();
  expect(await runCredentialCheck(admin, w.org.id, testCredential as string)).toBe('ok');
});
