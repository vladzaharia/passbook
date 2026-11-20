import { render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useScrollCue } from './use-scroll-cue.ts';

function Box({ scroll, client, top = 0 }: { scroll: number; client: number; top?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollCue(ref);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) {
          Object.defineProperty(el, 'scrollHeight', { value: scroll, configurable: true });
          Object.defineProperty(el, 'clientHeight', { value: client, configurable: true });
          el.scrollTop = top;
        }
      }}
      data-testid="box"
    />
  );
}

describe('useScrollCue', () => {
  it('marks a box with more below, and leaves one that fits alone', () => {
    const { getByTestId, unmount } = render(<Box scroll={400} client={300} />);
    // The ref callback sizes the box after the layout effect has run once; fire a scroll to re-check.
    getByTestId('box').dispatchEvent(new Event('scroll'));
    expect(getByTestId('box')).toHaveAttribute('data-more');
    unmount();
    const fits = render(<Box scroll={300} client={300} />);
    fits.getByTestId('box').dispatchEvent(new Event('scroll'));
    expect(fits.getByTestId('box')).not.toHaveAttribute('data-more');
  });

  it('drops the mark once scrolled to the end', () => {
    const { getByTestId } = render(<Box scroll={400} client={300} top={100} />);
    getByTestId('box').dispatchEvent(new Event('scroll'));
    expect(getByTestId('box')).not.toHaveAttribute('data-more');
  });
});
