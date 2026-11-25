import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '../../../lib/test-utils.tsx';
import { connectionDetail, ORG } from '../../passes/test-fixtures.ts';
import { revision, UPLOAD_CONNECTOR } from './files-fixtures.ts';
import { forgetApplyStarts } from './use-apply-watch.ts';

const membership = membershipFixture(ORG.id, {
  orgName: ORG.name,
  orgSlug: ORG.slug,
  capabilities: ['integrations:read', 'integrations:manage', 'templates:read'],
});

const current = (over: Record<string, unknown> = {}) =>
  revision({
    id: 'f1',
    revision: 1,
    state: 'current',
    name: 'members.csv',
    rows: 412,
    diff: null,
    applied: true,
    expiresAt: null,
    ...over,
  });

function open(
  revisions: () => unknown[],
  extra: Record<string, (u: URL, i?: RequestInit) => Response> = {},
  onMissing: 'keep' | 'flag' | 'void' = 'flag',
) {
  return renderApp('/admin/connections/c1', {
    session: 'admin',
    memberships: [membership],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/connectors': () => json({ items: [UPLOAD_CONNECTOR], nextCursor: null }),
      '/api/v1/connectors/file-upload': () => json(UPLOAD_CONNECTOR),
      '/api/v1/connections/c1': () =>
        json(
          connectionDetail({ id: 'c1', connectorType: 'file-upload', mode: 'manual', onMissing }),
        ),
      '/api/v1/connections/c1/files': () => json({ items: revisions(), nextCursor: null }),
      ...extra,
    },
  });
}

describe('File tab', () => {
  afterEach(forgetApplyStarts);

  it('previews a pending revision with what happens to the removed rows, then applies it', async () => {
    const user = userEvent.setup();
    let applied = false;
    const posts: string[] = [];
    await open(
      () =>
        applied
          ? [revision({ state: 'current' }), current({ state: 'superseded' })]
          : [revision(), current()],
      {
        '/api/v1/connections/c1/files/f2/apply': (u) => {
          posts.push(u.pathname);
          applied = true;
          return json({
            file: revision({ state: 'current' }),
            runId: 'r1',
            workflowInstanceId: 'w1',
          });
        },
      },
    );
    expect(await screen.findByText('New version · members-nov.csv')).toBeInTheDocument();
    expect(screen.getByText('M-12')).toBeInTheDocument();
    expect(screen.getByText('3 rows are not in the file')).toBeInTheDocument();
    expect(screen.getByText('Their passes will be flagged for review.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(posts).toEqual(['/api/v1/connections/c1/files/f2/apply']));
    // The run is still going: the file is uploaded, the passes are updating.
    const steps = await screen.findByRole('list', { name: 'Applying the file' });
    expect(within(steps).getByText('Updating passes')).toBeInTheDocument();
  });

  it('says voided when the connection voids missing rows, and nothing when it keeps them', async () => {
    await open(() => [revision(), current()], {}, 'void');
    expect(
      await screen.findByText('Their passes will be voided and stop working in Wallet.'),
    ).toBeInTheDocument();
  });

  it('keeps the removed passes as they are under Keep', async () => {
    await open(() => [revision(), current()], {}, 'keep');
    expect(await screen.findByText('Their passes stay as they are.')).toBeInTheDocument();
  });

  it('shows Applied for a finished revision, and the history', async () => {
    await open(() => [
      current({ revision: 2, id: 'f2', diff: revision().diff }),
      current({ id: 'f1', state: 'superseded', revision: 1 }),
    ]);
    expect(await screen.findByText(/Applied\. \+12 new/)).toBeInTheDocument();
    const history = screen.getByRole('heading', { name: 'History' }).closest('div')?.parentElement;
    expect(history).toBeTruthy();
    expect(screen.getByText('Revision 1')).toBeInTheDocument();
    expect(screen.getByText('Replaced')).toBeInTheDocument();
  });

  it('labels a revision whose run a newer one replaced', async () => {
    await open(() => [
      current({ id: 'f3', revision: 3 }),
      current({ id: 'f2', revision: 2, state: 'superseded', applied: false }),
    ]);
    expect(await screen.findByText('Replaced by a newer run')).toBeInTheDocument();
  });

  it('says so when the new file matches the current one', async () => {
    const user = userEvent.setup();
    await open(() => [current()], {
      '/api/v1/connections/c1/files': (_u, init) =>
        (init?.method ?? 'GET').toUpperCase() === 'POST'
          ? json({ unchanged: true })
          : json({ items: [current()], nextCursor: null }),
    });
    await user.upload(
      await screen.findByLabelText('Drop a file or choose'),
      new File(['a,b\n1,2\n'], 'members.csv', { type: 'text/csv' }),
    );
    expect(
      await screen.findByText('No changes. The file matches the current version.'),
    ).toBeInTheDocument();
  });

  it('shows a refusal under the drop', async () => {
    const user = userEvent.setup();
    await open(() => [current()], {
      '/api/v1/connections/c1/files': (_u, init) =>
        (init?.method ?? 'GET').toUpperCase() === 'POST'
          ? problem(422, 'FILE_DAMAGED', 'The file could not be read.')
          : json({ items: [current()], nextCursor: null }),
    });
    await user.upload(
      await screen.findByLabelText('Drop a file or choose'),
      new File(['x'], 'members.csv', { type: 'text/csv' }),
    );
    expect(await screen.findByText('The file could not be read.')).toBeInTheDocument();
  });

  it('shows the wait whichever Sync now starts the run (the header one here)', async () => {
    const user = userEvent.setup();
    const syncs: string[] = [];
    await open(() => [current({ applied: false })], {
      '/api/v1/connections/c1': () =>
        json(
          connectionDetail({ id: 'c1', connectorType: 'file-upload', mode: 'manual', runs: [] }),
        ),
      '/api/v1/connections/c1/sync': (u) => {
        syncs.push(u.pathname);
        return json({ runId: 'r9', workflowInstanceId: 'w9' });
      },
    });
    expect(await screen.findByText('Not applied yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Sync now' })[0] as HTMLElement);
    await waitFor(() => expect(syncs).toEqual(['/api/v1/connections/c1/sync']));
    expect(await screen.findByRole('list', { name: 'Applying the file' })).toBeInTheDocument();
  });

  it('says the last sync failed when a file is not applied and the newest run errored', async () => {
    await open(() => [current({ applied: false })]);
    expect(await screen.findByText('The last sync failed')).toBeInTheDocument();
  });
});
