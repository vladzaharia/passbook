import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  type ErrorComponentProps,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { AppProviders } from '../../lib/providers.tsx';
import { createQueryClient } from '../../lib/query-client.ts';
import { membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { RouteError, ScopedDeniedPage, ScopeRefusal } from './error-pages.tsx';

async function show(node: React.ReactNode) {
  const root = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const queryClient = createQueryClient();
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await router.load();
}

describe('scope refusals', () => {
  it('names the organization and section, and offers the nearest one', async () => {
    await show(
      <ScopedDeniedPage
        orgName="Henry's"
        section="Billing"
        entry={{ to: '/admin', label: 'Passes' }}
      />,
    );
    expect(screen.getByText("Henry's: your role does not include Billing.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Passes' })).toHaveAttribute('href', '/admin');
  });

  it('falls back to this section and the account page', async () => {
    await show(<ScopedDeniedPage orgName="Henry's" section={undefined} entry={undefined} />);
    expect(
      screen.getByText("Henry's: your role does not include this section."),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Account' })).toHaveAttribute(
      'href',
      '/admin/account',
    );
  });

  it('shows a plain refusal with its way back', async () => {
    await show(<ScopeRefusal description="No access." entry={{ to: '/admin', label: 'Home' }} />);
    expect(screen.getByText('No access.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });
});

describe('route errors', () => {
  const props = (error: unknown) =>
    ({ error, reset: () => {}, info: undefined }) as unknown as ErrorComponentProps;

  it('asks for Polaris ID when the API says so', async () => {
    const error = new ApiError({ status: 401, code: 'IDP_SIGN_IN_REQUIRED', title: 'Sign in' });
    await show(<RouteError {...props(error)} />);
    expect(screen.getByRole('link', { name: /Polaris ID/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/auth/oidc/start?next='),
    );
  });

  it('shows the forbidden page for a 403', async () => {
    const error = new ApiError({ status: 403, code: 'FORBIDDEN', title: 'Forbidden' });
    await show(<RouteError {...props(error)} />);
    expect(await screen.findByRole('heading')).toBeInTheDocument();
  });

  it('keeps the shell and offers a reload when a chunk fails to load', async () => {
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/x.js');
    await show(<RouteError {...props(error)} />);
    expect(await screen.findByRole('button', { name: /Reload/ })).toBeInTheDocument();
  });

  it('shows other errors with Try again', async () => {
    const error = new ApiError({ status: 500, code: 'INTERNAL', title: 'Broke' });
    await show(<RouteError {...props(error)} />);
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

describe('not found', () => {
  it('offers the overview and search inside admin', async () => {
    await renderApp('/admin/definitely-not-a-page', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Henry', orgSlug: 'henry' })],
      selectedOrg: 'o1',
    });
    expect(await screen.findByRole('link', { name: /Overview/ })).toBeInTheDocument();
  });

  it('offers sign in to a signed-out visitor', async () => {
    await renderApp('/definitely-not-a-page', { session: 'anon' });
    expect((await screen.findAllByRole('link', { name: /Sign in/ })).length).toBeGreaterThan(0);
  });

  it('offers My passes to a signed-in holder', async () => {
    await renderApp('/definitely-not-a-page', { session: 'user' });
    expect(await screen.findByRole('link', { name: /My passes/ })).toBeInTheDocument();
  });
});
