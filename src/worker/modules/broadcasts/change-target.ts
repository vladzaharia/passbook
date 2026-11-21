import { BROADCAST_MAX_TEMPLATES } from '../../../shared/contracts/broadcasts.ts';
import type { CreateBroadcastBody } from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { selectionDrifted } from '../../../shared/contracts/pass-selection.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { targetFilter } from './apply.ts';
import { chosenPassTemplates, importTemplate } from './repo-selection.ts';
import { countTargeted } from './repo-target.ts';
import type { StoredBroadcastTarget } from './stored-target.ts';

/** A create body whose target names its templates, whether the sender chose them or the server read them off the passes. */
export type PreparedBody = Omit<CreateBroadcastBody, 'target'> & {
  target: CreateBroadcastBody['target'] & { templateIds: string[] };
};

/**
 * What the run stores: the public target plus the selection and text only the server keeps. Chosen
 * passes are not stored here (that is up to 5,000 ids on every read of the run): they are rows in
 * `broadcast_targets`, and only their source and the save's token stay.
 */
export function storedTargetOf(
  body: PreparedBody,
  save: Pick<StoredBroadcastTarget, 'selection' | 'token' | 'retryOf'> = {},
): StoredBroadcastTarget {
  const { target } = body;
  return {
    ...save,
    templateIds: target.templateIds,
    ...(target.onDevice !== undefined ? { onDevice: target.onDevice } : {}),
    ...(target.holderState ? { holderState: target.holderState } : {}),
    ...(target.q ? { q: target.q } : {}),
    ...(target.scan ? { scan: target.scan } : {}),
    ...(target.match ? { match: target.match as StoredBroadcastTarget['match'] } : {}),
    ...(target.importId ? { importId: target.importId } : {}),
    ...(target.expectCount !== undefined ? { expectCount: target.expectCount } : {}),
    ...(body.kind === 'change' && body.message ? { message: body.message } : {}),
  };
}

/**
 * Resolves a change run's selection inside the org and mode: the templates of the chosen passes or of
 * the import, and the drift check against the count the admin saw (409 `SELECTION_CHANGED` past 2%).
 */
export async function prepareTarget(
  ctx: ServiceContext,
  mode: Mode,
  body: CreateBroadcastBody,
): Promise<PreparedBody> {
  const { target } = body;
  let templateIds = target.templateIds;
  if (target.passIds) {
    // The chosen passes must all exist in this org and mode: a stranger's id reads as missing.
    const ids = [...new Set(target.passIds)];
    target.passIds = ids;
    const chosen = await chosenPassTemplates(ctx.env.DB, body.orgId, mode, ids);
    if (chosen.found !== ids.length)
      throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
    templateIds = chosen.templates;
  } else if (target.importId) {
    const imp = await importTemplate(ctx.env.DB, target.importId, body.orgId, mode);
    if (!imp) throw new NotFoundError('Import not found.', 'IMPORT_NOT_FOUND');
    // Its passes are fixed only once it has ended and not been undone.
    if (!imp.ended)
      throw new ConflictError('This import has not ended, or was undone.', 'IMPORT_NOT_ENDED');
    templateIds = [imp.template_id];
  }
  if (!templateIds?.length)
    throw new ValidationError('Choose passes to change.', [], 'BROADCAST_EMPTY');
  if (templateIds.length > BROADCAST_MAX_TEMPLATES)
    throw new ValidationError(
      `Choose passes of up to ${BROADCAST_MAX_TEMPLATES} templates.`,
      [{ path: 'target.passIds', message: 'Too many templates.' }],
      'BROADCAST_TOO_MANY_TEMPLATES',
    );
  const prepared: PreparedBody = { ...body, target: { ...target, templateIds } };
  if (target.expectCount !== undefined) {
    const count = await countSelection(ctx, mode, prepared);
    if (selectionDrifted(target.expectCount, count))
      throw new ConflictError(
        `The selection is now ${count} passes, not ${target.expectCount}. Review it again.`,
        'SELECTION_CHANGED',
      );
  }
  return prepared;
}

/** Live passes the stored selection matches now. */
function countSelection(ctx: ServiceContext, mode: Mode, body: PreparedBody): Promise<number> {
  const filter = targetFilter(
    { org_id: body.orgId, mode, target: JSON.stringify(storedTargetOf(body)) },
    null,
    1,
  );
  // The chosen passes are not in the stored target: count them as the filter's own list.
  const chosen = body.target.passIds ? { passIds: body.target.passIds } : {};
  return countTargeted(ctx.env.DB, { ...filter, ...chosen }, ctx.clock.now());
}
