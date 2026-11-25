import {
  ScanDisplayPreviewQuerySchema,
  ScanDisplayPreviewSchema,
} from '../../../shared/contracts/scan-display-preview.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks } from '../passes/repo-authority.ts';
import { activeRelease } from '../templates/releases.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { safeJson, safeTimestamp, visibleFields } from './card-semantics.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import { previewScope } from './display-preview.ts';
import { cardPrivacy } from './dto-projection.ts';
import { candidateById } from './repo-lookup.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { previewActorStmt, previewCurrentStmt } from './repo-routes-display.ts';
import { foundOf } from './resolve.ts';
import { ROLE_RANK } from './rules.ts';

/** Real-pass scope for the scan screen editor. */
export const scanDisplayRoutes = createRouter();
scanDisplayRoutes.use('/preview', requireTenantSession);

register(
  scanDisplayRoutes,
  'scan-display',
  {
    method: 'get',
    path: '/preview',
    summary: 'Preview a scan screen with a real pass',
    query: ScanDisplayPreviewQuerySchema,
    response: ScanDisplayPreviewSchema,
  },
  async (c) => {
    const { orgId, mode, templateId, passId, role } = c.req.valid('query');
    // The preview writes an audit row, so a cross-site navigation must not reach it.
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin')
      throw new ForbiddenError('Cross-origin requests are not allowed.', 'CSRF_ORIGIN');
    const ctx = credentialKeysetContext(serviceContext(c));
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const notFound = () =>
      new NotFoundError('Preview not found.', 'SCAN_DISPLAY_PREVIEW_NOT_FOUND');
    if (auth.mode !== mode) throw notFound();
    // Deny an unauthorized org before attempting any credential-keyset bootstrap.
    const membership = await getOrgAccess(ctx, auth.userId, orgId);
    if (!membership) throw notFound();
    const previewCapability = membership.capabilities.includes('templates:read')
      ? 'templates:read'
      : 'scanning:read';
    const previewAuthority = await tenantAuthorityOf(ctx, auth, orgId, previewCapability);
    const authority = await tenantAuthorityOf(ctx, auth, orgId, 'passes:read');
    if (authority.kind !== 'session' || previewAuthority.kind !== 'session')
      throw new ForbiddenError();
    const authorizedRole = tenantScanRole(authority);
    if (!authorizedRole || ROLE_RANK[role] > ROLE_RANK[authorizedRole]) throw new ForbiddenError();
    const capturedAuthority = await captureScanTenantAuthority(ctx, auth, authority);
    const actor = adminActor(auth, mode, {
      orgId,
      event: null,
      templateIds: [templateId],
      timeZone: DEFAULT_TIME_ZONE,
    });
    actor.tenantAuthority = capturedAuthority;
    actor.platformSessionId = auth.sessionId;
    actor.role = role;
    await captureScanEpochs(ctx.env.DB, actor);
    const viewer = await previewActorStmt(
      ctx.env.DB,
      scanReadAuthority(actor, {
        now: ctx.clock.now(),
        templateId,
        extraChecks: capabilityChecks(previewAuthority),
      }),
    ).first<{ actor_ok: number }>();
    if (viewer?.actor_ok !== 1) throw new ForbiddenError();
    // Authorized by now, so the credential keyset may be created on first use; then it is pinned.
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
    actor.credentialKeysetCommitment = credentialKeysetCommitment;

    const candidate = await candidateById(ctx.env.DB, orgId, passId);
    if (
      !candidate ||
      candidate.pass.orgId !== orgId ||
      candidate.pass.mode !== mode ||
      candidate.pass.templateId !== templateId
    )
      throw notFound();
    if (candidate.credentialKeysetCommitment !== credentialKeysetCommitment)
      throw new UnavailableError(
        'Credential references are unavailable.',
        'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      );
    const resourceOrgId = candidate.pass.orgId;
    const found = await foundOf(ctx, candidate);
    if (!found) throw notFound();
    const release = await activeRelease(ctx, templateId, resourceOrgId, mode, 'apple');
    const active = found.activePolicy;
    if (!active || active.version !== found.activeVersion) throw notFound();
    if (release) {
      if (
        release.id !== found.activeReleaseId ||
        release.generation !== found.activeReleaseGeneration ||
        release.version !== found.activeReleaseVersion ||
        release.candidateHash !== found.activeReleaseCandidateHash
      )
        throw notFound();
    } else if (
      found.pass.releaseId !== null ||
      found.activeReleaseId !== null ||
      found.activeReleaseGeneration !== null ||
      found.activeReleaseVersion !== null ||
      found.activeReleaseCandidateHash !== null ||
      found.activeVersion !== found.pass.templateVersion ||
      found.displayTemplateVersion !== found.pass.templateVersion
    ) {
      // The candidate query and final fence prove that no scoped release history exists.
      throw notFound();
    }
    const scope = previewScope(
      ctx,
      {
        actor,
        pass: { id: passId, title: found.pass.displayTitle ?? '' },
        screen: 'ready',
      },
      found,
    );
    // The preview uses the current template, but its sources must also pass the pinned
    // template's scanner privacy policy. In particular previewScope applies additional
    // editor filtering to inputs; it must not reintroduce values the scanner would hide.
    const privacy = cardPrivacy(found, actor);
    scope.inputs = safeJson(found, actor, scope.inputs, privacy) ?? {};
    for (const key of [
      'lookups',
      'scanner',
      'goals',
      'assets',
      'templateVersion',
      'scan',
      'history',
      'event',
    ] as const) {
      const safe = safeJson(found, actor, scope[key], privacy, true);
      if (safe === undefined) delete scope[key];
      else scope[key] = safe;
    }
    const allowedFields = visibleFields(found, actor);
    const fields = scope.fields;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const key of Object.keys(fields))
        if (!Object.hasOwn(allowedFields, key)) delete fields[key];
    }
    const passScope = scope.pass;
    if (passScope && typeof passScope === 'object' && !Array.isArray(passScope)) {
      for (const [key, value] of Object.entries(passScope)) {
        if (key === 'createdAt' || key === 'validFrom' || key === 'validUntil') {
          if (value !== null && (typeof value !== 'number' || !safeTimestamp(privacy, value)))
            delete passScope[key];
        } else if (!privacy.safe(value)) {
          delete passScope[key];
        }
      }
    }
    if (typeof scope.now === 'number' && !safeTimestamp(privacy, scope.now)) delete scope.now;
    // The scope is assembled across several reads; do not return it after any of the
    // evaluated pass, template, organization, session or membership snapshots change.
    const assertCurrent = async () => {
      const stmt = previewCurrentStmt(
        ctx.env.DB,
        scanReadAuthority(actor, {
          now: ctx.clock.now(),
          templateId,
          extraChecks: capabilityChecks(previewAuthority),
        }),
        candidate,
      );
      const row = stmt ? await stmt.first<{ actor_ok: number; pass_ok: number }>() : null;
      if (row?.actor_ok !== 1) throw new ForbiddenError();
      if (row.pass_ok !== 1) throw notFound();
    };
    await assertCurrent();
    await auditStmt(ctx.env.DB, ctx, {
      orgId: resourceOrgId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'scan_display.preview',
      targetType: 'pass',
      targetId: passId,
      detail: { templateId, role: actor.role },
    }).run();
    await assertCurrent();
    return c.json({ scope }, 200, { 'cache-control': 'no-store' });
  },
);
