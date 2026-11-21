import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatDay } from '../../lib/format.ts';
import { json, renderApp, sessionFixture } from '../../lib/test-utils.tsx';

const emailSession = (consoleUntil: number | null) =>
  json({ ...sessionFixture('admin'), amr: 'magic_link', consoleUntil });

describe('grace banner', () => {
  it('shows the end date and a Polaris ID button while an email session keeps the console', async () => {
    const until = Date.now() + 5 * 86_400_000;
    await renderApp('/admin', {
      session: 'admin',
      handlers: { '/api/v1/session': () => emailSession(until) },
    });
    expect(
      await screen.findByText(`Use Polaris ID by ${formatDay(until)} to keep Admin access.`),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      expect.stringContaining('/auth/oidc/start?next='),
    );
  });

  it('is absent for a Polaris ID session', async () => {
    await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/to keep Admin access/)).not.toBeInTheDocument();
  });
});
