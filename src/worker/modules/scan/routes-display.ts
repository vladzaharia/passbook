import {
  ScanDisplayPreviewQuerySchema,
  ScanDisplayPreviewSchema,
} from '../../../shared/contracts/scan-display-preview.ts';
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
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { tenantPassAuthorityValid } from '../passes/repo-authority.ts';
import { activeRelease } from '../templates/releases.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { safeJson, safeTimestamp, visibleFields } from './card-semantics.ts';
import { captureCredentialKeyset, credentialKeysetContext } from './credential-keyset-authority.ts';
import { previewScope } from './display-preview.ts';
import { cardPrivacy } from './dto-projection.ts';
import { candidateById } from './repo-lookup.ts';
import { passOutputPredicate } from './repo-output-authority.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import {
  previewCsrfStmt,
  previewPreflightAuthority,
  previewProjectionAuthority,
  previewSessionLifetime,
} from './repo-routes-display.ts';
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
      timeZone: 'UTC',
    });
    actor.tenantAuthority = capturedAuthority;
    actor.platformSessionId = auth.sessionId;
    actor.role = role;
    const csrfFence = await actorCsrfFence(ctx, actor);
    if (!csrfFence) throw new ForbiddenError();
    const lifetime = previewSessionLifetime(capturedAuthority);
    const preflightNow = ctx.clock.now();
    const credentialKeysetCommitment = await captureCredentialKeyset(
      ctx,
      previewPreflightAuthority(previewAuthority, authority, lifetime, csrfFence, preflightNow),
    );
    if (!credentialKeysetCommitment) throw new ForbiddenError();
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
          if (
            value !== null &&
            (typeof value !== 'number' || !safeTimestamp(found, actor, privacy, value))
          )
            delete passScope[key];
        } else if (!privacy.safe(value)) {
          delete passScope[key];
        }
      }
    }
    if (typeof scope.now === 'number' && !safeTimestamp(found, actor, privacy, scope.now))
      delete scope.now;
    // The scope is assembled across several reads; do not return it after any of the
    // evaluated pass, template, organization, session or membership snapshots change.
    const assertCurrent = async () => {
      const now = ctx.clock.now();
      const pass = passOutputPredicate({
        pass: found.pass,
        connectionGeneration: found.connectionGeneration,
        activeTemplateVersion: found.activeVersion,
        orgRevision: found.orgRevision,
        templateRevision: found.templateRevision,
        // Preview is an explicitly authorized pass-ID selection, not a submitted credential.
        credentialTombstoneRefs: [],
        credentialKeysetCommitment,
        release: found,
        purpose: 'read',
        displayTemplateVersion: found.displayTemplateVersion,
        checkInRules: found.checkInRules,
        requireActive: true,
        now,
      });
      const [projection, csrf] = await ctx.env.DB.batch([
        outputPredicateStmt(
          ctx.env.DB,
          previewProjectionAuthority(pass, previewAuthority, authority, lifetime, now),
        ),
        previewCsrfStmt(ctx.env.DB, csrfFence),
      ]);
      const current =
        (projection?.results?.[0] as { authorized?: number } | undefined)?.authorized === 1;
      const csrfCurrent =
        (csrf?.results?.[0] as { csrf_authorized?: number } | undefined)?.csrf_authorized === 1;
      if (!csrfCurrent) throw new ForbiddenError();
      if (!current) {
        if (
          !(await tenantPassAuthorityValid(ctx.env.DB, previewAuthority, ctx.clock.now())) ||
          !(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now()))
        )
          throw new ForbiddenError();
        throw notFound();
      }
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
