import { Buddy, type BuddyProps } from '../buddy.tsx';
import '../scenes/catch.css';
import '../scenes/listen-live.css';
import '../scenes/catch-live.css';

/** The lens held to the panel's edge like an ear trumpet; a ring pings out of it (hidden at rest). */
const EAR = (
  <>
    <circle data-ping="" className="a" opacity="0" cx="85" cy="60" r="5" />
    <g data-lens="">
      <path className="m f" d="M79.5 54.5 82 57" />
      <circle className="a f" cx="85" cy="60" r="5" />
    </g>
  </>
);

/** The envelope (catch.css) falls into the pocket; a check sits on the pass that peeks up. */
const PROOF = (
  <>
    <g data-env="" opacity="0">
      <rect className="o m" x="37.5" y="18.5" width="21" height="13" rx="2.5" />
      <path className="m" d="M38.8 20.4 48 26.6l9.2-6.2" />
    </g>
    <g data-check="">
      <circle cx="58" cy="6.5" r="4.6" />
      <path className="ck" d="M55.8 6.6l1.6 1.6 3-3.2" />
    </g>
  </>
);

/**
 * The webhook setup's live test (scenes/listen-live.css, catch-live.css). Listening loops while the
 * check waits; `found` swaps to the catch, which plays once and holds. Reduced motion holds the
 * still pose of each. One per view, like any Buddy.
 */
export function LiveBuddy({
  found,
  ...props
}: Omit<BuddyProps, 'scene' | 'front' | 'mood' | 'replay'> & { found: boolean }) {
  return (
    <Buddy
      {...props}
      scene={found ? 'catch-live' : 'listen-live'}
      mood={found ? 'happy' : undefined}
      front={found ? PROOF : EAR}
      replay={found ? 1 : 0}
    />
  );
}
