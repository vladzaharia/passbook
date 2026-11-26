import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { LiveBuddy } from './live-buddy.tsx';

describe('LiveBuddy', () => {
  it('riffles while waiting, then catches happy with the envelope', () => {
    const { container, rerender } = render(<LiveBuddy found={false} />);
    const buddy = () => container.querySelector('[data-buddy]') as HTMLElement;
    expect(buddy().dataset.scene).toBe('busy');
    expect(container.querySelector('[data-env]')).toBeNull();
    rerender(<LiveBuddy found />);
    expect(buddy().dataset.scene).toBe('catch');
    expect(container.querySelector('[data-env]')?.getAttribute('opacity')).toBe('0');
    expect(container.querySelector('[data-part="joy"]')).not.toBeNull();
  });

  it('stays decorative', async () => {
    const { container } = render(<LiveBuddy found={false} />);
    expect(container.textContent).toBe('');
    expect((await axe(container)).violations).toEqual([]);
  });
});
