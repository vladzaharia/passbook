import { generateKeyPairSync } from 'node:crypto';
import { expect } from '@playwright/test';
import { e2ePorts } from '../../tools/lib/e2e-ports.ts';
import { e2eReleaseMismatch } from '../../tools/lib/e2e-release.ts';
import { type Api, createPass, requireActiveTemplateRelease, uid } from './api.ts';
import { runMinuteCron } from './cron.ts';
import { publishTemplateVersion, templateReviewer } from './releases.ts';
import { createOrgWithRoles, readSeed } from './seed.ts';

/** The fake Google and Samsung servers tools/e2e-server.ts starts (test/mock-wallets). */
export const MOCK = `http://localhost:${e2ePorts.wallets}`;
export const TEST = { 'x-passbook-mode': 'test' } as const;
type Provider = 'google' | 'samsung';

/**
 * The Day pass blueprint: few inputs, so Google's class rule checks each one. Membership and the store card
 * are blocked for Google ("class fields could not be checked"); see architecture.md section 8, CW12 status.
 */
const BLUEPRINT = 'baked:starter-day-pass';

export interface MockRequest {
  provider: Provider;
  method: string;
  path: string;
  status: number;
  body?: Record<string, unknown>;
}

export const mockRequests = async (): Promise<MockRequest[]> =>
  (await fetch(`${MOCK}/__mock/requests`)).json() as Promise<MockRequest[]>;

export const mockState = async (): Promise<{
  google: Record<string, Record<string, Record<string, unknown>>> & {
    saves: { objectIds: string[] }[];
  };
  samsung: { refs: Record<string, { state: string; type: string; cardId: string }> };
}> => (await fetch(`${MOCK}/__mock/state`)).json() as never;

/** The platform's release flags as the server reports them (settings, platform scope). */
export async function releasedOn(admin: Api): Promise<Record<Provider, boolean> | undefined> {
  return (
    await admin.get<{ released?: Record<Provider, boolean> }>('/api/v1/settings?scope=platform')
  ).released;
}

/** Fails at once on a server started without the e2e release (a reused main e2e server). */
export async function requireE2eRelease(admin: Api): Promise<void> {
  const mismatch = e2eReleaseMismatch(await releasedOn(admin), true);
  if (mismatch) throw new Error(mismatch);
}

/**
 * The org's Test enrolment, On: its own credential (an issuer per run, so object ids are this run's own), a
 * passing check against the mock (which verifies it), the credential as the source, then enable. Only an
 * enrolment that is On issues (migration 0229); the legacy account route has no part in it.
 */
async function enrolTestAccount(
  admin: Api,
  orgId: string,
  credential: Record<string, unknown> & { provider: Provider },
): Promise<void> {
  const { provider, ...credentials } = credential;
  const base = `/api/v1/orgs/${encodeURIComponent(orgId)}`;
  const saved = await admin.send<{ id: string }>(
    'PUT',
    `${base}/wallet-credentials`,
    { provider, expectedRevision: 0, credentials },
    TEST,
  );
  const checks = `${base}/wallet-credentials/${encodeURIComponent(saved.id)}`;
  const { checkId } = await admin.send<{ checkId: string }>(
    'POST',
    `${checks}/check`,
    undefined,
    TEST,
  );
  await expect
    .poll(
      async () =>
        (
          await admin.send<{ status: string }>(
            'GET',
            `${checks}/checks/${encodeURIComponent(checkId)}`,
            undefined,
            TEST,
          )
        ).status,
      { message: `the ${provider} credential check`, timeout: 30_000 },
    )
    .toBe('ok');
  const source = await admin.send<{ enrolmentRevision: number }>(
    'PUT',
    `${base}/wallet-enrolments/${provider}`,
    { source: 'org', expectedRevision: 0 },
    TEST,
  );
  const on = await admin.send<{ state: string }>(
    'POST',
    `${base}/wallet-enrolments/${provider}/enable`,
    { expectedRevision: source.enrolmentRevision },
    TEST,
  );
  expect(on.state).toBe('on');
}

/**
 * A fresh org (preset legacy: every wallet included) with the provider's Test account, then a Day pass
 * template released to Test. The release queues the platform's own Google projection, as in production.
 */
export async function walletOrg(
  admin: Api,
  name: string,
  credential: Record<string, unknown> & { provider: Provider },
) {
  const slug = uid(name).toLowerCase();
  // A fresh e2e database has no credential-ref keyset until its first pass (production always has one), and
  // provider projections need it: one pass from the seed org makes it.
  await createPass(admin, readSeed().org.id);
  const org = await createOrgWithRoles(admin, { slug, name: `Wallets ${slug}` });
  await enrolTestAccount(admin, org.id, credential);
  const made = await admin.send<{ id: string; versions: { version: string }[] }>(
    'POST',
    `/api/v1/templates/${encodeURIComponent(BLUEPRINT)}/use`,
    { orgId: org.id, name: `Wallets ${slug}` },
  );
  const version = made.versions[0]?.version ?? '';
  await publishTemplateVersion(admin, org.id, made.id, version, 'test');
  const apple = await requireActiveTemplateRelease(admin, org.id, made.id, 'test');
  return { org, template: { id: made.id }, apple };
}

export type WalletOrg = Awaited<ReturnType<typeof walletOrg>>;

/** A fresh Google service account key and issuer id: object ids, and so every assertion, are this run's own. */
export function googleCredential() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuerId = `3388${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 1e4)}`;
  return {
    provider: 'google' as const,
    issuerId,
    serviceAccountEmail: 'e2e@passbook-e2e.iam.gserviceaccount.com',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  };
}

type Candidate = {
  id: string;
  candidateHash: string;
  projection: { approvedOmissions?: string[] };
};
const templatePath = (w: WalletOrg) => `/api/v1/templates/${encodeURIComponent(w.template.id)}`;

/** A second member approves the candidate and the author publishes it: the provider's Test release. */
async function approveAndPublish(admin: Api, w: WalletOrg, provider: Provider, c: Candidate) {
  const scope = { orgId: w.org.id, mode: 'test', provider };
  const reviewer = await templateReviewer(admin, w.org.id);
  try {
    const approval = await reviewer.send<{ id: string }>(
      'POST',
      `${templatePath(w)}/candidates/${encodeURIComponent(c.id)}/approve`,
      { ...scope, candidateHash: c.candidateHash },
      TEST,
    );
    await admin.send(
      'POST',
      `${templatePath(w)}/releases`,
      {
        ...scope,
        candidateId: c.id,
        approvalId: approval.id,
        candidateHash: c.candidateHash,
        expectedGeneration: 0,
      },
      TEST,
    );
  } finally {
    await reviewer.dispose();
  }
}

/**
 * The Google candidate the platform authored after the Apple release (CW7b). Its report omits something a
 * holder sees, so it waits for one human approval instead of releasing itself.
 */
export async function releaseSystemGoogle(admin: Api, w: WalletOrg): Promise<string[]> {
  const query = new URLSearchParams({ orgId: w.org.id, mode: 'test', provider: 'google' });
  let candidate: Candidate | undefined;
  await expect
    .poll(
      async () => {
        const list = await admin.send<{ items: (Candidate & { authorId: string })[] }>(
          'GET',
          `${templatePath(w)}/candidates?${query}`,
          undefined,
          TEST,
        );
        candidate = list.items.find((c) => c.authorId.startsWith('system:'));
        return Boolean(candidate);
      },
      { message: 'the system Google candidate', timeout: 30_000 },
    )
    .toBe(true);
  if (!candidate) throw new Error('No system Google candidate');
  await approveAndPublish(admin, w, 'google', candidate);
  return candidate.projection.approvedOmissions ?? [];
}

/** A candidate the test authors for a provider, approved by a second member and published to Test. */
export async function releaseProjection(
  admin: Api,
  w: WalletOrg,
  provider: Provider,
  approvedOmissions: string[],
) {
  const candidate = await admin.send<Candidate>(
    'POST',
    `${templatePath(w)}/candidates`,
    {
      orgId: w.org.id,
      mode: 'test',
      provider,
      version: w.apple.version,
      sourceReleaseId: w.apple.id,
      projection: { schema: 2, provider, approvedOmissions },
    },
    TEST,
  );
  await approveAndPublish(admin, w, provider, candidate);
}

/** A Test pass from the org's Day pass release, with the holder's email. */
export async function testPass(admin: Api, w: WalletOrg) {
  const memberId = uid('DAY').toUpperCase();
  const pass = await admin.send<{ id: string; publicUrl: string }>(
    'POST',
    '/api/v1/passes',
    {
      orgId: w.org.id,
      templateId: w.apple.templateId,
      templateVersion: w.apple.version,
      releaseId: w.apple.id,
      releaseGeneration: w.apple.generation,
      mode: 'test',
      // A change message needs a value to change from (passkit/wallets/google/messages.ts).
      input: { memberName: `Holder ${memberId}`, memberId, message: 'Welcome.' },
      holderEmail: `${uid('holder')}@example.test`,
    },
    { ...TEST, 'Idempotency-Key': uid('idem') },
  );
  return { ...pass, path: new URL(pass.publicUrl).pathname };
}

export const passPath = (id: string) => `/api/v1/passes/${encodeURIComponent(id)}`;

/** Runs the minute cron (wallet.sync drains provider operations) until `done` holds. */
export async function syncUntil(done: () => Promise<boolean>, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await runMinuteCron();
        return done();
      },
      { message: what, intervals: [500, 1_000, 2_000], timeout: 45_000 },
    )
    .toBe(true);
}
