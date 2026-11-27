import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import { handlers } from './test-fixtures.ts';

afterEach(() => forgetTokens());

describe('Quickstart for an email-link session', () => {
  it('words its own step 1, Use Polaris ID, not the shell state', async () => {
    await renderApp('/workbench/quickstart', {
      session: 'developer',
      amr: 'magic_link',
      handlers: handlers(),
    });
    await screen.findByText('Use Polaris ID');
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      expect.stringContaining('/auth/oidc/start?next='),
    );
    expect(screen.queryByRole('heading', { name: 'The Workbench needs Polaris ID.' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create sandbox' })).toBeNull();
  });
});
