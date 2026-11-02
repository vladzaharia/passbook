import type { ReactNode } from 'react';
import { useScene } from './replay.ts';

/** A buddy off a box (palette, new pass): its scene runs once in view, a click replays it. */
export function Cameo({
  scene,
  auto = true,
  className,
  children,
}: {
  scene: string;
  auto?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { ref } = useScene<HTMLSpanElement>(auto);
  return (
    <span ref={ref} aria-hidden data-replay="" data-scene={scene} className={className}>
      {children}
    </span>
  );
}
