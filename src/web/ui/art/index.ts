import { createElement, lazy, type ReactNode, Suspense } from 'react';
import { type ArtProps, DIM } from './base.tsx';
import type { WalletState } from './wallet.tsx';

export type { ArtProps, ArtSize } from './base.tsx';
export { Buddy, type BuddyProps } from './buddy.tsx';
export { BuddyFace } from './face.tsx';
export { LensOverlay } from './lens.tsx';
export { WalletArt, type WalletArtProps, type WalletMood, type WalletState } from './wallet.tsx';

export const ART_NAMES = [
  'passes',
  'template',
  'plugs',
  'people',
  'building',
  'certificate',
  'key',
  'log',
  'activity',
  'pulse',
  'runs',
  'phone',
  'envelope',
  'frames',
  'layers',
  'mapping',
  'lens',
  'torn',
  'lock',
  'unplugged',
  'wallet',
] as const;
export type ArtName = (typeof ART_NAMES)[number];
export type EntityArtProps = ArtProps & { name: ArtName; state?: WalletState };

/** A blank slot the art's size: while the registry loads, or for good if it cannot. */
function Slot({ size = 'lg' }: EntityArtProps): ReactNode {
  const [width, height] = DIM[size];
  return createElement('svg', { className: 'wl-art', width, height, 'aria-hidden': true });
}

// The registry (registry.ts) is its own chunk, off the initial budget: its load starts with the
// app and is usually done before a state screen renders. The art is decorative, so a failed load
// keeps the blank slot instead of failing the page.
let registry: typeof import('./registry.ts') | undefined;
export const preloadArt = () =>
  import('./registry.ts').then(
    (m) => {
      registry = m;
      return m.RegisteredArt;
    },
    () => Slot,
  );
const Lazy = lazy(() => preloadArt().then((component) => ({ default: component })));
void preloadArt();

export function EntityArt(props: EntityArtProps): ReactNode {
  if (registry) return createElement(registry.RegisteredArt, props);
  return createElement(
    Suspense,
    { fallback: createElement(Slot, props) },
    createElement(Lazy, props),
  );
}
