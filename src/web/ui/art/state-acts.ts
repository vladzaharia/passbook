import type { BuddyScene } from './buddy-art.tsx';

export type ActedState = 'broken' | 'lost' | 'torn' | 'no-access';

/** The failures the sad buddy acts out, in the app and on SSR pages (state-art.tsx). */
export const ACTED_STATES: Record<
  ActedState,
  { scene: BuddyScene; prop?: 'unplugged' | 'torn' | 'lock'; state?: 'lost' }
> = {
  broken: { scene: 'plug', prop: 'unplugged' },
  lost: { scene: 'peek', state: 'lost' },
  torn: { scene: 'mend', prop: 'torn' },
  'no-access': { scene: 'tug', prop: 'lock' },
};
