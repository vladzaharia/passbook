import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { OfflineStatus } from './offline-status.tsx';

const rows = [
  {
    key: 'a',
    at: Date.parse('2026-11-20T19:38:00'),
    method: 'camera' as const,
    door: 'listed' as const,
    tail: 'AB12',
  },
  {
    key: 'b',
    at: Date.parse('2026-11-20T19:40:00'),
    method: 'manual' as const,
    door: 'unverified' as const,
    tail: 'CD34',
  },
  {
    key: 'c',
    at: Date.parse('2026-11-20T19:41:00'),
    method: 'nfc' as const,
    door: 'refused' as const,
    tail: 'EF56',
  },
];

describe('the queue in This shift', () => {
  it('lists what is saved, each Not confirmed until the server answers', async () => {
    const onSync = vi.fn();
    render(
      <OfflineStatus
        offline={{ mode: 'list', listAt: 1, syncing: false }}
        queue={{ pending: 2, oldestAt: 1, conflicts: 0 }}
        rows={async () => rows}
        onSync={onSync}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(screen.getByText('2 waiting to sync')).toBeVisible();
    expect(screen.getByText('Code ending AB12')).toBeVisible();
    expect(screen.getByText('Not confirmed')).toBeVisible();
    expect(screen.getByText('Staff let in')).toBeVisible();
    expect(screen.getByText('Turned away')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });
  it('shows no list when nothing reads the queue', () => {
    render(
      <OfflineStatus
        offline={{ mode: 'list', listAt: 1, syncing: false }}
        queue={{ pending: 2, oldestAt: 1, conflicts: 0 }}
        onSync={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('offline-rows')).toBeNull();
  });
  it('shows the list as a row: waiting for a first download, then current', () => {
    const { rerender } = render(
      <OfflineStatus
        offline={{ mode: 'list', listAt: null, syncing: false }}
        queue={{ pending: 0, oldestAt: null, conflicts: 1 }}
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByText('No list yet. Stay online until it loads.')).toBeVisible();
    rerender(
      <OfflineStatus
        offline={{ mode: 'list', listAt: Date.parse('2026-11-20T19:38:00'), syncing: false }}
        queue={{ pending: 0, oldestAt: null, conflicts: 1 }}
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByText(/^From /)).toBeVisible();
  });
  it('shows a sync row while the queue goes up', () => {
    render(
      <OfflineStatus
        offline={{ mode: 'decide', listAt: null, syncing: true }}
        queue={{ pending: 2, oldestAt: 1, conflicts: 0 }}
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByText('Sending saved entries')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Syncing' })).toBeDisabled();
  });
});
