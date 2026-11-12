import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json, problem } from '../../../lib/test-utils.tsx';
import { TemplateReleasesPanel } from './template-releases-panel.tsx';
import {
  approval,
  CANDIDATE_HASH,
  CONTENT_HASH,
  candidate,
  IMPACT,
  mountPanel,
  OLD_HASH,
  panelProps,
  release,
  releaseServer,
  SCOPE,
} from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

describe('template release actions', () => {
  it('shows the active release by version and publisher, with ids under technical details', async () => {
    const user = userEvent.setup();
    const active = release({
      id: 'active-release-id',
      generation: 4,
      mode: 'test',
      version: 'version-2',
    });
    releaseServer({ active, history: [active] });
    mountPanel({ mode: 'test' });
    const facts = (await screen.findByText('Published by')).closest('dl');
    if (!facts) throw new Error('Active release facts were not rendered');
    for (const value of ['Version 2', 'Pia Publisher', 'Apple · Test'])
      expect(within(facts).getByText(value)).toBeVisible();
    const card = facts.closest('div.grid');
    if (!(card instanceof HTMLElement)) throw new Error('Active release card missing');
    const disclosure = within(card).getAllByText('Technical details')[0];
    if (!disclosure) throw new Error('Technical details missing');
    const details = disclosure.closest('details');
    expect(details).not.toHaveAttribute('open');
    await user.click(disclosure);
    expect(details).toHaveAttribute('open');
    for (const value of ['active-release-id', '4', 'version-2', 'org-1', OLD_HASH])
      expect(within(card).getAllByText(value).length).toBeGreaterThan(0);
  });

  it('names an unknown publisher plainly, never by id', async () => {
    const active = release({ createdBy: 'user-uuid', createdByName: null });
    releaseServer({ active, history: [active] });
    mountPanel();
    await screen.findByText('Published by');
    expect(screen.getAllByText('Unknown user').length).toBeGreaterThan(0);
    expect(screen.queryByText('user-uuid')).not.toBeInTheDocument();
  });

  it('creates a candidate from a saved version and refreshes the immutable snapshot', async () => {
    const user = userEvent.setup();
    const server = releaseServer();
    mountPanel();
    expect(await screen.findByText(/No candidates yet/)).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create candidate' });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Saved version' }));
    expect(screen.getByRole('option', { name: /Version 1/ })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Version 2/ }));
    expect(create).toBeEnabled();
    await user.click(create);

    await screen.findByRole('heading', { name: 'Version 2' });
    expect(screen.getByText(CANDIDATE_HASH)).toBeInTheDocument();
    expect(screen.getByText(CONTENT_HASH)).toBeInTheDocument();
    const post = server.requests.find((request) => request.method === 'POST');
    expect(post?.url.pathname).toBe('/api/v1/templates/template-1/candidates');
    expect(post?.body).toEqual({ ...SCOPE, version: 'version-2' });
    expect(post?.headers.get('x-passbook-mode')).toBe('live');
    expect(post?.headers.get('x-csrf-token')).toBe('csrf-token');
    expect(
      server.requests.filter(
        (request) => request.method === 'GET' && request.url.pathname.endsWith('/candidates'),
      ).length,
    ).toBeGreaterThan(1);
  });

  it('sends test scope in the write body and header even when the browser mode is live', async () => {
    resetModeForTests();
    const user = userEvent.setup();
    const server = releaseServer();
    mountPanel({ mode: 'test' });
    await screen.findByText(/No candidates yet/);
    await user.click(screen.getByRole('combobox', { name: 'Saved version' }));
    await user.click(screen.getByRole('option', { name: /Version 2/ }));
    await user.click(screen.getByRole('button', { name: 'Create candidate' }));
    await screen.findByRole('heading', { name: 'Version 2' });
    const post = server.requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({ ...SCOPE, mode: 'test', version: 'version-2' });
    expect(post?.headers.get('x-passbook-mode')).toBe('test');
    expect(server.candidates[0]?.mode).toBe('test');
  });

  it('filters the version active in this scope, not the template-wide active version', async () => {
    const user = userEvent.setup();
    const active = release({ version: 'version-2', generation: 3 });
    const server = releaseServer({ active, history: [active] });
    mountPanel();
    await screen.findByText(/No candidates yet/);
    await user.click(screen.getByRole('combobox', { name: 'Saved version' }));
    expect(screen.queryByRole('option', { name: /Version 2/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Version 1/ }));
    await user.click(screen.getByRole('button', { name: 'Create candidate' }));
    await screen.findByRole('heading', { name: 'Version 1' });
    const post = server.requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({ ...SCOPE, version: 'version-1' });
  });

  it('approves the exact candidate hash and publishes that approval against the history head', async () => {
    const user = userEvent.setup();
    const history = [
      release({ id: 'release-2', generation: 2 }),
      release({ id: 'release-7', generation: 7 }),
      release({ id: 'release-4', generation: 4 }),
    ];
    const server = releaseServer({ candidates: [candidate()], active: null, history });
    mountPanel();
    expect(await screen.findByText(/No active release for this organization/)).toBeInTheDocument();
    const approve = await screen.findByRole('button', { name: 'Approve candidate for Version 2' });
    expect(screen.getByRole('button', { name: 'Publish candidate for Version 2' })).toBeDisabled();
    await user.click(approve);
    const publish = await screen.findByRole('button', { name: 'Publish candidate for Version 2' });
    await waitFor(() => expect(publish).toBeEnabled());
    const approvePost = server.requests.find((request) =>
      request.url.pathname.endsWith('/approve'),
    );
    expect(approvePost?.method).toBe('POST');
    expect(approvePost?.body).toEqual({ ...SCOPE, candidateHash: CANDIDATE_HASH });
    expect(approvePost?.headers.get('x-passbook-mode')).toBe('live');
    expect(approvePost?.headers.get('x-csrf-token')).toBe('csrf-token');

    await user.click(publish);
    const dialog = await screen.findByRole('dialog', { name: 'Publish release' });
    expect(within(dialog).getByText('7')).toBeInTheDocument();
    expect(within(dialog).getByText('8')).toBeInTheDocument();
    expect(within(dialog).getByText(CANDIDATE_HASH)).toBeInTheDocument();
    expect(within(dialog).getByText('approval-1')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publish' }));
    expect(await screen.findByText(/Generation 8 · Version 2/)).toBeInTheDocument();
    const publishPost = server.requests.find(
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/releases'),
    );
    expect(publishPost?.body).toEqual({
      ...SCOPE,
      candidateId: 'candidate-1',
      approvalId: 'approval-1',
      candidateHash: CANDIDATE_HASH,
      expectedGeneration: 7,
    });
    expect(publishPost?.headers.get('x-passbook-mode')).toBe('live');
    expect(publishPost?.headers.get('x-csrf-token')).toBe('csrf-token');
    expect(
      server.requests.filter(
        (request) => request.method === 'GET' && request.url.pathname.endsWith('/releases'),
      ).length,
    ).toBeGreaterThan(1);
  });

  it('publishes the first approved release with expected generation zero', async () => {
    const user = userEvent.setup();
    const server = releaseServer({ candidates: [candidate({ approvals: [approval()] })] });
    mountPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Publish candidate for Version 2' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Publish release' });
    expect(within(dialog).getByText('0')).toBeInTheDocument();
    expect(within(dialog).getByText('1')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publish' }));
    expect(await screen.findByText(/Generation 1 · Version 2/)).toBeInTheDocument();
    const post = server.requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({
      ...SCOPE,
      candidateId: 'candidate-1',
      approvalId: 'approval-1',
      candidateHash: CANDIDATE_HASH,
      expectedGeneration: 0,
    });
  });

  it('disables confirmation if the release head changes while the dialog is open', async () => {
    const user = userEvent.setup();
    const head = release({ id: 'release-head', generation: 5 });
    const server = releaseServer({
      candidates: [candidate({ approvals: [approval()] })],
      active: head,
      history: [head],
    });
    const view = mountPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Publish candidate for Version 2' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Publish release' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm publish' });
    const next = release({ id: 'concurrent-release', generation: 6 });
    server.active = next;
    server.history = [next, head];
    await act(async () => {
      await view.client.invalidateQueries();
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/release history changed/i);
    expect(confirm).toBeDisabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('disables a pending confirmation when publishing permission is removed', async () => {
    const user = userEvent.setup();
    const server = releaseServer({ candidates: [candidate({ approvals: [approval()] })] });
    const view = mountPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Publish candidate for Version 2' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Publish release' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm publish' });
    expect(confirm).toBeEnabled();
    view.rerender(<TemplateReleasesPanel {...panelProps({ capabilities: ['templates:read'] })} />);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/can no longer publish/i);
    expect(confirm).toBeDisabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('shows a stale-generation conflict without retrying the publish', async () => {
    const user = userEvent.setup();
    const head = release({ id: 'release-head', generation: 5 });
    const server = releaseServer({
      candidates: [candidate({ approvals: [approval()] })],
      active: head,
      history: [head],
      publishError: () =>
        problem(
          409,
          'TEMPLATE_RELEASE_CONFLICT',
          'The template release changed. Reload and retry.',
        ),
    });
    mountPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Publish candidate for Version 2' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Publish release' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publish' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The template release changed. Reload and retry.',
    );
    const posts = server.requests.filter(
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/releases'),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.expectedGeneration).toBe(5);
  });

  it('requires a reason and rolls back an earlier approved release as a new generation', async () => {
    const user = userEvent.setup();
    const earlier = release({ id: 'release-earlier', generation: 2, candidateHash: OLD_HASH });
    const head = release({ id: 'release-head', version: 'version-2', generation: 5 });
    const server = releaseServer({ active: head, history: [earlier, head] });
    mountPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Roll back to Version 1 (generation 2)' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roll back release' });
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('maxlength', '500');
    expect(within(dialog).getByText('5')).toBeInTheDocument();
    expect(within(dialog).getByText('6')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm rollback' });
    expect(confirm).toBeDisabled();
    await user.type(reason, '   ');
    expect(confirm).toBeDisabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    await user.clear(reason);
    await user.type(reason, '  Barcode regression  ');
    await user.click(confirm);

    expect(await screen.findByText(/Generation 6 · Version 1/)).toBeInTheDocument();
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
    await user.click(
      await screen.findByRole('button', { name: 'Roll back to Version 1 (generation 1)' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roll back release' });
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    await user.type(reason, 'Restore the previous build');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm rollback' }));
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
    await user.click(
      await screen.findByRole('button', { name: 'Roll back to Version 1 (generation 5)' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roll back release' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Restore the archived template',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirm rollback' }));
    expect(await screen.findByText(/Generation 6 · Version 1/)).toBeInTheDocument();
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

describe('release review dialog', () => {
  const open = async (options: Parameters<typeof releaseServer>[0] = {}) => {
    const user = userEvent.setup();
    const server = releaseServer({
      candidates: [candidate({ approvals: [approval()] })],
      ...options,
    });
    mountPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Publish candidate for Version 2' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Publish release' });
    return { user, server, dialog };
  };

  it('shows affected passes and the grouped before and after diff', async () => {
    const { server, dialog } = await open();
    const impact = await within(dialog).findByRole('region', { name: 'Impact' });
    expect(within(impact).getByText('Passes to update').nextElementSibling).toHaveTextContent('12');
    expect(within(impact).queryByText(/Live passes|Test passes/)).not.toBeInTheDocument();
    expect(within(impact).queryByText(/more$/)).not.toBeInTheDocument();
    for (const group of ['Fields', 'Barcode', 'Colours'])
      expect(within(impact).getByRole('region', { name: group })).toBeInTheDocument();
    expect(within(impact).queryByRole('region', { name: 'Images' })).not.toBeInTheDocument();
    expect(within(impact).getByText('A1 → B2')).toBeInTheDocument();
    expect(within(impact).getByText('— → QR')).toBeInTheDocument();
    expect(within(impact).getByText('#000000 → #ffffff')).toBeInTheDocument();
    const get = server.requests.find((request) =>
      request.url.pathname.endsWith('/releases/impact'),
    );
    expect(Object.fromEntries(get?.url.searchParams ?? [])).toEqual({
      ...SCOPE,
      version: 'version-2',
    });
    expect(get?.headers.get('x-passbook-mode')).toBe('live');
  });

  it('names people and keeps ids and hashes behind technical details', async () => {
    const { user, dialog } = await open();
    expect(within(dialog).getByText('Ada Author')).toBeVisible();
    expect(within(dialog).getByText('Rae Reviewer')).toBeVisible();
    expect(within(dialog).getByText('Version 2')).toBeVisible();
    const summary = within(dialog).getByText('Technical details');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    expect(within(dialog).getByText('candidate-1')).toBeVisible();
    expect(within(dialog).getByText(CANDIDATE_HASH)).toBeVisible();
    expect(within(dialog).getByText('approval-1')).toBeVisible();
  });

  it('shows a capped count with a thousands separator and the changes beyond the list', async () => {
    const { dialog } = await open({
      impact: () =>
        json({
          ...IMPACT,
          passes: { count: 10000, capped: true },
          more: { ...IMPACT.more, fields: 1200 },
        }),
    });
    const impact = await within(dialog).findByRole('region', { name: 'Impact' });
    expect(await within(impact).findByText('10,000+')).toBeVisible();
    expect(within(impact).getByText('and 1,200 more')).toBeVisible();
  });

  it('formats an uncapped count with a thousands separator', async () => {
    const { dialog } = await open({
      impact: () => json({ ...IMPACT, passes: { count: 1234, capped: false } }),
    });
    expect(await within(dialog).findByText('1,234')).toBeVisible();
  });

  it('says there are no changes when the diff is empty', async () => {
    const empty = { fields: [], images: [], barcode: [], colors: [] };
    const { dialog } = await open({
      impact: () =>
        json({
          fromVersion: null,
          toVersion: 'version-2',
          passes: { count: 0, capped: false },
          diff: empty,
          more: { fields: 0, images: 0, barcode: 0, colors: 0 },
        }),
    });
    expect(await within(dialog).findByText('No changes from the current release.')).toBeVisible();
  });

  it('shows an impact error with Retry and recovers', async () => {
    let fail = true;
    const { user, dialog } = await open({
      impact: () =>
        fail
          ? problem(409, 'IMPACT_UNAVAILABLE', 'The impact could not be computed.')
          : json(IMPACT),
    });
    expect(await within(dialog).findByText(/The impact could not be computed/)).toBeVisible();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: /Retry/ }));
    expect(await within(dialog).findByText('A1 → B2')).toBeInTheDocument();
  });

  it('shows a loading state while the impact is pending and keeps confirm enabled', async () => {
    const { dialog } = await open({ impact: () => new Promise<Response>(() => {}) as never });
    expect(within(dialog).getByText('Loading impact')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm publish' })).toBeEnabled();
  });

  it('busy covers the mutation only: reads in flight leave the buttons usable', async () => {
    const user = userEvent.setup();
    releaseServer({ candidates: [candidate({ approvals: [approval()] })] });
    const view = mountPanel();
    const publish = await screen.findByRole('button', { name: 'Publish candidate for Version 2' });
    await act(async () => {
      void view.client.invalidateQueries();
    });
    expect(publish).toBeEnabled();
    await user.click(publish);
    expect(await screen.findByRole('dialog', { name: 'Publish release' })).toBeInTheDocument();
  });
});
