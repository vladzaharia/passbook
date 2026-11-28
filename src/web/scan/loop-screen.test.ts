import { describe, expect, it } from 'vitest';
import { capsuleStateOf, tintDismisses } from './loop-screen.tsx';
import { fixtureOutcome } from './machine/fixture-data.test-support.ts';

describe('capsuleStateOf', () => {
  it('puts offline over checking over paused over scanning', () => {
    expect(capsuleStateOf(false, 'checking')).toBe('offline');
    expect(capsuleStateOf(true, 'checking')).toBe('checking');
    expect(capsuleStateOf(true, 'applying')).toBe('checking');
    expect(capsuleStateOf(true, 'paused')).toBe('paused');
    expect(capsuleStateOf(true, 'ready')).toBe('scanning');
    expect(capsuleStateOf(true, 'ready', false)).toBe('ready');
    expect(capsuleStateOf(false, 'ready', false)).toBe('offline');
  });
});

describe('tintDismisses', () => {
  const heads = fixtureOutcome('heads_up', 'already_done');
  it('lets a tap on the tint dismiss a handheld verdict', () => {
    expect(tintDismisses(true, heads, false)).toBe(true);
  });
  it('not on a tablet, with nothing shown, over a sheet, or for a desk card', () => {
    expect(tintDismisses(false, heads, false)).toBe(false);
    expect(tintDismisses(true, null, false)).toBe(false);
    expect(tintDismisses(true, heads, true)).toBe(false);
    expect(tintDismisses(true, fixtureOutcome('ready', 'choose'), false)).toBe(false);
  });
  it('keeps a hold waiting for a manager until Done or the PIN', () => {
    expect(tintDismisses(true, fixtureOutcome('heads_up', 'needs_approval'), false)).toBe(false);
  });
});
