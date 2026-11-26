import { describe, expect, it } from 'vitest';
import { stateBadge } from './state-tone.ts';

const counts = (errors: number) => ({ rows: 4, create: 2, update: 0, unchanged: 0, errors });

describe('stateBadge', () => {
  it('reads Ready only when no row needs a fix', () => {
    expect(stateBadge({ state: 'ready', counts: counts(0) as never }).label).toBe('Ready');
    expect(stateBadge({ state: 'ready', counts: counts(2) as never })).toEqual({
      label: 'Needs a fix',
      tone: 'warning',
    });
  });

  it('keeps the other states as the server says', () => {
    expect(stateBadge({ state: 'done', counts: counts(2) as never }).label).toBe('Done');
  });
});
