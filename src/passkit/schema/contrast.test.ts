import { describe, expect, it } from 'vitest';
import { run } from './rules-helpers.ts';
import { CONTRAST_MIN, contrastRatio, shownRatio } from './validate-hig.ts';

const WHITE = 'rgb(255, 255, 255)';

describe('contrast', () => {
  it('floors the shown ratio so a failing 4.48 never reads as 4.5', () => {
    const ratio = contrastRatio(WHITE, 'rgb(119, 119, 119)') ?? 0;
    expect(ratio).toBeGreaterThan(4.4);
    expect(ratio).toBeLessThan(CONTRAST_MIN.text);
    expect(shownRatio(ratio)).toBe('4.4');
    expect(shownRatio(4.5)).toBe('4.5');
  });

  it('puts the floored ratio in the message', () => {
    const issue = run('generic', (p) => {
      p.backgroundColor = WHITE;
      p.foregroundColor = 'rgb(119, 119, 119)';
    }).issues.find((i) => i.code === 'COLOR_CONTRAST');
    expect(issue?.message).toBe('Text contrast is 4.4:1; use at least 4.5:1.');
  });

  it('is undefined for a color it cannot read', () => {
    expect(contrastRatio(WHITE, '#777')).toBeUndefined();
  });
});

describe('messaging field', () => {
  it('is not flagged as free text: it exists to show the whole message', () => {
    const codes = run('generic', (p) => {
      p.generic.backFields.push({
        key: 'message',
        label: 'Message',
        value: '',
        changeMessage: '%@',
      });
    }).issues.map((i) => i.code);
    expect(codes).not.toContain('CHANGE_MESSAGE_FREE_TEXT');
  });
});
