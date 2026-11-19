import { describe, expect, it } from 'vitest';
import {
  checkJourney,
  type Journey,
  pickJourneys,
  renderIndex,
  stepFile,
  stepStem,
} from './journey.ts';

const step = (title: string) => ({ title, run: async () => ({ skip: 'x' }) });
const journey = (...titles: string[]): Journey => ({
  name: 'j',
  title: 'J',
  org: 'northwind',
  steps: titles.map(step),
});

describe('journey step ordering and naming', () => {
  it('numbers steps from 1 so files sort in the order a user saw them', () => {
    expect(stepStem(0, 'Open the designer')).toBe('01-open-the-designer');
    expect(stepStem(9, 'Hosted page (/p/:token)')).toBe('10-hosted-page-p-token');
    expect(stepFile(2, 'Delivery email', 'mobile', 'dark')).toBe(
      '03-delivery-email-mobile-dark.png',
    );
    const files = ['Issue', 'Email', 'Hosted page'].map((t, i) =>
      stepFile(i, t, 'desktop', 'light'),
    );
    expect([...files].sort()).toEqual(files);
    expect(stepStem(99, '!!!')).toBe('100-step');
  });

  it('refuses an empty journey and an untitled step', () => {
    expect(() => checkJourney(journey())).toThrow(/at least one step/);
    expect(() => checkJourney(journey('A', ' '))).toThrow(/step 2 has no title/);
    expect(() => checkJourney(journey('A', 'B', 'A'))).not.toThrow();
  });

  it('picks journeys by name in the order asked', () => {
    const all = [
      { ...journey('A'), name: 'a' },
      { ...journey('A'), name: 'b' },
    ];
    expect(pickJourneys(all, 'b,a').map((j) => j.name)).toEqual(['b', 'a']);
    expect(pickJourneys(all, 'all')).toHaveLength(2);
    expect(() => pickJourneys(all, 'c')).toThrow(/Unknown journey "c"; use a, b/);
  });

  it('renders steps in order with every viewport and theme', () => {
    const html = renderIndex(
      { name: 'j', title: 'My <journey>' },
      [
        {
          index: 0,
          title: 'First',
          stem: '01-first',
          where: '/admin',
          files: { 'mobile-light': '01-first-mobile-light.png' },
          consoleErrors: [],
          failedRequests: [],
        },
        {
          index: 1,
          title: 'Second',
          stem: '02-second',
          where: 'mail',
          files: {},
          note: 'skipped: no mail',
          consoleErrors: ['boom'],
          failedRequests: [],
        },
      ],
      ['mobile'],
      ['light', 'dark'],
    );
    expect(html).toContain('My &lt;journey&gt;');
    expect(html.indexOf('01-first-mobile-light.png')).toBeLessThan(html.indexOf('02-second'));
    expect(html).toContain('dark: none');
    expect(html).toContain('skipped: no mail');
    expect(html).toContain('<li>boom</li>');
  });
});
