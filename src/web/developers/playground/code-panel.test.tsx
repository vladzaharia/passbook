import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodePanel } from './code-panel.tsx';

const mount = () =>
  render(
    <CodePanel
      templateId="baked:starter-store-card"
      values={{}}
      lang="curl"
      onLang={() => {}}
      apiBase="https://passbook.mobile"
    />,
  );

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CodePanel copy button', () => {
  it('says Copied, then resets after the flash', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('leaves no pending reset timer after unmounting while it says Copied', async () => {
    const { unmount } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await act(async () => {});
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no reset timer when unmounted before the clipboard answers', async () => {
    let resolve: () => void = () => {};
    writeText.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const { unmount } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    unmount();
    await act(async () => resolve());
    expect(vi.getTimerCount()).toBe(0);
  });
});
