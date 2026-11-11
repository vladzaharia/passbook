import { type Fixtures, makeUser } from '../../../../test/helpers/index.ts';
import type { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { AssetEntry } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { approveCandidate, createCandidate, publishRelease } from '../templates/releases.ts';
import {
  findAppleReleaseFixtureGeneration,
  findReleaseFixtureMembership,
  findReleaseFixtureUser,
  findReleaseFixtureVersion,
  insertReleaseFixtureMembership,
  insertReleaseFixtureUser,
} from './repo-apple-release-test-fixtures.ts';

/** The subset needed by the release fixture, including real-registry integration tests. */
export interface AppleReleaseFixture {
  ctx: ServiceContext;
  fx: Fixtures;
  org?: { id: string };
  template?: { id: string; version: string };
  registry?: InMemoryTemplateRegistry;
}

export interface AppleReleaseOptions {
  orgId?: string;
  mode?: Mode;
  templateId?: string;
  version?: string;
  /** Bypass a test's interception proxy while retaining its R2/ASSETS bindings. */
  db?: D1Database;
}

function releaseFixture(fixture: AppleReleaseFixture, db?: D1Database): AppleReleaseFixture {
  if (!db || db === fixture.ctx.env.DB) return fixture;
  const env = { ...fixture.ctx.env, DB: db };
  return { ...fixture, ctx: { ...fixture.ctx, env }, fx: { ...fixture.fx, env } };
}

function releaseScope(fixture: AppleReleaseFixture, options: AppleReleaseOptions) {
  const orgId = options.orgId ?? fixture.org?.id;
  const templateId = options.templateId ?? fixture.template?.id;
  const version = options.version ?? fixture.template?.version;
  if (orgId === undefined || templateId === undefined || version === undefined)
    throw new Error('An organization, template and version are required for a release fixture.');
  return { orgId, templateId, version, mode: options.mode ?? 'live' };
}

/** Grants an actual tenant membership to a test principal without changing an existing user. */
export async function grantKitMembership(
  kit: AppleReleaseFixture,
  orgId = kit.org?.id,
  userId = 'admin-1',
  roles: OrgRole[] = ['pass_operator'],
): Promise<string> {
  if (orgId === undefined) throw new Error('An organization is required for a membership fixture.');
  const db = kit.ctx.env.DB;
  const now = kit.ctx.clock.now();
  await insertReleaseFixtureUser(db, userId, now);
  const user = await findReleaseFixtureUser(db, userId);
  if (!user) throw new Error('Membership fixture user is missing.');
  const existing = await findReleaseFixtureMembership(db, orgId, userId);
  if (existing) {
    const current = JSON.parse(existing.roles) as OrgRole[];
    if (current.length !== roles.length || roles.some((role) => !current.includes(role)))
      throw new Error('The existing membership has different roles.');
    return existing.id;
  }
  const invitationId = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  const encodedRoles = JSON.stringify(roles);
  await insertReleaseFixtureMembership(db, {
    invitationId,
    orgId,
    email: user.primary_email,
    encodedRoles,
    tokenHash: await sha256Hex(kit.fx.ids.token(32)),
    now,
    membershipId,
    userId,
  });
  return membershipId;
}

/** Check that an in-memory fixture was materialized when its version was inserted. */
export async function prepareAppleReleaseVersion(
  input: AppleReleaseFixture,
  options: Pick<AppleReleaseOptions, 'templateId' | 'version' | 'db'> = {},
): Promise<void> {
  const fixture = releaseFixture(input, options.db);
  const templateId = options.templateId ?? fixture.template?.id;
  const version = options.version ?? fixture.template?.version;
  if (templateId === undefined || version === undefined)
    throw new Error('A template and version are required for a release fixture.');
  const registry = fixture.registry;
  if (!registry) return;
  const row = await findReleaseFixtureVersion(fixture.ctx.env.DB, templateId, version);
  if (!row) return;
  let template: ResolvedTemplate;
  try {
    template = await registry.resolve(templateId, version);
  } catch (error) {
    if (
      (error instanceof NotFoundError && error.code === 'TEMPLATE_NOT_FOUND') ||
      (error instanceof Error && error.message === `Template ${templateId}@${version} not found`)
    )
      return;
    throw error;
  }
  const storedAssets = JSON.parse(row.assets) as AssetEntry[];
  if (
    storedAssets.some((asset) => asset.source.kind === 'inline') ||
    canonicalJson(storedAssets.map((asset) => asset.name).sort()) !==
      canonicalJson(template.assets.map((asset) => asset.name).sort())
  )
    throw new Error(`Persisted fixture assets were not materialized for ${templateId}@${version}.`);
  if (
    canonicalJson(JSON.parse(row.manifest)) !== canonicalJson(template.manifest) ||
    canonicalJson(JSON.parse(row.pass_json)) !== canonicalJson(template.passJson)
  )
    throw new Error(
      `Persisted fixture ${templateId}@${version} differs from its registry version.`,
    );
}

/** A real user, session and accepted invitation, with the requested tenant roles. */
async function releasePrincipal(
  fixture: AppleReleaseFixture,
  orgId: string,
  mode: Mode,
  roles: OrgRole[],
): Promise<SessionAuth> {
  const user = await makeUser(fixture.fx);
  await grantKitMembership(fixture, orgId, user.id, roles);
  const session = await createSession(fixture.ctx, {
    userId: user.id,
    roles: ['user'],
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const auth = await resolveSession(fixture.ctx.env, fixture.ctx.clock, session.cookieValue);
  if (!auth) throw new Error('The release fixture session could not be resolved.');
  return { ...auth, mode };
}

/** Submit a real candidate with distinct author and reviewer principals, without approval. */
export async function createAppleReleaseCandidate(
  input: AppleReleaseFixture,
  options: AppleReleaseOptions = {},
) {
  const fixture = releaseFixture(input, options.db);
  const { orgId, templateId, version, mode } = releaseScope(fixture, options);
  await prepareAppleReleaseVersion(fixture, { templateId, version });
  const authorAuth = await releasePrincipal(fixture, orgId, mode, [
    'template_author',
    'template_publisher',
  ]);
  const reviewerAuth = await releasePrincipal(fixture, orgId, mode, ['template_reviewer']);
  const candidate = await createCandidate(fixture.ctx, authorAuth, templateId, {
    orgId,
    mode,
    provider: 'apple',
    version,
  });
  return { candidate, authorAuth, reviewerAuth, publisherAuth: authorAuth };
}

/** Create, independently approve and publish a new Apple release in the exact tenant scope. */
export async function approveAppleRelease(
  input: AppleReleaseFixture,
  options: AppleReleaseOptions = {},
) {
  const fixture = releaseFixture(input, options.db);
  const { orgId, templateId, mode } = releaseScope(fixture, options);
  const { candidate, authorAuth, reviewerAuth, publisherAuth } = await createAppleReleaseCandidate(
    fixture,
    options,
  );
  const approval = await approveCandidate(fixture.ctx, reviewerAuth, templateId, candidate.id, {
    orgId,
    mode,
    provider: 'apple',
    candidateHash: candidate.candidateHash,
  });
  const current = await findAppleReleaseFixtureGeneration(
    fixture.ctx.env.DB,
    templateId,
    orgId,
    mode,
  );
  const release = await publishRelease(fixture.ctx, publisherAuth, templateId, {
    orgId,
    mode,
    provider: 'apple',
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: current?.generation ?? 0,
  });
  return { ...release, candidate, approval, authorAuth, reviewerAuth, publisherAuth };
}
