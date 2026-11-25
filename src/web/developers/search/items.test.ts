import { describe, expect, it } from 'vitest';
import { guideItem } from './items.tsx';

const doc = (id: string, kind: 'guide' | 'page') => ({
  id,
  title: 'T',
  line: 'l',
  kind,
  href: '/x',
});

describe('guideItem', () => {
  it('shows the step of a guide as its hint', () => {
    expect(guideItem(doc('go-live', 'guide'), []).hint).toBe('Launch');
    expect(guideItem(doc('scan-setup', 'guide'), []).hint).toBe('At the door');
  });

  it('keeps the page hint for a page', () => {
    expect(guideItem(doc('quickstart', 'page'), []).hint).toBe('Page');
  });
});
