import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { formatShare, formatSpan } from './developer-funnel.tsx';
import { funnel, memoryStorage, ok } from './overview-fixtures.ts';

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('developer funnel tile', () => {
  it('shows each step, the completion and the time to first pass', async () => {
    const { container } = await renderApp('/admin', { session: 'admin', handlers: ok });
    const tile = await screen.findByRole('region', { name: 'Developer funnel' });
    expect(await within(tile).findByText('Last 30 days')).toBeInTheDocument();
    const rows = within(tile).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Sandboxes40',
      'Viewed quickstart32',
      'Called the API20',
      'Made a pass14',
      'Previewed it9',
    ]);
    expect(within(tile).getByText('44%')).toBeInTheDocument();
    expect(within(tile).getByText('4 min')).toBeInTheDocument();
    expect(within(tile).getByText('18 min')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says None yet before any sandbox has a pass', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/platform/developer': () =>
          json({ ...funnel, sandboxes: 0, completion: null, ttfpP50Ms: null, ttfpP90Ms: null }),
      },
    });
    const tile = await screen.findByRole('region', { name: 'Developer funnel' });
    expect(await within(tile).findAllByText('None yet')).toHaveLength(3);
  });

  it('offers a retry when the funnel fails, without hiding the rest', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: { ...ok, '/api/v1/metrics/platform/developer': () => problem(500, 'x', 'x') },
    });
    const tile = await screen.findByRole('region', { name: 'Developer funnel' });
    expect(await within(tile).findByRole('button', { name: /Retry|Try again/ })).toBeVisible();
    expect(await screen.findByRole('list', { name: 'Totals' })).toBeInTheDocument();
  });
});

describe('formatSpan and formatShare', () => {
  it('picks the unit', () => {
    expect(formatSpan(null)).toBe('None yet');
    expect(formatSpan(45_000)).toBe('45 s');
    expect(formatSpan(90_000)).toBe('2 min');
    expect(formatSpan(5_400_000)).toBe('1.5 h');
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(null)).toBe('None yet');
  });
});
