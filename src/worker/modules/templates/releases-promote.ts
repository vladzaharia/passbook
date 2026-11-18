import type {
  PromoteTemplate,
  TemplateCandidate,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeTemplateWrite } from './access.ts';
import { createCandidate } from './releases-create.ts';
import { scopedTemplate, writable } from './releases-domain.ts';
import { testReleasedVersions } from './repo-sole-reviewer.ts';

/** Live takes a version already released in Test: a new Live candidate for the same version. */
export async function promoteToLive(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: PromoteTemplate,
): Promise<TemplateCandidate> {
  const template = await scopedTemplate(ctx, auth, templateId, body);
  writable(template, body);
  await authorizeTemplateWrite(ctx, auth, body.orgId, 'templates:author');
  if (!(await testReleasedVersions(ctx.env.DB, templateId, body.orgId)).includes(body.version))
    throw new ConflictError(
      'This version has not been released in Test. Release it in Test first.',
      'TEMPLATE_NOT_TESTED',
    );
  return createCandidate(ctx, auth, templateId, body);
}
