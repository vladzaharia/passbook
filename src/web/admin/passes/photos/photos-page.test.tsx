import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  scope: { orgId: 'o1', membership: { capabilities: ['passes:operate'] } } as {
    orgId: string | null;
    membership: { capabilities: string[] } | null;
  },
  match: vi.fn(),
  upload: vi.fn(),
  invalidate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../settings/use-org-time-zone.ts', () => ({
  useOrgTimeZone: () => 'America/Los_Angeles',
}));
vi.mock('../../../lib/org-filter.tsx', () => ({ useOrgScope: () => m.scope }));
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<object>()),
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock('../../../ui/index.ts', async (orig) => ({
  ...(await orig<object>()),
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  toast: m.toast,
}));
vi.mock('@/web/ui/layout/org-chooser.tsx', () => ({
  OrgChooser: () => <h1>Choose an organization</h1>,
}));
vi.mock('./photo-batch.ts', async (orig) => ({
  ...(await orig<object>()),
  matchEntries: m.match,
  uploadEntry: m.upload,
}));

import { PhotosPage } from './photos-page.tsx';

const png = (name: string) => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
  vi.clearAllMocks();
  m.scope = { orgId: 'o1', membership: { capabilities: ['passes:operate'] } };
});

describe('PhotosPage', () => {
  it('asks for an organization, and for the right to change passes', () => {
    m.scope = { orgId: null, membership: null };
    const { rerender } = render(<PhotosPage />);
    expect(screen.getByRole('heading', { name: 'Choose an organization' })).toBeInTheDocument();
    m.scope = { orgId: 'o1', membership: { capabilities: [] } };
    rerender(<PhotosPage />);
    expect(screen.getByText('You cannot change passes in this organization.')).toBeInTheDocument();
  });

  it('matches the chosen photos, uploads the matched ones, and says how it went', async () => {
    m.match.mockImplementation(async (_org: string, entries: { key: string }[]) =>
      entries.map((e, i) =>
        i === 0 ? { ...e, state: 'matched', passId: 'p1' } : { ...e, state: 'none' },
      ),
    );
    m.upload.mockImplementation(async (e: object) => ({ ...e, state: 'done' }));
    render(<PhotosPage />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Drop photos or choose'), [png('a.png'), png('b.png')]);
    expect(await screen.findByText('2 files')).toBeInTheDocument();
    expect(screen.getByText('No pass')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Include photos/ }));
    await user.click(await screen.findByRole('button', { name: 'Upload 1' }));
    expect((await screen.findAllByText('Photos uploaded')).length).toBeGreaterThan(0);
    expect(m.upload).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }), true);
    expect(m.invalidate).toHaveBeenCalled();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Import photos' })).toHaveTextContent(
      'Upload photos (done)',
    );
  });

  it('counts a failed upload and offers to send it again', async () => {
    m.match.mockImplementation(async (_o: string, entries: object[]) =>
      entries.map((e) => ({ ...e, state: 'matched', passId: 'p1' })),
    );
    m.upload.mockImplementation(async (e: object) => ({ ...e, state: 'failed', error: 'Too big' }));
    render(<PhotosPage />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Drop photos or choose'), png('a.png'));
    await user.click(await screen.findByRole('button', { name: 'Upload 1' }));
    expect((await screen.findAllByText('Could not import the photos')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByText('Too big')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload 1' })).toBeEnabled();
  });

  it('reports a match that failed, and clears the list', async () => {
    m.match.mockRejectedValue(new Error('down'));
    render(<PhotosPage />);
    await userEvent.setup().upload(screen.getByLabelText('Drop photos or choose'), png('a.png'));
    expect((await screen.findAllByText('Could not import the photos')).length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Import photos' })).toHaveTextContent(
      'Match files to passes (failed)',
    );
    expect(screen.queryByText('1 files')).toBeNull();
  });
});
