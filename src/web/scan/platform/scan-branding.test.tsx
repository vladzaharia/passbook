import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanOrgLogo } from './scan-branding.tsx';

afterEach(() => vi.useRealTimers());

const SRC = `/api/v1/scan/branding/logo?v=${'a'.repeat(64)}`;

describe('organization logo', () => {
  it('shows the fallback for a refused logo and asks again later, a few times', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ScanOrgLogo src={SRC} name="Henry" className="logo" fallback={<span>H</span>} />,
    );
    const img = () => container.querySelector('img');
    expect(img()).toHaveAttribute('src', SRC);
    fireEvent.error(img() as HTMLImageElement);
    expect(img()).toBeNull();
    expect(container).toHaveTextContent('H');
    for (const attempt of [1, 2, 3]) {
      act(() => vi.advanceTimersByTime(15_000));
      expect(img()).toHaveAttribute('src', `${SRC}&retry=${attempt}`);
      fireEvent.error(img() as HTMLImageElement);
      expect(img()).toBeNull();
    }
    act(() => vi.advanceTimersByTime(60_000));
    expect(img()).toBeNull();
    // A new logo from a refreshed session is fetched at once.
    const next = `/api/v1/scan/branding/logo?v=${'b'.repeat(64)}`;
    rerender(<ScanOrgLogo src={next} name="Henry" className="logo" fallback={<span>H</span>} />);
    expect(img()).toHaveAttribute('src', next);
  });

  it('keeps a logo that loads on retry', () => {
    vi.useFakeTimers();
    const { container } = render(<ScanOrgLogo src={SRC} name="Henry" className="logo" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    act(() => vi.advanceTimersByTime(15_000));
    const img = container.querySelector('img');
    fireEvent.load(img as HTMLImageElement);
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.querySelector('img')).toHaveAttribute('src', `${SRC}&retry=1`);
  });
});
