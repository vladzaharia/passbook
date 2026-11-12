import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSessionEnded } from '../lib/api.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';

afterEach(() => resetSessionEnded());

describe('SessionEndedDialog', () => {
  it('says the session ended once, and signs in again past any unsaved-changes guard', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => problem(401, 'UNAUTHENTICATED', 'Sign in.'),
        '/api/v1/me/sessions': () => problem(401, 'UNAUTHENTICATED', 'Sign in.'),
      },
    });
    const dialog = await screen.findByRole('alertdialog', { name: 'Your session ended' });
    expect(dialog).toHaveTextContent('Sign in again.');
    // Two requests failed; one dialog.
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(navigate).toHaveBeenCalledWith({
      href: '/login?reason=expired',
      reloadDocument: true,
      ignoreBlocker: true,
    });
  });

  it('stays away while requests succeed', async () => {
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json({ items: [] }),
        '/api/v1/me/sessions': () => json({ items: [] }),
      },
    });
    await screen.findByRole('heading', { name: 'Email addresses' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
