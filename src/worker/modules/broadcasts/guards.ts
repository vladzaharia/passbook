import { checkInput } from '../../../passkit/template/manifest.ts';
import {
  BROADCAST_MAX_LEAD_MS,
  type CreateBroadcastBody,
} from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import * as repo from './repo.ts';

/** Who is asking: the org they are limited to, their mode, and whether they may change passes. */
export interface BroadcastScope {
  orgScope: string | null;
  mode: Mode;
  canChange: boolean;
}

/** A broadcast of the other mode reads as missing for every write. */
export async function requireBroadcast(
  ctx: ServiceContext,
  id: string,
  orgScope: string | null,
  mode?: Mode,
) {
  const row = await repo.getBroadcast(ctx.env.DB, id, orgScope);
  if (!row || (mode !== undefined && row.mode !== mode))
    throw new NotFoundError('Message not found.', 'BROADCAST_NOT_FOUND');
  return row;
}

/** Every targeted template must exist in the org and fit what the broadcast sets. */
export async function checkTemplates(
  ctx: ServiceContext,
  body: CreateBroadcastBody,
): Promise<void> {
  for (const templateId of body.target.templateIds) {
    const { manifest } = await resolveTemplate(ctx, body.orgId, templateId);
    if (body.kind === 'message') {
      if (!manifest.messaging)
        throw new ValidationError(
          `${manifest.name} has no message field.`,
          [],
          'MESSAGING_UNSUPPORTED',
        );
      continue;
    }
    const known = new Set(Object.keys(manifest.inputs.properties ?? {}));
    const unknown = Object.keys(body.patch).find((key) => !known.has(key));
    if (unknown)
      throw new ValidationError(
        `${manifest.name} has no input "${unknown}".`,
        [{ path: `patch.${unknown}`, message: 'Unknown input.' }],
        'BROADCAST_UNKNOWN_INPUT',
      );
    // Only the keys the change sets are checked; the rest of the input is each pass's own.
    const bad = checkInput(manifest, body.patch).find((issue) =>
      Object.hasOwn(body.patch, issue.path?.split('/')[0] ?? ''),
    );
    if (bad)
      throw new ValidationError(
        `${manifest.name}: ${bad.path} ${bad.message}`,
        [{ path: `patch.${bad.path}`, message: bad.message }],
        'BROADCAST_INVALID_INPUT',
      );
  }
}

export function checkTime(ctx: ServiceContext, at: number): void {
  const now = ctx.clock.now();
  if (at <= now) throw new ValidationError('Pick a time in the future.', [], 'BROADCAST_PAST');
  if (at > now + BROADCAST_MAX_LEAD_MS)
    throw new ValidationError('Pick a time within a year.', [], 'BROADCAST_TOO_FAR');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;
export const plainLine = (text: string) => text.replace(NOT_PLAIN, ' ').replace(/\s+/g, ' ').trim();

/** The name a broadcast gets when the sender gives none: the message's first 60 characters. */
export const nameOf = (body: Pick<CreateBroadcastBody, 'name' | 'kind' | 'patch'>) =>
  body.name ??
  (body.kind === 'message'
    ? plainLine(String(body.patch.message ?? ''))
        .slice(0, 60)
        .trim() || 'Clear message'
    : 'Scheduled change');

export function assertCanChange(scope: BroadcastScope, kind: string): void {
  if (kind === 'change' && !scope.canChange)
    throw new ForbiddenError('Changing passes needs the passes:write scope.', 'MISSING_SCOPE');
}
