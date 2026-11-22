import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { problem } from '../../../lib/test-utils.tsx';
import { mountPanel, OLD_HASH, release, releaseServer, SCOPE } from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

describe('template release actions', () => {
  it('lists the release by version and publisher, with ids under technical details', async () => {
    const user = userEvent.setup();
    const active = release({
      id: 'active-release-id',
      generation: 4,
      mode: 'test',
      version: 'version-2',
    });
    releaseServer({ active, history: [active] });
    mountPanel({ mode: 'test' });
    const timeline = await screen.findByRole('list', { name: 'Releases' });
    const row = within(timeline).getAllByRole('listitem')[0];
    if (!row) throw new Error('Release row missing');
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('Pia Publisher');
    const disclosure = within(row).getByText('Technical details');
    const details = disclosure.closest('details');
    expect(details).not.toHaveAttribute('open');
    await user.click(disclosure);
    expect(details).toHaveAttribute('open');
    for (const value of ['4', OLD_HASH])
      expect(within(row).getAllByText(value).length).toBeGreaterThan(0);
  });

  it('names an unknown publisher plainly, never by id', async () => {
    const active = release({ createdBy: 'user-uuid', createdByName: null });
    releaseServer({ active, history: [active] });
    mountPanel();
    const timeline = await screen.findByRole('list', { name: 'Releases' });
    expect(within(timeline).getAllByText(/Someone/).length).toBeGreaterThan(0);
    expect(screen.queryByText('user-uuid')).not.toBeInTheDocument();
  });

  it('requires a reason and rolls back an earlier approved release as a new generation', async () => {
    const user = userEvent.setup();
    const earlier = release({ id: 'release-earlier', generation: 2, candidateHash: OLD_HASH });
    const head = release({ id: 'release-head', version: 'version-2', generation: 5 });
    const server = releaseServer({ active: head, history: [earlier, head] });
    mountPanel();
    await user.click(await screen.findByRole('button', { name: 'Restore v1' }));
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

    expect(await screen.findByText('v1 restored')).toBeInTheDocument();
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
    const head = release({ id: 'head', generation: 4 });
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
    await user.click(await screen.findByRole('button', { name: 'Restore v1' }));
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
    await user.click(await screen.findByRole('button', { name: 'Restore v1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Restore the archived template',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('v1 restored')).toBeInTheDocument();
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
});
