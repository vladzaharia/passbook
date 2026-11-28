import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../lib/test-utils.tsx';
import { goTo } from './goto.ts';

vi.mock('./goto.ts', () => ({ goTo: vi.fn() }));

beforeEach(() => {
  vi.mocked(goTo).mockClear();
  window.turnstile = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() };
});
afterEach(() => {
  window.turnstile = undefined;
});

describe('login for Developers and Admin', () => {
  it('leads with Polaris ID and says email links are for pass holders', async () => {
    await renderApp('/login?next=%2Fdevelopers', { session: 'anon' });
    const polaris = await screen.findByRole('link', { name: 'Sign in with Polaris ID' });
    expect(polaris).toHaveAttribute('href', '/auth/oidc/start?next=%2Fdevelopers');
    const email = screen.getByLabelText('Email');
    expect(polaris.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Pass holder? Email links open My passes only.')).toBeVisible();
    expect(document.activeElement).not.toBe(email);
  });

  it('keeps an email session here with the reason, Polaris ID only', async () => {
    await renderApp('/login?next=%2Fdevelopers', { session: 'user', amr: 'magic_link' });
    expect(
      await screen.findByText('Email links open My passes only. Use Polaris ID.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toBeVisible();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(goTo).not.toHaveBeenCalled();
  });

  it('still sends a Polaris ID session on', async () => {
    await renderApp('/login?next=%2Fdevelopers', { session: 'developer' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/developers'));
  });

  it.each([
    ['link', 'That pass link does not work. Sign in to see your current passes.'],
    ['pass', 'Use the email this pass was sent to.'],
  ])('says why for ?reason=%s', async (reason, line) => {
    await renderApp(`/login?reason=${reason}`, { session: 'anon' });
    expect(await screen.findByText(line)).toBeVisible();
  });
});
