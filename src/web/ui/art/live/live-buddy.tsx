import { Buddy, type BuddyProps } from '../buddy.tsx';
import '../scenes/busy.css';
import '../scenes/catch.css';

/**
 * The webhook setup's live test. While it waits the buddy riffles its passes (busy, the one loop,
 * for pending work); on arrival it catches the envelope, happy (catch, once). Reduced motion holds
 * the still pose. One per view, like any Buddy.
 */
export function LiveBuddy({
  found,
  ...props
}: Omit<BuddyProps, 'scene' | 'mood' | 'replay'> & { found: boolean }) {
  return (
    <Buddy
      {...props}
      scene={found ? 'catch' : 'busy'}
      mood={found ? 'happy' : undefined}
      replay={found ? 1 : 0}
    />
  );
}
