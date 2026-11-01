import { describe, expect, it } from 'vitest';
import { installInputModality } from './input-modality.ts';

describe('installInputModality', () => {
  it('tracks the last input device on the root element', () => {
    installInputModality();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.documentElement.dataset.modality).toBe('pointer');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.documentElement.dataset.modality).toBe('keyboard');
  });
});
