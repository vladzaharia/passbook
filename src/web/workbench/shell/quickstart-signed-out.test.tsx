import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import { handlers } from './test-fixtures.ts';

afterEach(() => forgetTokens());

describe('Quickstart signed out', () => {
  it('shows one Sign in: step 1 carries it, the shell adds none', async () => {
    await renderApp('/workbench/quickstart', { session: 'anon', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Quickstart', level: 1 });
    const link = await screen.findByRole('link', { name: 'Sign in with Polaris ID' });
    expect(link).toHaveAttribute(
      'href',
      `/auth/oidc/start?next=${encodeURIComponent('/workbench/quickstart#sandbox')}`,
    );
    expect(screen.getAllByRole('link', { name: 'Sign in with Polaris ID' })).toHaveLength(1);
  });
});
