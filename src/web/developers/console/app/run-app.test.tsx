import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunApp } from './run-app.tsx';

vi.mock('../data.ts', () => ({
  loadIndex: vi.fn(async () => ({ codes: [] })),
  loadFile: vi.fn(),
}));
vi.mock('../turnstile.ts', () => ({ verify: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe('RunApp without a ready sandbox', () => {
  it('shows an error card with Retry when the sandbox failed to read', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    const { container } = render(<RunApp session={{ kind: 'failed', csrf: 'c' }} mode="console" />);
    await screen.findByRole('button', { name: 'Retry' });
    expect(container.querySelector('.pstate')?.getAttribute('data-scene')).toBe('failed');
    expect(screen.queryByText('No sandbox yet')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows one compact empty card with Create sandbox on the console page', async () => {
    const { container } = render(
      <RunApp session={{ kind: 'none', csrf: 'c', siteKey: 's' }} mode="console" />,
    );
    await screen.findByText('No sandbox yet');
    expect(container.querySelector('.pstate')?.getAttribute('data-scene')).toBe('no-sandbox');
    expect(screen.getByRole('button', { name: 'Create sandbox' })).toBeTruthy();
    expect(container.querySelector('.ticket')).toBeNull();
  });

  it('sends an operation page to the console to make one', () => {
    render(<RunApp session={{ kind: 'none', csrf: 'c', siteKey: 's' }} mode="op" />);
    expect(screen.getByRole('link', { name: 'Create sandbox' }).getAttribute('href')).toContain(
      'console',
    );
  });
});
