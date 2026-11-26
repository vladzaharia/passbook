import { beforeAll } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import type { TemplateCandidate } from '../../../shared/contracts/template-releases.ts';
import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import {
  createJobContext,
  createServiceContext,
  type ServiceContext,
} from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { basicPackage, makePng, passJson, zipOf } from '../templates/package/fixtures.ts';
import { approveCandidate, createCandidate, publishRelease } from '../templates/releases.ts';
import { getVersion } from '../templates/repo.ts';
import { fakeAssets, importZip } from '../templates/testing.ts';
import { configureOn } from './legacy-on-test-fixtures.ts';
import type { ProjectionV2 } from './projection-contract.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const manifest = {
  schema: 1,
  name: 'Reviewed card',
  inputs: { type: 'object', properties: { name: { type: 'string' } } },
  sample: { name: 'Ada' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
};
export const LOGO = 'wallets/google/logo.png';
export const withLogo = { schema: 1, google: { images: { logo: LOGO } } };

interface Shared {
  env: AppEnv;
  clock: ManualClock;
  f: Fixtures;
  google: GoogleWalletCredentials;
}
/** Filled by `installV2Env` in a test file. */
export const S = {} as Shared;

export function installV2Env(): void {
  beforeAll(async () => {
    S.clock = new ManualClock();
    S.env = await makeEnv({
      KEK_V1,
      KEK_V2: undefined,
      KEK_V3: undefined,
      ASSETS: fakeAssets(),
    });
    S.f = fixtures(S.env, S.clock);
    S.google = {
      issuerId: '33880000000223344',
      serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
      privateKeyPem: S.env.SIGNER_PLATFORM_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
    };
  });
}

export async function member(orgId: string, roles: string[] = ['org_admin']): Promise<SessionAuth> {
  const roleJson = JSON.stringify(roles);
  const { env, f, clock } = S;
  const user = await makeUser(f);
  const now = clock.now();
  const invitation = f.ids.id();
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invitation, orgId, user.primaryEmail, roleJson, f.ids.token(), now, now + 3600_000, now],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, user.id, invitation, roleJson, now],
  );
  const session = await makeSession(f, { userId: user.id });
  const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Test session did not resolve.');
  return auth;
}

export interface Kit {
  ctx: ServiceContext;
  orgId: string;
  author: SessionAuth;
  reviewer: SessionAuth;
  templateId: string;
  version: string;
  sourceId: string;
  scope: { orgId: string; mode: 'live'; provider: 'google' };
}

/** An uploaded template with a reviewed Apple release and a configured Google account. */
export async function setup(
  files: Record<string, Uint8Array | string> = {},
  wallets: unknown = withLogo,
  existing?: Pick<Kit, 'orgId' | 'author' | 'reviewer'>,
  /** The reviewer is the author in a one-member org: the Apple release is approved alone. */
  sole = false,
): Promise<Kit> {
  const { env, f, clock } = S;
  const orgId = existing?.orgId ?? (await makeOrg(f)).id;
  const author = existing?.author ?? (await member(orgId));
  const reviewer = existing?.reviewer ?? (await member(orgId));
  const ctx = createServiceContext(env, { clock });
  const imported = await importZip(env, clock, {
    orgId,
    createdBy: author.userId,
    name: 'Wallet card',
    zip: zipOf(
      basicPackage(
        {
          'wallet.template.json': JSON.stringify({ ...manifest, wallets }),
          [LOGO]: makePng(660, 660),
          ...files,
        },
        passJson(),
      ),
    ),
  });
  if (!imported.result) throw new Error('Test template import failed.');
  const { templateId, version } = imported.result;
  const apple = { orgId, mode: 'live' as const, provider: 'apple' as const };
  const c = await createCandidate(ctx, author, templateId, { ...apple, version });
  const a = await approveCandidate(ctx, reviewer, templateId, c.id, {
    ...apple,
    candidateHash: c.candidateHash,
    ...(sole ? { alone: true } : {}),
  });
  const source = await publishRelease(ctx, author, templateId, {
    ...apple,
    candidateId: c.id,
    approvalId: a.id,
    candidateHash: c.candidateHash,
    expectedGeneration: 0,
  });
  const scope = { orgId, mode: 'live' as const, provider: 'google' as const };
  if (!existing || sole)
    await configureOn(ctx, author, {
      ...scope,
      expectedRevision: 0,
      credentials: S.google,
    });
  return { ctx, orgId, author, reviewer, templateId, version, sourceId: source.id, scope };
}

export async function pinsOf(kit: Kit): Promise<ProjectionV2> {
  const row = await getVersion(S.env.DB, kit.templateId, kit.version);
  if (!row) throw new Error('Version missing.');
  return (await computeProjectionPins(kit.ctx, 'google', row)).pins;
}
export const candidateOf = (kit: Kit, projection: unknown): Promise<TemplateCandidate> =>
  createProjectionCandidate(kit.ctx, kit.author, kit.templateId, {
    ...kit.scope,
    version: kit.version,
    sourceReleaseId: kit.sourceId,
    projection,
  });
export const request = (approvedOmissions: string[] = []) => ({
  schema: 2 as const,
  provider: 'google' as const,
  approvedOmissions,
});
export const approveOf = (kit: Kit, candidate: TemplateCandidate) =>
  approveProjectionCandidate(kit.ctx, kit.reviewer, kit.templateId, candidate.id, {
    ...kit.scope,
    candidateHash: candidate.candidateHash,
  });
export async function released(kit: Kit, candidate: TemplateCandidate, expectedGeneration = 0) {
  const approval = await approveOf(kit, candidate);
  return publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
    ...kit.scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration,
  });
}
export const lookup = (kit: Kit) => ({
  ...kit.scope,
  templateId: kit.templateId,
  templateVersion: kit.version,
  appleReleaseId: kit.sourceId,
});

/** A sharing omission, as a compiler update that loses something would report. */
export const sharingLoss = {
  capability: 'sharing',
  path: '',
  support: 'omitted',
  message: 'Google cannot prohibit sharing.',
} as const;

/**
 * Stands in for a compiler update: bumps the revision by `bump` (a fresh pipeline each time) and
 * lets `change` rewrite what it compiles. Returns the restorer.
 */
export function updateCompiler(
  change: (result: CompileResult) => CompileResult = (result) => result,
  bump = 1,
): () => void {
  const { revision, compile } = googleCompiler;
  googleCompiler.revision = revision + bump;
  googleCompiler.compile = (view, options) => change(compile(view, options));
  return () => {
    googleCompiler.revision = revision;
    googleCompiler.compile = compile;
  };
}
export const addsSharingLoss = (result: CompileResult): CompileResult => ({
  ...result,
  items: [...result.items, sharingLoss],
});

/** A queue context: the platform's system writes need job authority. */
export const jobCtx = (of: ServiceContext): ServiceContext =>
  createJobContext(of.env, 'wallet.projection_system', { clock: of.clock });
