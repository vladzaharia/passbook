import { termConfigOf } from '../../../passkit/behaviors/term/index.ts';
import type { PassTermDto } from '../../../shared/contracts/pass-term.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import type { Pass } from './repo.ts';

/** The pass detail's term, read against the pass's own template version. */
export async function termOf(
  ctx: ServiceContext,
  pass: Pick<Pass, 'id' | 'orgId' | 'templateId' | 'templateVersion'>,
  passJson: { expirationDate?: unknown } | null,
): Promise<PassTermDto | null> {
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    const config = termConfigOf(template.manifest);
    if (!config) return null;
    const end = passJson?.expirationDate;
    return { input: config.start, end: typeof end === 'string' ? end : null };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.term_unavailable', { passId: pass.id, code: error.code });
    return null;
  }
}
