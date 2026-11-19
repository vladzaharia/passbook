import { afterEach, describe, expect, it, vi } from 'vitest';
import { noFiniteAnimationRunning } from './settle.ts';

const anim = (playState: string, iterations: number) => ({
  playState,
  effect: { getComputedTiming: () => ({ iterations }) },
});
const withAnimations = (list: unknown[]) =>
  vi.stubGlobal('document', { getAnimations: () => list });

afterEach(() => vi.unstubAllGlobals());

describe('noFiniteAnimationRunning', () => {
  it('is true with nothing running', () => {
    withAnimations([]);
    expect(noFiniteAnimationRunning()).toBe(true);
  });
  it('waits for a fade or slide that is still running', () => {
    withAnimations([anim('running', 1)]);
    expect(noFiniteAnimationRunning()).toBe(false);
  });
  it('ignores finished animations and endless ones such as skeleton shimmer', () => {
    withAnimations([anim('finished', 1), anim('running', Number.POSITIVE_INFINITY)]);
    expect(noFiniteAnimationRunning()).toBe(true);
  });
});
