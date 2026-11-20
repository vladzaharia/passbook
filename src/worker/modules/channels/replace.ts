import { DIGITAL_CHANNELS, isDigital } from '../../../shared/channels.ts';
import type { Channel, ChannelWindow } from '../../../shared/contracts/channels.ts';
import { CHANNEL_COPY } from '../../../shared/copy/channels.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { lastRotationAt, rotatedBy } from './repo-replace.ts';
import { blockingWindow } from './windows.ts';

/**
 * The channels a "replace codes" save asks about: the digital ones the saved policy leaves off, when
 * the save changes any digital channel. Each pass narrows this to its own copies.
 */
export function replaceSet(
  policy: Partial<Record<Channel, string>>,
  changed: readonly Channel[],
): Channel[] {
  if (!changed.some(isDigital)) return [];
  return DIGITAL_CHANNELS.filter((c) => (policy[c] ?? 'on') !== 'on');
}

const unsupported = () =>
  new ConflictError(CHANNEL_COPY.replaceUnsupported, 'NEW_CODE_UNSUPPORTED');
export const refuseUnsupported = (): never => {
  throw unsupported();
};
export const refuseAllOff = (): never => {
  throw new ConflictError(CHANNEL_COPY.replaceAllOff, 'CHANNEL_REPLACE_ALL_OFF');
};

const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Refuses while an event or scanning session that admits the template is open. */
export function assertNoOpenWindow(windows: readonly ChannelWindow[]): void {
  const open = blockingWindow(windows);
  if (!open) return;
  const text =
    open.closesAt === null
      ? CHANNEL_COPY.replaceWindowOpenNoEnd.replace('{name}', open.name)
      : CHANNEL_COPY.replaceWindowOpen
          .replace('{name}', open.name)
          .replace('{time}', when(open.closesAt));
  throw new ConflictError(text, 'CHANNEL_REPLACE_WINDOW_OPEN');
}

export type RotateResult = 'rotated' | 'already' | 'unsupported' | 'inactive';

/**
 * Issues a pass's new scan code in place, once per actor id: a retry finds the rotation mark and does
 * nothing. A barcode that is not the scan code is a result, not an error. Prints are untouched.
 */
export async function rotateCode(
  ctx: ServiceContext,
  passId: string,
  actorId: string,
  authority?: TenantPassWrite,
): Promise<RotateResult> {
  if (await rotatedBy(ctx.env.DB, passId, actorId)) return 'already';
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass || pass.removedAt !== null || pass.status !== 'active') return 'inactive';
  try {
    await publishPass(ctx, {
      passId,
      cause: 'admin',
      actor: { type: 'system', id: actorId },
      force: true,
      rotateScanCode: true,
      notify: true,
      ...(authority ? { authority } : {}),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'NEW_CODE_UNSUPPORTED') return 'unsupported';
    throw error;
  }
  return 'rotated';
}

/** Tells the holder their code changed: an email when the pass has an address, else the hosted page says so. */
export async function noticeHolder(ctx: ServiceContext, passId: string): Promise<void> {
  await ctx.env.JOBS.send({
    kind: 'pass.holder_mail',
    passId,
    userId: null,
    reason: 'codes_replaced',
  });
}

/** Whether a channel was retired after the pass's last new code, so copies still scan the old one. */
export async function rotationOwed(
  db: D1Database,
  orgId: string,
  passId: string,
  retired: Partial<Record<Channel, number>>,
  channels: readonly Channel[],
): Promise<boolean> {
  const last = await lastRotationAt(db, orgId, passId);
  return last === null || channels.some((c) => (retired[c] ?? 0) > last);
}
