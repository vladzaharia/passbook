import type { z } from 'zod';
import { PassBuildError } from '../../../passkit/build.ts';
import { stampCountOf, stampedView } from '../../../passkit/build-assets.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type {
  PreviewBatchSchema,
  PreviewRequestSchema,
  PreviewResponseSchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  appliedBranding,
  brandingWarnings,
  readBranding,
  sourceArtHashes,
  tenantPassJson,
} from '../passes/branding.ts';
import { backContactsFor, withBackContacts } from '../passes/contacts.ts';
import { issuerName } from '../passes/issuer.ts';
import { getOrg as getPassOrg } from '../passes/repo-read-issuance.ts';
import { getOrgSettings } from '../settings/service.ts';
import { defaultPassIdentity, previewPass } from './build-check.ts';
import { createTemplateRegistry } from './registry.ts';
import { getOrgName, latestVersionName } from './repo.ts';
import { loadTemplate, requireTemplateOrgRead, requireTemplateReader } from './service-access.ts';

/** Default-sample previews for several templates; one that fails or is out of reach is skipped. */
export async function previewMany(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  ids: string[],
  orgId?: string,
): Promise<z.infer<typeof PreviewBatchSchema>> {
  requireTemplateReader(auth);
  if (orgId) await requireTemplateOrgRead(ctx, auth, orgId);
  else if (auth.kind === 'session' && !auth.roles.includes('admin'))
    throw new ForbiddenError('An organization is required to preview templates.', 'ORG_REQUIRED');
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, ...(await preview(ctx, auth, id, {}, orgId)) };
      } catch (error) {
        if (error instanceof AppError && error.status < 500) return null;
        throw error;
      }
    }),
  );
  return { items: results.filter((r) => r !== null) };
}

export async function preview(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: z.infer<typeof PreviewRequestSchema>,
  orgId?: string,
): Promise<z.infer<typeof PreviewResponseSchema>> {
  if (body.orgId && orgId && body.orgId !== orgId)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  const selectedOrgId = body.orgId ?? orgId;
  const row = await loadTemplate(ctx, auth, id, selectedOrgId);
  const version =
    body.version ??
    (row.activeVersion === null ? await latestVersionName(ctx.env.DB, id) : undefined);
  if (version === undefined && row.activeVersion === null)
    throw new NotFoundError('Template has no saved version.', 'TEMPLATE_NOT_FOUND');
  const resolved: ResolvedTemplate = await createTemplateRegistry(ctx.env, { ctx }).resolve(
    id,
    version,
  );
  // A selected org brands the preview even when the body names none (the batch and released reads).
  const tenant = selectedOrgId ? await getPassOrg(ctx.env.DB, selectedOrgId) : null;
  const org = tenant ?? (row.orgId ? await getOrgName(ctx.env.DB, row.orgId) : null);
  const branding = appliedBranding(readBranding(tenant?.branding), resolved.manifest);
  const template = tenant
    ? {
        ...resolved,
        passJson: withBackContacts(
          tenantPassJson(resolved.passJson, tenant.name, branding, tenant.personal),
          await backContactsFor(ctx, tenant.id, tenant.branding),
        ),
      }
    : // No org yet: the back shows what an org without contacts gets, never an empty Contact.
      {
        ...resolved,
        passJson: withBackContacts(resolved.passJson, {
          contact: null,
          passService: null,
        }),
      };
  try {
    const result = previewPass(
      ctx.env,
      template,
      body.input ?? template.manifest.sample,
      // A shared template has no org: a placeholder, never the template's name, signs the back.
      tenant
        ? issuerName(tenant.name, tenant.personal, resolved.passJson)
        : (org?.name ?? 'Organization'),
      new Date(ctx.clock.now()),
      tenant ? (await getOrgSettings(ctx, tenant.id))['org.timeZone'] : undefined,
      await defaultPassIdentity(ctx.env),
    );
    // A stamp card shows the strip drawn for the input's count under the plain strip name.
    const input = body.input ?? template.manifest.sample;
    const stamps = stampCountOf(template, input);
    const query = new URLSearchParams({
      ...(selectedOrgId ? { orgId: selectedOrgId } : {}),
      ...(stamps !== undefined ? { stamps: String(stamps) } : {}),
    }).toString();
    return {
      passJson: result.passJson,
      warnings: [
        ...result.issues,
        ...(tenant
          ? brandingWarnings(template, branding, [], await sourceArtHashes(ctx.env.DB, template.id))
          : []),
      ],
      assetNames: [
        ...new Set([
          ...(stampedView(template, input) ?? template.assets).map((a) => a.name),
          ...(template.manifest.previewOnlyAssets ?? []),
        ]),
      ],
      assetBaseUrl: `${baseUrl(ctx.env)}/api/v1/templates/${encodeURIComponent(id)}/versions/${template.version}/assets${query ? `?${query}` : ''}`,
    };
  } catch (error) {
    if (error instanceof PassBuildError)
      throw new ValidationError(
        error.message,
        error.report.issues.map((i) => ({ path: i.path ?? '', message: i.message, code: i.code })),
        error.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'VALIDATION',
      );
    throw error;
  }
}
