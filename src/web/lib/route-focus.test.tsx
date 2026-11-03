import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentTitle } from './route-focus.tsx';
import { renderApp } from './test-utils.tsx';

afterEach(() => vi.restoreAllMocks());

describe('RouteAnnouncer', () => {
  it('focuses the new h1 without scrolling and announces it', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    const heading = await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
    const call = focus.mock.contexts.indexOf(heading);
    expect(focus.mock.calls[call]).toEqual([{ preventScroll: true }]);
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Settings'),
    );
  });

  it('leaves focus alone on Back and Forward, so scroll restoration holds', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin', { session: 'admin' });
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    const settings = await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await waitFor(() => expect(settings).toHaveFocus());
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    act(() => router.history.back());
    const overview = await screen.findByRole('heading', { name: 'Overview', level: 1 });
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Overview'),
    );
    expect(overview).not.toHaveFocus();
    expect(focus.mock.contexts).not.toContain(overview);
    act(() => router.history.forward());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Settings'),
    );
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('useDocumentTitle', () => {
  function Page({ title }: { title: string }) {
    useDocumentTitle(title);
    return null;
  }

  it('names the tab after the page and restores the title when the page goes', () => {
    document.title = 'PassBook';
    const { rerender, unmount } = render(<Page title="Passes" />);
    expect(document.title).toBe('Passes · PassBook');
    rerender(<Page title="Templates" />);
    expect(document.title).toBe('Templates · PassBook');
    unmount();
    expect(document.title).toBe('PassBook');
  });
});
