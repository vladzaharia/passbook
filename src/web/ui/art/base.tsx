import { type ReactNode, useEffect, useId, useRef } from 'react';
import './art.css';
import './art-records.css';
import './art-details.css';
import './art-wallet.css';

export type ArtSize = 'sm' | 'lg' | 'xl';

export interface ArtProps {
  /** lg 96×72, sm 64×48, xl 112×84 (sign-in). */
  size?: ArtSize;
  className?: string;
  /** false: no idle beat or hover replay. */
  beat?: boolean;
  /** Final frame only. */
  still?: boolean;
}

const DIM = { sm: [64, 48], lg: [96, 72], xl: [112, 84] } as const;

// No DOM lib in the Worker typecheck (SSR renders the wallet).
type El = { closest(s: string): EventTarget | null; dataset: Record<string, string | undefined> };
const mq = (q: string) =>
  (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia?.(q).matches;

/** Fine pointers: hovering the [data-art-host] replays the beat. */
function useBeatReplay(ref: { current: unknown }, on: boolean) {
  useEffect(() => {
    const svg = ref.current as El | null;
    if (!on || !svg || !mq('(hover: hover) and (pointer: fine)')) return;
    if (mq('(prefers-reduced-motion: reduce)')) return;
    const host = svg.closest('[data-art-host]');
    if (!host) return;
    // Alternating keyframe names restart the beat.
    const replay = () => {
      svg.dataset.beat = svg.dataset.beat === 'a' ? 'b' : 'a';
    };
    host.addEventListener('pointerenter', replay);
    return () => host.removeEventListener('pointerenter', replay);
  }, [ref, on]);
}

export function Art({
  name,
  size = 'lg',
  className,
  beat = true,
  still = false,
  state,
  pose,
  children,
}: ArtProps & { name: string; state?: string; pose?: string; children: ReactNode }) {
  const ref = useRef<SVGSVGElement>(null);
  useBeatReplay(ref, beat);
  const [w, h] = DIM[size];
  return (
    <svg
      ref={ref}
      data-art={name}
      data-state={state}
      data-pose={pose}
      data-beat={beat ? undefined : 'off'}
      data-still={still || undefined}
      className={className ? `wl-art ${className}` : 'wl-art'}
      viewBox="0 0 96 72"
      width={w}
      height={h}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function useFoilId(): string {
  return `wf${useId().replace(/[^\w-]/g, '')}`;
}

/** Foil gradient for the hero's 2 px top edge. */
export function Foil({ id, x1, x2 }: { id: string; x1: number; x2: number }) {
  return (
    <defs>
      <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x1} x2={x2}>
        <stop className="c1" />
        <stop className="c2" offset=".55" />
        <stop className="c3" offset="1" />
      </linearGradient>
    </defs>
  );
}

export const Edge = ({ id, x, y, w }: { id: string; x: number; y: number; w: number }) => (
  <path className="f" stroke={`url(#${id})`} d={`M${x + 2.5} ${y}H${x + w - 2.5}`} />
);

export const bars = (x: number, y: number) => `M${x} ${y}v4m3-4v4m2-4v4m3-4v4m2-4v4m3-4v4m2-4v4`;
