import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { expect } from '@playwright/test';
import { e2ePorts } from '../../tools/lib/e2e-ports.ts';
import { e2eReleaseMismatch } from '../../tools/lib/e2e-release.ts';
import { type Api, BASE, createPass, requireActiveTemplateRelease, uid } from './api.ts';
import { runMinuteCron } from './cron.ts';
import { publishTemplateVersion, templateReviewer } from './releases.ts';
import { createOrgWithRoles, readSeed } from './seed.ts';

/** The fake Google and Samsung servers tools/e2e-server.ts starts (test/mock-wallets). */
export const MOCK = `http://localhost:${e2ePorts.wallets}`;
export const TEST = { 'x-passbook-mode': 'test' } as const;
export const LIVE = { 'x-passbook-mode': 'live' } as const;
export type WalletMode = 'test' | 'live';
const headersOf = (mode: WalletMode) => (mode === 'live' ? LIVE : TEST);
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
export async function enrolTestAccount(
  admin: Api,
  orgId: string,
  credential: Record<string, unknown> & { provider: Provider },
  mode: WalletMode = 'test',
): Promise<string> {
  const MODE = headersOf(mode);
  const { provider, ...credentials } = credential;
  const base = `/api/v1/orgs/${encodeURIComponent(orgId)}`;
  const saved = await admin.send<{ id: string }>(
    'PUT',
    `${base}/wallet-credentials`,
    { provider, expectedRevision: 0, credentials },
    MODE,
  );
  const checks = `${base}/wallet-credentials/${encodeURIComponent(saved.id)}`;
  const { checkId } = await admin.send<{ checkId: string }>(
    'POST',
    `${checks}/check`,
    undefined,
    MODE,
  );
  await expect
    .poll(
      async () =>
        (
          await admin.send<{ status: string }>(
            'GET',
            `${checks}/checks/${encodeURIComponent(checkId)}`,
            undefined,
            MODE,
          )
        ).status,
      { message: `the ${provider} credential check`, timeout: 30_000 },
    )
    .toBe('ok');
  const source = await admin.send<{ enrolmentRevision: number }>(
    'PUT',
    `${base}/wallet-enrolments/${provider}`,
    { source: 'org', expectedRevision: 0 },
    MODE,
  );
  const on = await admin.send<{ state: string }>(
    'POST',
    `${base}/wallet-enrolments/${provider}/enable`,
    { expectedRevision: source.enrolmentRevision },
    MODE,
  );
  expect(on.state).toBe('on');
  return saved.id;
}

/** Runs the credential's check against the mock and returns how it ended (`ok`, or a failure). */
export async function runCredentialCheck(
  admin: Api,
  orgId: string,
  credentialId: string,
  mode: WalletMode = 'test',
): Promise<string> {
  const MODE = headersOf(mode);
  const checks = `/api/v1/orgs/${encodeURIComponent(orgId)}/wallet-credentials/${encodeURIComponent(credentialId)}`;
  const { checkId } = await admin.send<{ checkId: string }>(
    'POST',
    `${checks}/check`,
    undefined,
    MODE,
  );
  let status = 'pending';
  await expect
    .poll(
      async () => {
        status = (
          await admin.send<{ status: string }>(
            'GET',
            `${checks}/checks/${encodeURIComponent(checkId)}`,
            undefined,
            MODE,
          )
        ).status;
        return status !== 'pending';
      },
      { message: 'the credential check', timeout: 30_000 },
    )
    .toBe(true);
  return status;
}

type Credential = Record<string, unknown> & { provider: Provider };
type Manifest = Record<string, unknown> & { wallets: Record<string, unknown> };

/**
 * A template whose scan code is the only credential, so a transfer can rotate it: a lookup on an input (member ID,
 * card number) stays the same for the new holder, and the transfer asks for a reissue instead.
 */
export const withoutLookup = (manifest: Manifest): Manifest => {
  const { lookup: _lookup, ...scan } = (manifest.scan ?? {}) as Record<string, unknown>;
  return { ...manifest, scan };
};

export interface WalletOrgOptions {
  blueprint?: string;
  /** Edits the blueprint's manifest; the edited version is the one released (a Google gift card, say). */
  manifest?: (manifest: Manifest) => Manifest;
  /** Leave the Test account unset: the template is released first (CAND-1) or the org has no account. */
  enrol?: boolean;
  /** Runs once the accounts are On and before the template is released. */
  afterEnrol?: () => Promise<unknown>;
  /** The mode the accounts, template release and projections are made in; default test. */
  mode?: WalletMode;
}

/**
 * A fresh org (preset legacy) whose Test enrolments are On for each credential, and no template. The
 * creator is its only member until a reviewer joins.
 */
export async function enrolledOrg(
  admin: Api,
  name: string,
  credentials: (Record<string, unknown> & { provider: Provider })[],
) {
  const slug = uid(name).toLowerCase();
  // See walletOrg: provider projections need the credential-ref keyset a first pass makes.
  await createPass(admin, readSeed().org.id);
  const org = await createOrgWithRoles(admin, { slug, name: `Wallets ${slug}` });
  for (const credential of credentials) await enrolTestAccount(admin, org.id, credential);
  return org;
}

/**
 * A fresh org (preset legacy: every wallet included) with each provider's Test account, then a template made
 * from a blueprint and released to Test. The release queues the platform's own projections, as in production.
 */
export async function walletOrg(
  admin: Api,
  name: string,
  credentials: Credential | Credential[],
  options: WalletOrgOptions = {},
) {
  const slug = uid(name).toLowerCase();
  // A fresh e2e database has no credential-ref keyset until its first pass (production always has one), and
  // provider projections need it: one pass from the seed org makes it.
  await createPass(admin, readSeed().org.id);
  const org = await createOrgWithRoles(admin, { slug, name: `Wallets ${slug}` });
  const accounts: Partial<Record<Provider, string>> = {};
  if (options.enrol !== false)
    for (const credential of [credentials].flat())
      accounts[credential.provider] = await enrolTestAccount(
        admin,
        org.id,
        credential,
        options.mode,
      );
  await options.afterEnrol?.();
  const blueprint = options.blueprint ?? BLUEPRINT;
  let made = await admin.send<{ id: string; versions: { version: string }[] }>(
    'POST',
    `/api/v1/templates/${encodeURIComponent(blueprint)}/use`,
    { orgId: org.id, name: `Wallets ${slug}` },
  );
  const first = made.versions[0]?.version ?? '';
  let version = first;
  if (options.manifest) {
    const detail = await admin.get<{ manifest: Manifest }>(
      `/api/v1/templates/${encodeURIComponent(made.id)}?orgId=${encodeURIComponent(org.id)}`,
    );
    made = await admin.send('PUT', `/api/v1/templates/${encodeURIComponent(made.id)}/manifest`, {
      manifest: options.manifest(detail.manifest),
    });
    version = made.versions.find((v) => v.version !== first)?.version ?? '';
  }
  const mode = options.mode ?? 'test';
  await publishTemplateVersion(admin, org.id, made.id, version, mode);
  const apple = await requireActiveTemplateRelease(admin, org.id, made.id, mode);
  return { org, template: { id: made.id }, apple, accounts, mode };
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
const templatePath = (w: Pick<WalletOrg, 'template'>) =>
  `/api/v1/templates/${encodeURIComponent(w.template.id)}`;

/** A second member approves the candidate and the author publishes it: the provider's Test release. */
async function approveAndPublish(
  admin: Api,
  w: Pick<WalletOrg, 'org' | 'template'>,
  provider: Provider,
  c: Candidate,
  mode: WalletMode = 'test',
) {
  const scope = { orgId: w.org.id, mode, provider };
  const reviewer = await templateReviewer(admin, w.org.id);
  try {
    const approval = await reviewer.send<{ id: string }>(
      'POST',
      `${templatePath(w)}/candidates/${encodeURIComponent(c.id)}/approve`,
      { ...scope, candidateHash: c.candidateHash },
      headersOf(mode),
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
      headersOf(mode),
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
  return releaseSystem(admin, w, 'google');
}

/**
 * The provider's platform candidate: a human approves and publishes it when it omits something a holder sees;
 * one that omits nothing releases itself. Returns what was approved as omitted.
 */
export async function releaseSystem(
  admin: Api,
  w: Pick<WalletOrg, 'org' | 'template' | 'apple'>,
  provider: Provider,
  options: { cron?: boolean; mode?: WalletMode } = {},
): Promise<string[]> {
  const tick = async () => {
    // A template released before its account was On is found by the minute cron's drain (CAND-1).
    if (options.cron) await runMinuteCron();
  };
  let candidate: Candidate | undefined;
  await expect
    .poll(
      async () => {
        await tick();
        candidate = await systemCandidate(admin, w, provider, options.mode);
        return Boolean(candidate);
      },
      { message: `the system ${provider} candidate`, timeout: 45_000 },
    )
    .toBe(true);
  if (!candidate) throw new Error(`No system ${provider} candidate`);
  const omissions = candidate.projection.approvedOmissions ?? [];
  if (omissions.length > 0) await approveAndPublish(admin, w, provider, candidate, options.mode);
  await expect
    .poll(
      async () => {
        await tick();
        return (await providerRelease(admin, w, provider, options.mode)) !== null;
      },
      { message: `the ${provider} release`, timeout: 45_000 },
    )
    .toBe(true);
  return omissions;
}

/** The platform's own candidate for the provider, once it has written one. */
export async function systemCandidate(
  admin: Api,
  w: Pick<WalletOrg, 'org' | 'template'>,
  provider: Provider,
  mode: WalletMode = 'test',
) {
  const query = new URLSearchParams({ orgId: w.org.id, mode, provider });
  const list = await admin.send<{ items: (Candidate & { authorId: string })[] }>(
    'GET',
    `${templatePath(w)}/candidates?${query}`,
    undefined,
    headersOf(mode),
  );
  return list.items.find((c) => c.authorId.startsWith('system:'));
}

/** The provider's active Test release of the template, if any. */
export async function providerRelease(
  admin: Api,
  w: Pick<WalletOrg, 'org' | 'template'>,
  provider: Provider,
  mode: WalletMode = 'test',
): Promise<{ id: string } | null> {
  const query = new URLSearchParams({ orgId: w.org.id, mode, provider });
  const list = await admin.send<{ active: { id: string } | null }>(
    'GET',
    `${templatePath(w)}/releases?${query}`,
    undefined,
    headersOf(mode),
  );
  return list.active;
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
export async function testPass(
  admin: Api,
  w: Pick<WalletOrg, 'org' | 'apple'> & { mode?: WalletMode },
  input?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const memberId = uid('DAY').toUpperCase();
  const mode = w.mode ?? 'test';
  const pass = await admin.send<{ id: string; publicUrl: string }>(
    'POST',
    '/api/v1/passes',
    {
      orgId: w.org.id,
      templateId: w.apple.templateId,
      templateVersion: w.apple.version,
      releaseId: w.apple.id,
      releaseGeneration: w.apple.generation,
      mode,
      // A change message needs a value to change from (passkit/wallets/google/messages.ts).
      input: input ?? { memberName: `Holder ${memberId}`, memberId, message: 'Welcome.' },
      holderEmail: `${uid('holder')}@example.test`,
      ...extra,
    },
    { ...headersOf(mode), 'Idempotency-Key': uid('idem') },
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

/**
 * Runs SQL in the e2e server's throwaway local database, for the one thing no API reaches: a clock. Local only;
 * wrangler's `--local` never reaches a deployed database.
 */
export function localSql(command: string): void {
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'wallet-platform',
      '--local',
      '--persist-to',
      '.wrangler/e2e-state',
      '--command',
      command,
    ],
    { stdio: 'pipe' },
  );
}

/** Sets the platform's release of both providers in both modes on the running e2e server (a rollback rehearsal). */
export async function setRelease(state: 'draining' | 'released'): Promise<void> {
  const res = await fetch(`${BASE}/__e2e/wallet-release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`The release did not move to ${state}: ${res.status}`);
}

/** A Test pass filled from the template's own sample (every blueprint ships one), with the holder's email. */
export async function samplePass(
  admin: Api,
  w: WalletOrg,
  over: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const detail = await admin.get<{ sample: Record<string, unknown> }>(
    `${templatePath(w)}?orgId=${encodeURIComponent(w.org.id)}`,
  );
  return testPass(admin, w, { ...detail.sample, ...over }, extra);
}
