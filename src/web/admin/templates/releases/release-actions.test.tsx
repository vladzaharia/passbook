import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { problem } from '../../../lib/test-utils.tsx';
import { pickRowAction, releasesLoaded } from './row-actions.ts';
import { mountPanel, OLD_HASH, release, releaseServer, SCOPE } from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

describe('template release actions', () => {
  it('lists a version with its release badges and date, ids in its side sheet', async () => {
    const user = userEvent.setup();
    const active = release({
      id: 'active-release-id',
      generation: 4,
      mode: 'test',
      version: 'version-2',
    });
    releaseServer({ active, history: [active] });
    mountPanel({ mode: 'test' });
    const list = await screen.findByRole('list', { name: 'Versions' });
    await releasesLoaded();
    const row = within(list).getAllByRole('listitem')[0];
    if (!row) throw new Error('Version row missing');
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('Live');
    expect(row).toHaveTextContent('Test');
    expect(row).toHaveTextContent(/Released/);
    expect(within(list).queryByText('Technical details')).not.toBeInTheDocument();
    await pickRowAction(user, 'v2', 'Technical details');
    const sheet = await screen.findByRole('dialog', { name: 'v2 details' });
    for (const value of ['4', OLD_HASH])
      expect(within(sheet).getAllByText(value).length).toBeGreaterThan(0);
  });

  it('requires a reason and rolls back an earlier approved release as a new generation', async () => {
    const user = userEvent.setup();
    const earlier = release({ id: 'release-earlier', generation: 2, candidateHash: OLD_HASH });
    const head = release({ id: 'release-head', version: 'version-2', generation: 5 });
    const server = releaseServer({ active: head, history: [earlier, head] });
    mountPanel();
    await pickRowAction(user, 'v1', 'Restore');
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1' });
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('maxlength', '500');
    expect(within(dialog).getByText('5')).toBeInTheDocument();
    expect(within(dialog).getByText('6')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Restore' });
    expect(confirm).toBeDisabled();
    await user.type(reason, '   ');
    expect(confirm).toBeDisabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    await user.clear(reason);
    await user.type(reason, '  Barcode regression  ');
    await user.click(confirm);

    await waitFor(() => expect(server.active?.id).toBe('release-rollback'));
    const post = server.requests.find((request) =>
      request.url.pathname.endsWith('/releases/rollback'),
    );
    expect(post?.method).toBe('POST');
    expect(post?.body).toEqual({
      ...SCOPE,
      releaseId: 'release-earlier',
      candidateHash: OLD_HASH,
      expectedGeneration: 5,
      reason: 'Barcode regression',
    });
    expect(post?.headers.get('x-passbook-mode')).toBe('live');
    expect(post?.headers.get('x-csrf-token')).toBe('csrf-token');
    expect(server.active).toMatchObject({
      id: 'release-rollback',
      generation: 6,
      version: earlier.version,
      action: 'rollback',
    });
    expect(
      server.requests.filter(
        (request) => request.method === 'GET' && request.url.pathname.endsWith('/releases'),
      ).length,
    ).toBeGreaterThan(1);
  });

  it('keeps the rollback reason visible when the generation conflicts', async () => {
    const user = userEvent.setup();
    const earlier = release({ id: 'earlier', generation: 1 });
    const head = release({ id: 'head', generation: 4, version: 'version-2' });
    const server = releaseServer({
      active: head,
      history: [head, earlier],
      rollbackError: () =>
        problem(
          409,
          'TEMPLATE_RELEASE_CONFLICT',
          'The template release changed. Reload and retry.',
        ),
    });
    mountPanel();
    await pickRowAction(user, 'v1', 'Restore');
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1' });
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    await user.type(reason, 'Restore the previous build');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The template release changed. Reload and retry.',
    );
    expect(reason).toHaveValue('Restore the previous build');
    const posts = server.requests.filter(
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/releases/rollback'),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      expectedGeneration: 4,
      reason: 'Restore the previous build',
    });
  });

  it('restores an archived template by rolling its approved head into a new generation', async () => {
    const user = userEvent.setup();
    const head = release({ id: 'release-head', generation: 5 });
    const server = releaseServer({ active: null, history: [head] });
    mountPanel({ templateStatus: 'archived' });
    await pickRowAction(user, 'v1', 'Restore');
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Restore the archived template',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(server.active?.id).toBe('release-rollback'));
    const post = server.requests.find((request) =>
      request.url.pathname.endsWith('/releases/rollback'),
    );
    expect(post?.body).toEqual({
      ...SCOPE,
      releaseId: 'release-head',
      candidateHash: head.candidateHash,
      expectedGeneration: 5,
      reason: 'Restore the archived template',
    });
    expect(server.active).toMatchObject({
      id: 'release-rollback',
      previousReleaseId: 'release-head',
      generation: 6,
      action: 'rollback',
    });
  });

  it('never offers Restore on the version that is Live now', async () => {
    const user = userEvent.setup();
    const older = release({ id: 'older', generation: 1, version: 'version-2' });
    const head = release({ id: 'head', generation: 3, version: 'version-2' });
    releaseServer({ active: head, history: [older, head] });
    mountPanel();
    await screen.findByRole('list', { name: 'Versions' });
    await releasesLoaded();
    await user.click(screen.getByRole('button', { name: 'Actions for v2' }));
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('names who released a version and marks a restore in its details', async () => {
    const user = userEvent.setup();
    const restored = release({ id: 'r', generation: 2, action: 'rollback', version: 'version-2' });
    releaseServer({ active: restored, history: [restored] });
    mountPanel();
    await pickRowAction(user, 'v2', 'Technical details');
    const sheet = await screen.findByRole('dialog', { name: 'v2 details' });
    expect(within(sheet).getByText('Released by')).toBeInTheDocument();
    expect(within(sheet).getByText('Pia Publisher')).toBeInTheDocument();
    expect(within(sheet).getByText('Restored')).toBeInTheDocument();
  });
});
