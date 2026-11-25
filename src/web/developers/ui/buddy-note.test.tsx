import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import {
  BUDDY_LABEL,
  BUDDY_LINES,
  BUDDY_MAX,
  BUDDY_TONES,
  buddyLine,
  isBuddyTone,
} from '../../../shared/copy/developers-buddy.ts';
import { BuddyNote } from './buddy-note.tsx';

const TEXT = 'Verify the raw bytes.';

describe('BuddyNote', () => {
  it('has the guide callout tones: tip, gotcha and done', () => {
    expect(BUDDY_TONES).toEqual(['tip', 'gotcha', 'done']);
    expect(BUDDY_TONES.every(isBuddyTone)).toBe(true);
    expect(isBuddyTone('warning')).toBe(false);
    expect(Object.values(BUDDY_LABEL)).toEqual(['Tip', 'Watch out', 'Done']);
    expect(buddyLine('gotcha', TEXT)).toBe('Watch out: Verify the raw bytes.');
  });

  it.each(BUDDY_TONES)('%s: the art is hidden and the text is present', async (tone) => {
    const { container, getByRole } = render(
      <BuddyNote tone={tone}>
        {TEXT} Use <code>rawBody</code>.
      </BuddyNote>,
    );
    const note = getByRole('note');
    expect(note.getAttribute('data-tone')).toBe(tone);
    expect(note.textContent).toContain(BUDDY_LABEL[tone]);
    expect(note.textContent).toContain(TEXT);
    const art = note.querySelector('svg');
    expect(art?.getAttribute('aria-hidden')).toBe('true');
    expect(art?.getAttribute('focusable')).toBe('false');
    expect(note.querySelector('a, button, [tabindex]')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('gives each tone its own face', () => {
    const face = (tone: 'tip' | 'gotcha' | 'done') =>
      render(<BuddyNote tone={tone}>{TEXT}</BuddyNote>).container.querySelector('svg');
    const tip = face('tip');
    expect(tip?.getAttribute('data-mood')).toBe('neutral');
    expect(tip?.querySelector('[data-brow]')).not.toBeNull();
    const gotcha = face('gotcha');
    expect(gotcha?.getAttribute('data-mood')).toBe('curious');
    expect(gotcha?.querySelector('[data-brow]')).not.toBeNull();
    const done = face('done');
    expect(done?.getAttribute('data-mood')).toBe('happy');
    expect(done?.querySelector('[data-brow]')).toBeNull();
  });

  it('renders without JS: the server markup carries the label and the words', () => {
    const html = renderToString(<BuddyNote tone="tip">{TEXT}</BuddyNote>);
    expect(html).toContain('role="note"');
    expect(html).toContain('Tip');
    expect(html).toContain(TEXT);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-run');
  });
});

describe('the buddy copy', () => {
  const { seenInLog, noResults, ...fixed } = BUDDY_LINES;
  const lines = [
    ...Object.values(fixed),
    seenInLog(3, 'today', 'POST /passes'),
    seenInLog(1, 'today', 'GET /passes'),
    noResults('abc'),
  ];
  it('is one short sentence: no first person, no exclamation marks', () => {
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(BUDDY_MAX);
      expect(line, line).not.toMatch(/!|\bI\b|\bmy\b|\bwe\b/i);
    }
    expect(seenInLog(1, 'today', 'GET /x')).toContain('1 time ');
  });
});
