import { BuddyArt, type BuddyProps } from './buddy-art.tsx';
import { useScene } from './replay.ts';

export type { BuddyProps, BuddyScene } from './buddy-art.tsx';

/**
 * The mascot seated on its host's top edge (art-wallet.css): the host is position: relative and
 * leaves 11/12 of the art's height free above that edge. It falls onto the edge as it mounts. One
 * per view; decorative. Its scene runs once in view and replays on a click (replay.ts).
 */
export function Buddy({ replay, ...props }: BuddyProps) {
  const { ref } = useScene<HTMLSpanElement>(
    !props.still && (props.scene ?? 'beat') !== 'beat',
    replay,
  );
  return <BuddyArt ref={ref} {...props} />;
}
