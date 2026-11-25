import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
} from '../../../lib/test-utils.tsx';
import {
  connection,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../../passes/test-fixtures.ts';
import { draftFile, UPLOAD_CONNECTOR } from './files-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const file = (name = 'members.csv') =>
  new File(['Member ID,Name\nM-1,Maya\n'], name, { type: 'text/csv' });

function handlers(
  posts: Record<string, unknown>[],
  upload: FetchHandler = () => json(draftFile(), 201),
) {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/connectors': () => json({ items: [UPLOAD_CONNECTOR], nextCursor: null }),
    '/api/v1/connectors/file-upload': () => json(UPLOAD_CONNECTOR),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connections/uploads': upload,
    '/api/v1/connections': (_u: URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        posts.push(JSON.parse(String(init?.body)));
        return json(connection({ id: 'c9' }), 201);
      }
      return json({ items: [], nextCursor: null });
    },
    '/api/v1/connections/c9': () => json(connectionDetail({ id: 'c9' })),
  } satisfies Record<string, FetchHandler>;
}

type User = ReturnType<typeof userEvent.setup>;
const next = (user: User) =>
  user.click(screen.getByRole('button', { name: /^(Next|Create( without mappings)?)$/ }));

async function toUpload(user: User, h: ReturnType<typeof handlers>) {
  await renderApp('/admin/connections/new', {
    session: 'admin',
    memberships: [membership],
    selectedOrg: ORG.id,
    handlers: h,
  });
  await user.click(await screen.findByRole('radio', { name: /File upload/ }));
  await next(user);
}

describe('file upload in the connection wizard', () => {
  it('reads a dropped file, shows the checks and preview, and creates with its draft', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    await toUpload(user, handlers(posts));
    await user.upload(await screen.findByLabelText('Drop a file or choose'), file());

    expect(await screen.findByText('412 rows read')).toBeInTheDocument();
    expect(screen.getByText('Every row has a unique ID')).toBeInTheDocument();
    const preview = screen.getByRole('region', { name: 'First rows of the file' });
    expect(within(preview).getByText('maya@example.com')).toBeInTheDocument();
    // The name starts from the file's.
    expect(screen.getByLabelText(/^Name/)).toHaveValue('members');
    expect(screen.getByLabelText(/ID column/)).toHaveTextContent('Member ID');

    await next(user);
    // Mapping lists the file's columns as sources.
    await next(user);
    // Lifecycle has no mode to choose.
    expect(await screen.findByText('Syncs when you apply a file.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Poll' })).toBeNull();
    await next(user);
    await next(user);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      connectorType: 'file-upload',
      name: 'members',
      fileId: 'f1',
      config: { idColumn: '/Member ID' },
    });
  });

  it('warns about rows the ID column skips', async () => {
    const user = userEvent.setup();
    const columns = draftFile().columns.map((c) =>
      c.label === 'Member ID' ? { ...c, blanks: 3, duplicates: 1 } : c,
    );
    await toUpload(
      user,
      handlers([], () => json(draftFile({ columns }), 201)),
    );
    await user.upload(await screen.findByLabelText('Drop a file or choose'), file());
    expect(await screen.findByText('4 rows skipped')).toBeInTheDocument();
    expect(screen.getByText('3 with no ID, 1 repeating one')).toBeInTheDocument();
  });

  it('says when the hourly allowance is used up', async () => {
    const user = userEvent.setup();
    const limited = () =>
      new Response(
        JSON.stringify({ code: 'RATE_LIMITED', title: 'RATE_LIMITED', status: 429, detail: 'x' }),
        {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '900' },
        },
      );
    await toUpload(user, handlers([], limited));
    await user.upload(await screen.findByLabelText('Drop a file or choose'), file());
    expect(
      await screen.findByText('Too many uploads this hour. Try again in 15 min.'),
    ).toBeInTheDocument();
    // The drop stays, so a later try needs no reload.
    expect(screen.getByLabelText('Drop a file or choose')).toBeInTheDocument();
  });

  it('shows the parser sentence for a file it cannot read', async () => {
    const user = userEvent.setup();
    await toUpload(
      user,
      handlers([], () =>
        problem(422, 'FILE_FORMAT_UNSUPPORTED', 'Save the sheet as .xlsx or CSV.'),
      ),
    );
    await user.upload(await screen.findByLabelText('Drop a file or choose'), file('old.csv'));
    expect(await screen.findByText('Save the sheet as .xlsx or CSV.')).toBeInTheDocument();
  });

  it('refuses a file over 5 MB without sending it', async () => {
    const user = userEvent.setup();
    const sent: string[] = [];
    await toUpload(
      user,
      handlers([], () => {
        sent.push('x');
        return json(draftFile(), 201);
      }),
    );
    const big = new File(['a'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    await user.upload(await screen.findByLabelText('Drop a file or choose'), big);
    expect(
      await screen.findByText('Over 5 MB. Remove columns or split the file.'),
    ).toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('blocks Next without a file', async () => {
    const user = userEvent.setup();
    await toUpload(user, handlers([]));
    await user.type(await screen.findByLabelText(/^Name/), 'Members');
    await next(user);
    expect(await screen.findByText('Add a file.')).toBeInTheDocument();
  });
});
