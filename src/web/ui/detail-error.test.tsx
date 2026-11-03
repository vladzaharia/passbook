import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, renderApp } from '../lib/test-utils.tsx';

const org = (status: number) => () =>
  status === 404 ? problem(404, 'ORG_NOT_FOUND', 'Not found.') : problem(status, 'X', 'Boom.');

describe('detailError', () => {
  it('shows a missing item under its page header, with the way back to its list', async () => {
    await renderApp('/admin/orgs/o-gone', {
      session: 'admin',
      handlers: { '/api/v1/orgs/o-gone': org(404) },
    });
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    // The PageHeader keeps the h1; the state is not a second one.
    expect(screen.getByRole('heading', { level: 1, name: 'Organization' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Organization not found' })).toBeNull();
    const back = screen.getByRole('link', { name: 'Back to organizations' });
    expect(back).toHaveAttribute('href', '/admin/orgs');
    // Not found is the torn pass, not the error's plug.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('gives any other failure the error state with Retry', async () => {
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: { '/api/v1/orgs/o1': org(500) },
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
  });

  it('gives a refusal the forbidden page', async () => {
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: { '/api/v1/orgs/o1': org(403) },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'You do not have access' }),
    ).toBeInTheDocument();
  });
});

describe('ErrorState in a card', () => {
  it('is inline by default: no buddy inside a card', async () => {
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => problem(500, 'X', 'Boom.'),
        '/api/v1/me/sessions': () => json({ items: [] }),
      },
    });
    const card = (await screen.findByRole('heading', { name: 'Emails' })).closest(
      'div.rounded-lg',
    ) as HTMLElement;
    const alert = await within(card).findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Try again.');
    expect(card.querySelector('[data-buddy]')).toBeNull();
  });
});
