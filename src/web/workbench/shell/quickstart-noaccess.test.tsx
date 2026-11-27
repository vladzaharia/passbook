import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import { handlers } from './test-fixtures.ts';

afterEach(() => forgetTokens());

describe('Quickstart for Polaris ID without the developer role', () => {
  it('words its own step 1: No developer access, the account, My passes', async () => {
    await renderApp('/workbench/quickstart', {
      session: 'user',
      handlers: {
        ...handlers({}, { sandbox: null, orgs: [] }),
        '/api/v1/developer/access': () => json({ invitedBy: [] }),
      },
    });
    await screen.findByText('No developer access');
    expect(screen.getByRole('link', { name: 'My passes' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Use another Polaris ID' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create sandbox' })).toBeNull();
  });
});
