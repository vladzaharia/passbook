import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type GoogleClassScope, googleClassId } from './google-ids.ts';
import { GOOGLE_RESOURCES, verifyIdentity } from './google-rest.ts';
import {
  claimGoogleClassReview,
  type GoogleClassReview,
  getGoogleClassState,
  setGoogleClassReview,
} from './repo-google-class-write.ts';
import type { WalletRuntimeScope } from './runtime.ts';
import { withGoogleRest } from './runtime-google.ts';

/** A class not yet approved is read at most this often, however many operations touch it. */
export const REVIEW_RECHECK_MS = 60_000;

/** Google's value, with its legacy `underReview` spelling; anything else is unknown. */
export function parseReview(value: unknown): GoogleClassReview | null {
  const key = typeof value === 'string' ? value.toUpperCase().replace(/_/g, '') : '';
  if (key === 'UNDERREVIEW') return 'UNDER_REVIEW';
  return key === 'DRAFT' || key === 'APPROVED' || key === 'REJECTED' ? key : null;
}

/**
 * Reads Google's review of a class and stores it. Best effort and off the write path (the caller runs it
 * under `waitUntil`): a failed read is logged with a code and leaves the status unknown, and the next
 * operation that touches the class retries it. One caller reads per window (compare-and-set), and the
 * result is stored only for the body and generation that were current before the read.
 */
export async function refreshGoogleClassReview(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: { releaseId: string; type: GoogleType; classKey?: string | undefined },
): Promise<void> {
  try {
    await withGoogleRest(
      ctx,
      scope,
      undefined,
      'google-class',
      async () => {},
      async (rest, s) => {
        const classScope: GoogleClassScope = {
          tenantId: s.orgId,
          releaseId: input.releaseId,
          type: input.type,
          ...(input.classKey === undefined ? {} : { classKey: input.classKey }),
        };
        const classId = await googleClassId(
          rest.account.issuerId,
          rest.objectIdHmacKey,
          classScope,
        );
        const classIdHash = await sha256Hex(classId);
        const now = ctx.clock.now();
        const state = await getGoogleClassState(ctx.env.DB, classIdHash);
        if (
          !state ||
          !(await claimGoogleClassReview(ctx.env.DB, classIdHash, now, now - REVIEW_RECHECK_MS))
        )
          return;
        const read = await verifyIdentity(rest, GOOGLE_RESOURCES[input.type].class, classId);
        await setGoogleClassReview(
          ctx.env.DB,
          { classIdHash, ...state },
          parseReview(read.reviewStatus),
        );
      },
    );
  } catch (error) {
    ctx.log.warn('wallet.google_class_review_failed', {
      code: 'WALLET_GOOGLE_CLASS_REVIEW',
      error,
    });
  }
}
