import { describe, expect, it } from 'vitest';
import { DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { HOME_GUIDES } from './home.tsx';

describe('home guides', () => {
  it('pins the four featured guides', () => {
    expect([...HOME_GUIDES]).toEqual([
      'issue-on-purchase',
      'update-a-pass',
      'check-in-at-the-door',
      'react-to-events',
    ]);
    for (const id of HOME_GUIDES) expect(DEV_GUIDES.map((g) => g.id)).toContain(id);
  });
});
