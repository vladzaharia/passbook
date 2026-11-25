import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf } from './deps.ts';

export const isNotFound = (error: unknown): boolean =>
  error instanceof NotFoundError || (error as { status?: number } | null)?.status === 404;

export async function resolveTemplate(
  ctx: ServiceContext,
  orgId: string,
  templateId: string,
  version?: string,
): Promise<ResolvedTemplate> {
  let template: ResolvedTemplate;
  try {
    template = await depsOf(ctx.env).registry.resolve(templateId, version);
  } catch (error) {
    // Only a missing template is a 404; infrastructure errors must surface and retry.
    if (!isNotFound(error)) throw error;
    ctx.log.warn('pass.template_unresolved', { orgId, templateId, error });
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  }
  // Platform templates (orgId null) are usable by every org; org templates only by their own.
  if (template.orgId !== null && template.orgId !== orgId)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  return template;
}
