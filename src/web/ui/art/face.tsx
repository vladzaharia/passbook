import { FaceArt } from './face-art.tsx';
import { useScene } from './replay.ts';

/**
 * The wallet art cropped to its head, for icon slots. sm (toasts, 24 px): no stitch, a larger
 * face. It marks a success (toasts, Status), so it is happy by default: the seated buddy's eyes,
 * smiling shut; neutral opens them; curious opens them with one brow up. `brows` raises both.
 * Scenes: scenes/face.css; cheer and post play once in view, a click replays. hop (a step
 * completed) never plays on its own: a change of `replay` plays it.
 */
export function BuddyFace({
  scene = 'wink',
  replay,
  ...props
}: {
  className?: string;
  scene?: 'wink' | 'cheer' | 'post' | 'hop';
  size?: 'sm' | 'md';
  mood?: 'happy' | 'neutral' | 'curious' | 'flat' | 'sad';
  brows?: boolean;
  replay?: unknown;
}) {
  const { ref } = useScene<SVGSVGElement>(scene === 'cheer' || scene === 'post', replay);
  return <FaceArt ref={ref} scene={scene} {...props} />;
}
