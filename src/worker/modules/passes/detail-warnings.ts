import { validatePass } from '../../../passkit/index.ts';
import type { PassJson, ValidationIssue } from '../../../passkit/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { brandingWarnings, readBranding } from './branding.ts';
import { resolveTemplate } from './builder.ts';
import { depsOf } from './deps.ts';
import { listAssets } from './repo-history-assets.ts';
import type { Pass } from './repo-map.ts';
import { getOrg } from './repo-read-issuance.ts';

type Issue = ValidationIssue;
const issueKey = (i: Issue) => `${i.code}\u0000${i.path ?? ''}`;

/**
 * Splits warnings: the template's own (its pass.json and images, shared by every pass) and this
 * pass's (its values, overrides and the org's branding). The pass page shows only the second.
 */
export async function warningsFor(ctx: ServiceContext, pass: Pass, passJson: PassJson) {
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    const identity = await depsOf(ctx.env).identities.byId(pass.identityId);
    const warn = (issues: Issue[]) => issues.filter((i) => i.severity !== 'error');
    const shared = warn(validatePass(template.passJson, template.assets, identity).issues);
    const known = new Set(shared.map(issueKey));
    const own = warn(validatePass(passJson, template.assets, identity).issues).filter(
      (i) => !known.has(issueKey(i)),
    );
    const [org, overrides] = await Promise.all([
      getOrg(ctx.env.DB, pass.orgId),
      listAssets(ctx.env.DB, pass.id),
    ]);
    const branding = brandingWarnings(
      pass.templateId,
      readBranding(org?.branding),
      overrides.map((a) => a.name),
    );
    return { pass: [...own, ...branding], template: shared };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.warnings_unavailable', { passId: pass.id, code: error.code });
    return { pass: [], template: [] };
  }
}
