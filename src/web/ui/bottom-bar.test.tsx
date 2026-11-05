import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBottomBar } from './bottom-bar.ts';

function Bar({ height }: { height: number }) {
  const ref = useBottomBar<HTMLDivElement>();
  return (
    <div
      ref={(el) => {
        if (el) Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
        ref(el);
      }}
    />
  );
}
const read = () => document.documentElement.style.getPropertyValue('--wl-bottom-bar');

describe('useBottomBar', () => {
  it('publishes the tallest bar and clears it when the bars leave', () => {
    const one = render(<Bar height={72} />);
    expect(read()).toBe('72px');
    const two = render(<Bar height={104} />);
    expect(read()).toBe('104px');
    two.unmount();
    expect(read()).toBe('72px');
    one.unmount();
    expect(read()).toBe('');
  });
});
