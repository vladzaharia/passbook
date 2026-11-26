import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { ExportButton, exportQuery } from './export-button.tsx';

vi.mock('@/web/admin/settings/use-org-time-zone.ts', () => ({
  useOrgTimeZone: () => 'America/Los_Angeles',
}));

installDomShims();
afterEach(() => vi.unstubAllGlobals());

describe('exportQuery', () => {
  it('carries the list filters and the window, and leaves unset ones out', () => {
    const query = exportQuery(
      'o1',
      100,
      200,
      { q: 'anna', staffId: 'st1', outcome: 'refused', reason: 'expired', range: '7d' },
      'Europe/Paris',
    );
    expect(Object.fromEntries(query)).toEqual({
      orgId: 'o1',
      from: '100',
      to: '200',
      timeZone: 'Europe/Paris',
      q: 'anna',
      staffId: 'st1',
      outcome: 'refused',
      reason: 'expired',
    });
  });
});

describe('ExportButton', () => {
  it('requests the export with the current filters and saves the file', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('Time (UTC)\r\n', {
          headers: { 'content-disposition': 'attachment; filename="scans-a-b.csv"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { container } = render(
      <ExportButton orgId="o1" from={5} search={{ staffId: 'st1', scannerId: 's1' }} />,
    );
    expect((await axe(container)).violations).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const [path] = fetchMock.mock.calls[0] as unknown as [string];
    const url = new URL(path, 'http://localhost');
    expect(url.pathname).toBe('/api/v1/scans/export');
    expect(url.searchParams.get('staffId')).toBe('st1');
    expect(url.searchParams.get('scannerId')).toBe('s1');
    expect(url.searchParams.get('from')).toBe('5');
    expect(url.searchParams.get('timeZone')).toBeTruthy();
    click.mockRestore();
  });

  it('says so when the export is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'SCAN_EXPORT_TOO_LARGE',
              detail: 'Export up to 100,000 scans at a time.',
              status: 422,
            }),
            {
              status: 422,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
      ),
    );
    render(<ExportButton orgId="o1" from={5} search={{}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
  });
});
