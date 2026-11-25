import { useScene } from './replay.ts';
import { BODY, JOY, pass, SCREEN, SMILE, STITCH } from './wallet.tsx';

/** The mouths of the status moods (Status page: degraded, down). */
const MOUTH = { flat: 'M45 48.6h6', sad: 'M44.8 50q3.2-2.8 6.4 0' } as const;

const fan = (n: 1 | 2 | 3, angle: number, tag = 'data-c') => (
  <g transform={`rotate(${angle} 48 64)`}>
    <g {...{ [tag]: '' }}>{pass(n)}</g>
  </g>
);

/**
 * The wallet art cropped to its head, for icon slots. sm (toasts, 24 px): no stitch, a larger
 * face. It marks a success (toasts, Status), so it is happy by default: the seated buddy's eyes,
 * smiling shut; neutral opens them; curious opens them with one brow up. `brows` raises both.
 * Scenes: scenes/face.css; cheer and post play once in view, a click replays. hop (a step
 * completed) never plays on its own: a change of `replay` plays it.
 */
export function BuddyFace({
  className,
  scene = 'wink',
  size = 'sm',
  mood = 'happy',
  brows,
  replay,
}: {
  className?: string;
  scene?: 'wink' | 'cheer' | 'post' | 'hop';
  size?: 'sm' | 'md';
  mood?: 'happy' | 'neutral' | 'curious' | 'flat' | 'sad';
  brows?: boolean;
  replay?: unknown;
}) {
  const { ref } = useScene<SVGSVGElement>(scene === 'cheer' || scene === 'post', replay);
  const sm = size === 'sm';
  const eye = sm ? { rx: 2.1, ry: 2.5 } : { rx: 1.7, ry: 2.1 };
  return (
    <svg
      ref={ref}
      viewBox={sm ? '14 12 68 56' : '14 7 68 61'}
      className={className ? `wl-art wl-face ${className}` : 'wl-art wl-face'}
      data-replay=""
      data-scene={scene}
      data-size={size}
      data-mood={mood}
      aria-hidden="true"
      focusable="false"
    >
      <g data-body="">
        {fan(1, -18)}
        {fan(3, 18, 'data-thumb')}
        {fan(2, 0, 'data-letter')}
        {BODY}
        {sm ? null : STITCH}
        <g transform={sm ? 'matrix(1.3 0 0 1.3 -14.4 -13.5)' : undefined}>
          {SCREEN}
          <g data-look="">
            {mood === 'happy' ? (
              <>
                <path className="m" d={JOY[0]} />
                <path className="m" data-wink="" d={JOY[1]} />
              </>
            ) : (
              <>
                <ellipse className="e" cx="43.5" cy="43.5" {...eye} />
                <ellipse className="e" data-wink="" cx="52.5" cy="43.5" {...eye} />
              </>
            )}
            {mood === 'curious' ? (
              <path className="m" data-brow="" d="M41.8 39.8l2.8-.4M51.6 38l3 .9" />
            ) : mood === 'sad' ? (
              <path className="m" data-brow="" d="M41 40.6l3.2-1.4M51.8 39.2l3.2 1.4" />
            ) : brows ? (
              <path className="m" data-brow="" d="M41.6 39.4q2-1.3 4 0M50.4 39.4q2-1.3 4 0" />
            ) : null}
          </g>
          <path
            className="m"
            data-smile=""
            d={
              mood === 'flat' || mood === 'sad'
                ? MOUTH[mood]
                : sm
                  ? 'M44.6 47.4q3.4 2.6 6.8 0'
                  : SMILE
            }
          />
        </g>
      </g>
    </svg>
  );
}
