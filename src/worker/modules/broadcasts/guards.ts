import { checkInput } from '../../../passkit/template/manifest.ts';
import { BROADCAST_MAX_LEAD_MS } from '../../../shared/contracts/broadcasts.ts';
import {
  type CreateBroadcastBody,
  changeActionOf,
  changeOpsOf,
} from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { inputFields } from '../../../shared/issuing/fields.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { assertWritableMode, type PassScope, type ScopeArg } from '../passes/scope.ts';
import { activeRelease } from '../templates/releases.ts';
import { opMisfit, tokensOf } from './change-ops.ts';
import type { PreparedBody } from './change-target.ts';
import * as repo from './repo.ts';

/** Authorized tenant and mode, pass-change scope, and the write authority to fence mutations. */
export interface BroadcastScope extends PassScope {
  canChange: boolean;
  authority: TenantPassWrite;
}

/** By-id read: an API key sees only its own mode, a session either. */
export async function requireBroadcast(ctx: ServiceContext, id: string, scope: ScopeArg) {
  const row = await repo.getBroadcast(ctx.env.DB, id, scope);
  if (!row) throw new NotFoundError('Message not found.', 'BROADCAST_NOT_FOUND');
  return row;
}

/** By-id write: the other mode is 404 for an API key and 409 MODE_MISMATCH for a session. */
export async function requireWritableBroadcast(ctx: ServiceContext, id: string, scope: ScopeArg) {
  const row = await requireBroadcast(ctx, id, scope);
  assertWritableMode(scope, row.mode, 'broadcast');
  return row;
}

/** Every targeted template must exist in the org and fit what the broadcast sets. */
export async function checkTemplates(
  ctx: ServiceContext,
  body: PreparedBody,
  mode: Mode = 'live',
): Promise<void> {
  const action = body.kind === 'change' ? changeActionOf(body.patch) : null;
  const defined = new Set<string>();
  for (const templateId of body.target.templateIds) {
    const { manifest } = await resolveTemplate(ctx, body.orgId, templateId);
    for (const key of Object.keys(manifest.inputs.properties ?? {})) defined.add(key);
    if (body.kind === 'message') {
      if (!manifest.messaging)
        throw new ValidationError(
          `${manifest.name} has no message field.`,
          [],
          'MESSAGING_UNSUPPORTED',
        );
      continue;
    }
    if (action) {
      // Latest design moves passes to the template's approved release: without one there is nothing to move to.
      if (action === 'design' && !(await activeRelease(ctx, templateId, body.orgId, mode, 'apple')))
        throw new ValidationError(
          `${manifest.name} has no approved design to move to.`,
          [],
          'BROADCAST_NO_RELEASE',
        );
      continue;
    }
    const known = new Set(Object.keys(manifest.inputs.properties ?? {}));
    const { ops } = changeOpsOf(body.patch);
    const unknown = Object.keys(ops).find((key) => !known.has(key));
    if (unknown)
      throw new ValidationError(
        `${manifest.name} has no input "${unknown}".`,
        [{ path: `patch.${unknown}`, message: 'Unknown input.' }],
        'BROADCAST_UNKNOWN_INPUT',
      );
    const fields = inputFields(manifest.inputs);
    for (const [key, op] of Object.entries(ops)) {
      const field = fields.find((f) => f.key === key);
      const misfit = field ? opMisfit(field, op) : null;
      if (misfit)
        throw new ValidationError(
          `${manifest.name}: ${misfit}`,
          [{ path: `patch.${key}`, message: misfit }],
          'BROADCAST_INVALID_OP',
        );
    }
    const unlabeled = tokensOf(body.message ?? '').find(
      (t) => !fields.some((f) => f.label.toLowerCase() === t.toLowerCase()),
    );
    if (unlabeled)
      throw new ValidationError(
        `${manifest.name} has no field "${unlabeled}".`,
        [{ path: 'message', message: 'Unknown field.' }],
        'BROADCAST_UNKNOWN_TOKEN',
      );
    // Only the values the change sets are checked; the rest of the input is each pass's own.
    const setValues = Object.fromEntries(
      Object.entries(ops).flatMap(([key, op]) => ('set' in op ? [[key, op.set]] : [])),
    );
    const bad = checkInput(manifest, setValues).find((issue) =>
      Object.hasOwn(setValues, issue.path?.split('/')[0] ?? ''),
    );
    if (bad)
      throw new ValidationError(
        `${manifest.name}: ${bad.path} ${bad.message}`,
        [{ path: `patch.${bad.path}`, message: bad.message }],
        'BROADCAST_INVALID_INPUT',
      );
  }
  const unknownMatch = body.target.match?.find((clause) => !defined.has(clause.input));
  if (unknownMatch)
    throw new ValidationError(
      `No targeted template has an input "${unknownMatch.input}".`,
      [{ path: 'target.match', message: 'Unknown input.' }],
      'BROADCAST_UNKNOWN_INPUT',
    );
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
