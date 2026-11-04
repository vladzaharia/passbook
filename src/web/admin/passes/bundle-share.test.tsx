import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, renderApp } from '../../lib/test-utils.tsx';
import {
  ORG,
  passSummary,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const empty = () => json({ items: [], nextCursor: null });
const bundle = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  orgId: 'org1',
  mode: 'live',
  name: 'Trip',
  url: 'https://wallet.test/b/tok',
  holderEmail: null,
  passes: [{ id: 'p1', title: 'Pass 1', status: 'active' }],
  createdAt: 1,
  linkRotatedAt: null,
  ...over,
});

function handlers(extra: Record<string, FetchHandler> = {}): Record<string, FetchHandler> {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/templates/previews': previewsHandler,
    '/api/v1/templates/tpl1/preview': () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
    '/api/v1/connections': empty,
    ...extra,
  };
}

const passes = (orgs: string[] = ['org1', 'org1']) =>
  json({
    items: orgs.map((orgId, i) =>
      passSummary({ id: `p${i + 1}`, orgId, title: `Pass ${i + 1}`, serial: `S-${i}` }),
    ),
    nextCursor: null,
  });

describe('Share as bundle', () => {
  it('names the bundle, creates it and shows the link', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const { container } = await renderApp('/admin/passes', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes': () => passes(),
        '/api/v1/bundles': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(bundle(), 201);
        },
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Pass 2' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    await user.click(within(bar).getByRole('button', { name: 'Share as bundle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
    expect((await axe(container)).violations).toEqual([]);
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Trip');
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ orgId: 'org1', passIds: ['p1', 'p2'], name: 'Trip' }]),
    );
    const done = await screen.findByRole('dialog', { name: 'Trip' });
    expect(within(done).getByText('https://wallet.test/b/tok')).toBeInTheDocument();
    expect(within(done).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('emails the link when an address is given', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes': () => passes(),
        '/api/v1/bundles': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(bundle({ holderEmail: 'mia@example.com' }), 201);
        },
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await user.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Share as bundle',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Trip');
    await user.type(within(dialog).getByRole('textbox', { name: /Email/ }), 'mia@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create and email' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        {
          orgId: 'org1',
          passIds: ['p1'],
          name: 'Trip',
          holderEmail: 'mia@example.com',
          sendEmail: true,
        },
      ]),
    );
    expect(await screen.findByText('Link emailed to mia@example.com.')).toBeInTheDocument();
  });

  it('refuses a selection that spans organizations', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: handlers({ '/api/v1/passes': () => passes(['org1', 'org2']) }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Pass 2' }));
    await user.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Share as bundle',
      }),
    );
    expect(
      await screen.findByText('Select up to 10 passes of one organization.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Share as bundle' })).toBeNull();
  });
});
