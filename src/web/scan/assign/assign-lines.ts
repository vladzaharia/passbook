/** The words of an assign error or banner, filled with what the card knows. */
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { TAG_ERROR_COPY } from '../../../shared/copy/tags.ts';
import { formatShortDate } from '../../lib/format.ts';
import type { AssignBanner, AssignError } from '../machine/assign-state.ts';
import { fill } from '../ui/copy.ts';
import { TAG_EXTRA_COPY } from './copy.ts';

export interface Line {
  headline: string;
  sub: string;
}

/** The sub of an `already_here` error leaves out a missing date or staff name. */
export function errorLine(e: AssignError, ctx: { org: string }): Line {
  const c = SCAN_TAG_COPY.err;
  switch (e.kind) {
    case 'already_here':
      return {
        headline: c.alreadyHere.headline,
        sub: e.at
          ? fill(c.alreadyHere.sub, {
              date: formatShortDate(e.at),
              staff: e.by ?? 'staff',
            }).replace(/ by staff\.$/, '.')
          : '',
      };
    case 'lost':
      return {
        headline: c.lost.headline,
        sub: e.at ? fill(c.lost.sub, { date: formatShortDate(e.at) }) : 'An admin can restore it.',
      };
    case 'secure_needed':
      return { headline: c.secureNeeded.headline, sub: fill(c.secureNeeded.sub, { org: ctx.org }) };
    case 'failed_check':
      return { ...c.failedCheck };
    case 'unreadable':
      return {
        headline: c.unreadable.headline,
        sub: e.web ? `${c.unreadable.sub} ${c.unreadableWeb}` : c.unreadable.sub,
      };
    case 'random_id':
      return { ...c.randomId };
    case 'not_assigned':
      return { ...c.notAssigned };
    case 'too_many':
      return {
        headline: c.tooMany.headline,
        sub: fill(c.tooMany.sub, { seconds: e.seconds ?? 10 }),
      };
    case 'holder_changed':
      return { headline: c.notAssigned.headline, sub: TAG_ERROR_COPY.TAG_HOLDER_CHANGED };
    case 'needs_connection':
      return { headline: SCAN_TAG_COPY.needsConnection, sub: '' };
    case 'off':
      return { ...TAG_EXTRA_COPY.off };
    case 'limit':
      return { ...TAG_EXTRA_COPY.limit };
    case 'no_account':
      return { headline: c.notAssigned.headline, sub: '' };
    default:
      return {
        headline: c.notAssigned.headline,
        sub: e.requestId ? `Try again. Ref ${e.requestId}` : 'Try again.',
      };
  }
}

export const bannerLine = (b: AssignBanner): Line => ({ ...TAG_EXTRA_COPY.banner[b] });
