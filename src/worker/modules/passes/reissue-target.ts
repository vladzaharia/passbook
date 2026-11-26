import { NotFoundError } from '../../platform/errors.ts';
import type { ReissueParams } from './bulk-reissue-page.ts';

/**
 * What a rebuild was asked to do, kept in the operation's target so a retry runs the same action: the template,
 * the identity, the cause and an explicit version. Ids and versions hold no `~`.
 */
export function encodeReissue(x: {
  templateId?: string | undefined;
  identityId?: string | undefined;
  cause: ReissueParams['cause'];
  version?: string | undefined;
}): string {
  return [x.templateId ?? '', x.identityId ?? '', x.cause, x.version ?? ''].join('~');
}

export function decodeReissue(id: string | undefined): {
  templateId?: string;
  identityId?: string;
  cause: 'template_upgrade' | 'resign';
  version?: string;
} {
  const [templateId, identityId, cause, version] = (id ?? '').split('~');
  if ((cause !== 'resign' && cause !== 'template_upgrade') || id?.split('~').length !== 4)
    throw new NotFoundError('This run cannot be repeated.', 'OPERATION_NOT_RETRYABLE');
  return {
    cause,
    ...(templateId ? { templateId } : {}),
    ...(identityId ? { identityId } : {}),
    ...(version ? { version } : {}),
  };
}
