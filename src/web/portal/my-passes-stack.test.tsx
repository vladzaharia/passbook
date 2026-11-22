import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

const list = (...items: ReturnType<typeof passFixture>[]) => json({ items, nextCursor: null });
const three = () =>
  list(
    passFixture({ id: 'a', title: 'Alpha' }),
    passFixture({ id: 'b', title: 'Bravo' }),
    passFixture({ id: 'c', title: 'Charlie' }),
  );
const one = (id: string, title: string) => () => json(passFixture({ id, title }));

/** A window from 768 px: master-detail. Reduced motion stays on, as in every web test. */
function wide() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('min-width: 768px') || query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

const front = () => document.querySelector('.wl-stack-front') as HTMLElement;

afterEach(() => vi.restoreAllMocks());

describe('the stack on a phone', () => {
  it('brings a peek forward in place: no navigation, the focus on its name', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/', { handlers: { '/api/v1/me/passes': three } });
    await screen.findByRole('heading', { name: 'Alpha', level: 2 });
    await user.click(screen.getByRole('link', { name: 'Charlie' }));
    expect(router.state.location.pathname).toBe('/');
    expect(within(front()).getByRole('heading', { name: 'Charlie' })).toBeInTheDocument();
    expect(within(front()).getByRole('link', { name: 'Charlie' })).toHaveFocus();
    // The old front is a peek again, in the list's order.
    const peeks = [...document.querySelectorAll('.wl-peek-name')].map((a) => a.textContent);
    expect(peeks).toEqual(['Alpha', 'Bravo']);
  });

  it('leaves a modified click to the browser', async () => {
    await renderApp('/', { handlers: { '/api/v1/me/passes': three } });
    await screen.findByRole('heading', { name: 'Alpha', level: 2 });
    expect(screen.getByRole('link', { name: 'Bravo' })).toHaveAttribute('href', '/passes/b');
  });

  it('sets test passes apart under a Test pill with their count', async () => {
    const { container } = await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          list(
            passFixture({ id: 't', title: 'Trial', mode: 'test' }),
            passFixture({ id: 'a', title: 'Alpha' }),
          ),
      },
    });
    // The live pass leads, though the test one is newer.
    await screen.findByRole('heading', { name: 'Alpha', level: 2 });
    const group = document.querySelector('[data-group="test"]') as HTMLElement;
    expect(within(group).getByRole('heading', { name: /Test/ })).toHaveTextContent('Test1');
    expect(within(group).getByRole('link', { name: 'Trial' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('opens Voided and expired when nothing else is there, its newest in front', async () => {
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          list(
            passFixture({ id: 'v', title: 'Void', status: 'voided' }),
            passFixture({ id: 'x', title: 'Expired', passJson: { expirationDate: '2020-01-01' } }),
          ),
      },
    });
    await screen.findByRole('heading', { name: 'Void', level: 2 });
    const details = screen.getByText(HOLDER_COPY.endedTitle).closest('details');
    expect(details).toHaveAttribute('open');
    expect(within(details as HTMLElement).getByRole('link', { name: 'Expired' })).toHaveAttribute(
      'data-dim',
    );
  });
});

describe('master-detail from 768 px', () => {
  it('shows the front pass’s page beside the stack, its heading an h2 under My passes', async () => {
    wide();
    await renderApp('/', {
      handlers: { '/api/v1/me/passes': three, '/api/v1/me/passes/a': one('a', 'Alpha') },
    });
    const heading = await screen.findByRole('heading', { level: 2, name: 'Membership' });
    expect(screen.getByRole('heading', { name: 'My passes', level: 1 })).toBeVisible();
    const panel = heading.closest('.wl-mp-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    // The stack's front carries the card, Refresh and More: the panel repeats neither.
    expect(panel.querySelector('.pc-stage')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /More/ })).toBeNull();
    expect(within(panel).queryByRole('navigation', { name: /Breadcrumb/i })).toBeNull();
  });

  it('a peek opens /passes/:id: that pass in front, its heading the h1', async () => {
    wide();
    const user = userEvent.setup();
    const { router } = await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': three,
        '/api/v1/me/passes/a': one('a', 'Alpha'),
        '/api/v1/me/passes/b': one('b', 'Bravo'),
      },
    });
    await screen.findByRole('heading', { name: 'Alpha', level: 2 });
    await user.click(screen.getByRole('link', { name: 'Bravo' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/passes/b'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Membership' })).toBeVisible();
    expect(within(front()).getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My passes' })).toHaveAttribute('href', '/');
  });

  it('leaves /passes/:id for the list when its front pass is removed', async () => {
    wide();
    const user = userEvent.setup();
    const { router } = await renderApp('/passes/b', {
      handlers: {
        '/api/v1/me/passes': three,
        '/api/v1/me/passes/b': (_url, init) =>
          init?.method === 'DELETE'
            ? json({ transferId: null, state: 'completed' })
            : one('b', 'Bravo')(),
      },
    });
    await screen.findByRole('heading', { name: 'Bravo', level: 2 });
    await user.click(within(front()).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from My passes' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('opens a pass the list does not hold on its own page', async () => {
    wide();
    await renderApp('/passes/zz', {
      handlers: {
        '/api/v1/me/passes': three,
        '/api/v1/me/passes/zz': () => problem(404, 'not_found', 'Pass not found'),
      },
    });
    expect(await screen.findByText(/not found|isn.t here|torn/i)).toBeInTheDocument();
  });
});
