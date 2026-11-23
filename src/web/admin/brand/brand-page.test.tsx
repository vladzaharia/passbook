import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassSetup, PassSetupResult } from '@/shared/contracts/pass-setup.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';

const me = (capabilities?: Parameters<typeof membershipFixture>[1]) =>
  membershipFixture('o1', { orgName: 'Acme Fitness', ...capabilities });

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function setup(view: PassSetup, extra: Record<string, Handler> = {}, membership = me()) {
  return renderApp('/admin/o/o1/brand', {
    session: 'user',
    memberships: [membership],
    handlers: {
      '/api/v1/orgs/o1/pass-setup': () => json(view),
      '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
      ...extra,
    },
  });
}

const dry = (view: PassSetup, over: Partial<PassSetupResult> = {}): PassSetupResult => ({
  dryRun: true,
  view,
  diff: [{ field: 'channels.mobile', before: 'allowed', after: 'blocked' }],
  impact: { passesToUpdate: 0, channelStops: [], enrolments: [] },
  ...over,
});

describe('Brand and channels', () => {
  it('shows a new org its three to-dos, each with one fix, and the count in the sidebar', async () => {
    const { container } = await setup(viewOf(newOrgFacts()));
    expect(
      await screen.findByRole('heading', { name: 'Brand and channels', level: 1 }),
    ).toBeVisible();
    const checks = await screen.findByLabelText('Brand and channels', { selector: 'div' });
    expect(within(checks).getByText('3 to do')).toBeInTheDocument();
    expect(within(checks).getByRole('button', { name: 'Add logo' })).toBeInTheDocument();
    expect(within(checks).getByRole('button', { name: 'Add icon' })).toBeInTheDocument();
    expect(within(checks).getByRole('button', { name: 'Add support' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(await within(nav).findByRole('link', { name: /Brand and channels.*3/ })).toBeVisible();
    expect(screen.getByText('No passes yet')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reads Ready and has no to-dos for a set-up org', async () => {
    await setup(viewOf(readyFacts()));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('All set')).toBeInTheDocument();
    expect(screen.getByText('412 passes')).toBeInTheDocument();
  });

  it('hides the Allowed switch while a level above stops the channel and names that level', async () => {
    await setup(viewOf(readyFacts()));
    const channels = await screen.findByRole('region', { name: 'Channels' });
    const row = (name: string) => within(channels).getByText(name).closest('li') as HTMLElement;
    for (const [name, level, status] of [
      ['Google Wallet', 'PassBook', 'Not available yet'],
      ['Samsung Wallet', 'PassBook', 'Not available yet'],
      ['Paper', 'Plan', 'Not in your plan'],
    ] as const) {
      expect(within(row(name)).getByText(level)).toBeInTheDocument();
      expect(within(row(name)).getByText(status)).toBeInTheDocument();
      expect(within(row(name)).queryByRole('switch')).toBeNull();
    }
    expect(
      within(row('Apple Wallet')).getByRole('switch', { name: /Apple Wallet allowed/ }),
    ).toBeChecked();
    expect(within(row('Mobile')).getByRole('switch')).toBeChecked();
  });

  it('opens a row to its chain, templates and Ask PassBook', async () => {
    const user = userEvent.setup();
    await setup(viewOf(readyFacts()));
    const channels = await screen.findByRole('region', { name: 'Channels' });
    await user.click(within(channels).getByRole('button', { name: /^Paper/ }));
    expect(await within(channels).findByRole('link', { name: 'Ask PassBook' })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:'),
    );
    await user.click(within(channels).getByRole('button', { name: /^Apple Wallet/ }));
    const chain = await within(channels).findAllByRole('list', { name: 'Chain' });
    expect(within(chain[0] as HTMLElement).getByText('Templates 2/2')).toBeInTheDocument();
    expect(within(channels).getByText('pass.mobile.passbook.acmefitness')).toBeInTheDocument();
  });

  it('stages a block, reviews it with the dry run, and saves with the revision', async () => {
    const user = userEvent.setup();
    const view = viewOf(readyFacts());
    const bodies: { dryRun: boolean; body: unknown }[] = [];
    await setup(view, {
      '/api/v1/orgs/o1/pass-setup': (url: URL, init?: RequestInit) => {
        if (init?.method !== 'PATCH') return json(view);
        const dryRun = url.searchParams.get('dryRun') === 'true';
        bodies.push({ dryRun, body: JSON.parse(String(init.body)) });
        return json(
          dry(view, {
            dryRun,
            impact: {
              passesToUpdate: 412,
              channelStops: [{ channel: 'mobile', templates: 2, passes: 412 }],
              enrolments: [],
            },
          }),
        );
      },
    });
    const channels = await screen.findByRole('region', { name: 'Channels' });
    await user.click(within(channels).getByRole('switch', { name: /Mobile allowed/ }));
    expect(screen.getByText('1 change')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Save 1 change')).toBeInTheDocument();
    expect(within(dialog).getByText('412 passes update on devices.')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Mobile stops for 2 templates · 412 passes\./),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Copies keep working.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Block and save' }));
    await waitFor(() => expect(bodies.filter((b) => !b.dryRun)).toHaveLength(1));
    const expected = { expectedRevision: 'r1', channels: { mobile: 'blocked' } };
    expect(bodies[0]).toEqual({ dryRun: true, body: expected });
    expect(bodies[1]).toEqual({ dryRun: false, body: expected });
  });

  it('says one template and one pass in the singular, and one pass in the header', async () => {
    const user = userEvent.setup();
    const view = { ...viewOf(readyFacts()), passCount: 1 };
    await setup(view, {
      '/api/v1/orgs/o1/pass-setup': (_url: URL, init?: RequestInit) =>
        init?.method !== 'PATCH'
          ? json(view)
          : json(
              dry(view, {
                impact: {
                  passesToUpdate: 0,
                  channelStops: [{ channel: 'mobile', templates: 1, passes: 1 }],
                  enrolments: [],
                },
              }),
            ),
    });
    expect(await screen.findByText('1 pass')).toBeInTheDocument();
    const channels = await screen.findByRole('region', { name: 'Channels' });
    await user.click(within(channels).getByRole('switch', { name: /Mobile allowed/ }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/Mobile stops for 1 template · 1 pass\./),
    ).toBeInTheDocument();
  });

  it('draws a channel no template uses with the off dot, and keeps its switch on', async () => {
    const view = viewOf(readyFacts());
    view.channels.mobile.templates = { on: 0, off: 2, never: 0, total: 2 };
    await setup(view);
    const channels = await screen.findByRole('region', { name: 'Channels' });
    const row = (name: string) => within(channels).getByText(name).closest('li') as HTMLElement;
    expect(row('Mobile')).toHaveAttribute('data-unused');
    expect(within(row('Mobile')).getByRole('switch')).toBeChecked();
    expect(row('Apple Wallet')).not.toHaveAttribute('data-unused');
  });

  it('keeps the draft and asks for a new review when someone saved first', async () => {
    const user = userEvent.setup();
    const view = viewOf(readyFacts());
    let reads = 0;
    await setup(view, {
      '/api/v1/orgs/o1/pass-setup': (url: URL, init?: RequestInit) => {
        if (init?.method !== 'PATCH') {
          reads += 1;
          return json(view);
        }
        return url.searchParams.get('dryRun') === 'true'
          ? json(dry(view))
          : problem(409, 'PASS_SETUP_CHANGED', 'Changed.');
      },
    });
    const channels = await screen.findByRole('region', { name: 'Channels' });
    await user.click(within(channels).getByRole('switch', { name: /Apple Wallet allowed/ }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  it('blocks a review while a colour is invalid and focuses it', async () => {
    const user = userEvent.setup();
    await setup(viewOf(readyFacts()));
    const background = await screen.findByLabelText('Background');
    await user.clear(background);
    await user.type(background, '#12');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByText('Use a 6-digit hex like #0f766e.').length).toBeGreaterThan(0);
  });

  it('shows a member without org:manage the page read-only', async () => {
    await setup(viewOf(readyFacts()), {}, me({ capabilities: ['org:read'] }));
    const channels = await screen.findByRole('region', { name: 'Channels' });
    expect(within(channels).getByRole('switch', { name: /Mobile allowed/ })).toBeDisabled();
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add logo' })).toBeNull();
  });

  it('has no preview tab for a channel the plan or PassBook stops', async () => {
    await setup(viewOf(readyFacts()));
    const tabs = await screen.findByRole('radiogroup', { name: 'Preview' });
    expect(
      within(tabs)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Apple', 'Page', 'Email']);
    const stage = screen.getByRole('region', { name: 'Preview' });
    expect(stage.querySelector('[data-locked]')).toBeNull();
    expect(within(stage).queryByRole('link', { name: 'Ask PassBook' })).toBeNull();
  });

  it('opens the holder page in a dialog and offers the request and the audit log in More', async () => {
    const user = userEvent.setup();
    await setup(viewOf(readyFacts()));
    await user.click(await screen.findByRole('button', { name: 'Preview as holder' }));
    expect(await screen.findByRole('dialog', { name: 'Preview as holder' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Copy as API request' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/admin/o/o1/audit',
    );
  });

  it('shows no account tiles for a wallet that is not released', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await setup(viewOf(readyFacts()));
    const channels = await screen.findByRole('region', { name: 'Channels' });
    await user.click(within(channels).getByRole('button', { name: /^Google Wallet/ }));
    await user.click(within(channels).getByRole('button', { name: /^Samsung Wallet/ }));
    expect(screen.queryByRole('radio', { name: /Managed by PassBook/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Share your issuer/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Google Wallet' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('google/managed'))).toBe(
      false,
    );
  });

  it('sends Wallet accounts to the Channels card', async () => {
    const { router } = await renderApp('/admin/o/o1/wallet-accounts', {
      session: 'user',
      memberships: [me()],
      handlers: { '/api/v1/orgs/o1/pass-setup': () => json(viewOf(readyFacts())) },
    });
    await screen.findByRole('heading', { name: 'Brand and channels', level: 1 });
    expect(router.state.location.pathname).toBe('/admin/o/o1/brand');
    expect(router.state.location.hash).toBe('channels');
  });
});
