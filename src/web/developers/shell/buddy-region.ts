/**
 * The portal's buddy rules, in one place: one buddy per region, at most two in view, and one scene
 * playing at a time. A page's buddies join a region on mount; a refused one renders nothing, or
 * stays still. Plain TS with no DOM or React, so islands, the shell and tests share it.
 */
export type BuddyRegionName = 'band' | 'main' | 'stage' | 'overlay' | 'toast';

export const MAX_IN_VIEW = 2;
/** A scene lasts 3.2 s at most and starts 700 ms after landing; the lock frees itself by then. */
export const PLAY_LOCK_MS = 4000;

export interface BuddySlot {
  /** false: another buddy holds this region. Render nothing. */
  readonly allowed: boolean;
  /** Report visibility. Returns false (and counts nothing) when two others are already in view. */
  inView(visible: boolean): boolean;
  /** Take the one playing turn. Returns the release, or null when another scene is playing. */
  play(): (() => void) | null;
  /** Leave the region; call on unmount. */
  release(): void;
}

const holders = new Map<BuddyRegionName, symbol>();
const visible = new Set<symbol>();
let player: symbol | null = null;
let playTimer: ReturnType<typeof setTimeout> | undefined;

const free = (token: symbol) => {
  if (player !== token) return;
  player = null;
  clearTimeout(playTimer);
};

export function joinRegion(region: BuddyRegionName): BuddySlot {
  const token = Symbol(region);
  const allowed = !holders.has(region);
  if (allowed) holders.set(region, token);
  return {
    allowed,
    inView(on) {
      if (!allowed) return false;
      if (!on) {
        visible.delete(token);
        return true;
      }
      if (!visible.has(token) && visible.size >= MAX_IN_VIEW) return false;
      visible.add(token);
      return true;
    },
    play() {
      if (!allowed || (player !== null && player !== token)) return null;
      player = token;
      clearTimeout(playTimer);
      playTimer = setTimeout(() => free(token), PLAY_LOCK_MS);
      return () => free(token);
    },
    release() {
      if (!allowed) return;
      free(token);
      visible.delete(token);
      if (holders.get(region) === token) holders.delete(region);
    },
  };
}

/** Test seam: forget every region, view and player. */
export function resetBuddyRegions(): void {
  holders.clear();
  visible.clear();
  player = null;
  clearTimeout(playTimer);
}
