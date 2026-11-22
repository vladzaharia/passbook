import type { CreateBroadcastBody } from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeRelease } from '../templates/releases.ts';

const PREFIX = 'rollout-tell:';

/**
 * `rollout-tell:<release id>` is reserved for the console's Tell holders: a message to one template's
 * passes on a version, sent once per release for the whole organization. The server decides what is
 * shared: the key must name the template's active release in this mode, and the body must be that
 * message. Any other body using the prefix is refused. Null for an ordinary key.
 */
export async function tellHoldersKey(
  ctx: ServiceContext,
  mode: Mode,
  body: CreateBroadcastBody,
  key: string,
): Promise<string | null> {
  if (!key.startsWith(PREFIX)) return null;
  const [templateId, ...more] = body.target.templateIds ?? [];
  if (body.kind !== 'message' || !body.target.version || !templateId || more.length > 0)
    throw reserved();
  const release = await activeRelease(ctx, templateId, body.orgId, mode, 'apple');
  if (!release || key !== `${PREFIX}${release.id}` || body.target.version !== release.version)
    throw reserved();
  return key;
}

const reserved = () =>
  new ValidationError(
    'Idempotency-Key "rollout-tell:" is reserved for telling holders about a release.',
    [],
    'IDEMPOTENCY_KEY_RESERVED',
  );
