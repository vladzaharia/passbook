import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type FetchHandler, json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const preview = {
  ok: true,
  records: 9,
  counts: { create: 4, update: 1, unchanged: 0, skipped: 3, errors: 1, waiting: 0 },
  releaseBlocked: null,
  window: { days: 30, limit: 200, since: 1, excluded: 0 },
  samples: [
    { ref: 'o-1', action: 'skipped', fields: { name: 'Gift' } },
    { ref: 'o-2', action: 'error', fields: {}, message: 'Member name is required.' },
  ],
  durationMs: 4,
  columns: [
    { pointer: '/memberName', label: 'memberName', samples: ['Maya', 'Sam', 'Ana'], values: [] },
    {
      pointer: '/tier',
      label: 'tier',
      samples: ['blue', 'Gift card', 'copper'],
      values: [
        { value: 'blue', count: 5 },
        { value: 'Gift card', count: 3 },
        { value: 'copper', count: 1 },
      ],
    },
  ],
};

function handlers(patches: Record<string, unknown>[], extra: Record<string, FetchHandler> = {}) {
  let c = connectionDetail({
    defaultTemplateId: 'tpl1',
    mapping: {
      name: { from: '/memberName' },
      level: { from: '/tier', transform: { kind: 'enum', options: { map: { blue: 'blue' } } } },
    },
  });
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connectors/http-json': () => json(CONNECTOR),
    '/api/v1/connections/c1': (_u: URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        patches.push(body);
        c = { ...c, ...body };
      }
      return json(c);
    },
    ...extra,
  } satisfies Record<string, FetchHandler>;
}

describe('connection map and first sync', () => {
  it('shows the dry run beside the rows and saves "Don\'t issue" as a void rule', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers(patches, { '/api/v1/connections/c1/preview': () => json(preview) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    const region = await screen.findByRole('region', { name: 'First sync' });
    expect(await within(region).findByText('o-1')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: /Not issued/ })).toHaveTextContent('3');
    expect(within(region).getByText('Member name is required.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'First sync' })).toHaveTextContent(
        /9 records from the last 30 days/,
      ),
    );

    await user.click(await screen.findByRole('combobox', { name: /Option for Gift card/ }));
    await user.click(await screen.findByRole('option', { name: "Don't issue" }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.voidWhen).toEqual([{ from: '/tier', op: 'in', values: ['Gift card'] }]);
    expect(patches[0]?.mapping).toMatchObject({ name: { from: '/memberName' } });
  });

  it('says so when the source cannot be read', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers([], {
        '/api/v1/connections/c1/preview': () =>
          json({ ...preview, ok: false, errorCode: 'AUTH', records: 0, columns: [] }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText('Could not read the source (AUTH).')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Mappings' })).toBeInTheDocument();
  });
});
