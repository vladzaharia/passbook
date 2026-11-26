import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { STEP_UP_COPY } from '@/shared/copy/step-up.ts';
import { dismissStepUp } from '@/web/lib/step-up.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { releaseReport, walletRelease } from './wallet-accounts-test-fixtures.ts';

afterEach(() => {
  dismissStepUp();
  vi.restoreAllMocks();
});

const READY = [
  { orgId: 'o2', orgName: 'Acme' },
  { orgId: 'o3', orgName: 'Birch' },
];
const ENABLE = '/api/v1/platform/wallet-release/google/live/enable-ready';

async function open(
  report: ReturnType<typeof releaseReport>,
  handlers: Parameters<typeof renderApp>[1] extends infer O
    ? O extends { handlers?: infer H }
      ? H
      : never
    : never = {},
) {
  const user = userEvent.setup();
  const rendered = await renderApp('/admin/platform/wallet-accounts', {
    session: 'admin',
    handlers: {
      '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
      '/api/v1/platform/wallet-release': () => json(report),
      '/api/v1/platform/wallet-credentials': () =>
        json({ items: [], nextCursor: null, release: walletRelease() }),
      '/api/v1/platform/wallet-enrolments': () => json({ items: [], nextCursor: null }),
      ...handlers,
    },
  });
  await user.click(await screen.findByRole('tab', { name: 'Google' }));
  const live = await screen.findByRole('region', { name: 'Live release' });
  return { user, live, ...rendered };
}

const bodies = (calls: ReturnType<typeof vi.fn>) =>
  calls.mock.calls
    .filter(([url]) => String(url).endsWith('/enable-ready'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe('release card', () => {
  it('shows a dark provider plainly, with the facts and no apply', async () => {
    const { user, live, container, fetchMock } = await open(releaseReport('google', 'dark'), {
      [ENABLE]: () => json({ applied: false, enrolments: READY }),
    });
    expect(within(live).getByText('Dark')).toBeInTheDocument();
    expect(
      within(live).getByText(
        "Google Wallet isn't released yet. Turning it on is a code change: the flip PR.",
      ),
    ).toBeInTheDocument();
    expect(within(live).getByText(/^Checked /)).toBeInTheDocument();
    expect(within(live).getByText('Issuing (1)')).toBeInTheDocument();
    expect(within(live).getByText('Ready (2)')).toBeInTheDocument();
    await user.click(within(live).getByText('Blocked (1)'));
    expect(within(live).getByText('Check has not passed, Held by PassBook')).toBeInTheDocument();
    expect(within(live).getByText('Awaiting review')).toBeInTheDocument();
    expect(within(live).getByText('Retired')).toBeInTheDocument();
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    expect(await within(live).findByText('These turn on once it is released.')).toBeInTheDocument();
    expect(within(live).queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(bodies(fetchMock)).toEqual([{ apply: false }]);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows a draining provider with its rollback line and no apply', async () => {
    const { user, live } = await open(releaseReport('google', 'draining'), {
      [ENABLE]: () => json({ applied: false, enrolments: READY }),
    });
    expect(within(live).getByText('Draining')).toBeInTheDocument();
    expect(
      within(live).getByText('Draining. Voids and removals still flow; nothing new is issued.'),
    ).toBeInTheDocument();
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    await within(live).findByText('Would turn on 2 accounts');
    expect(within(live).queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('says there is nothing to enable when the dry run is empty', async () => {
    const { user, live } = await open(releaseReport('google', 'released'), {
      [ENABLE]: () => json({ applied: false, enrolments: [] }),
    });
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    expect(await within(live).findByText('Nothing is ready to turn on')).toBeInTheDocument();
  });

  it('applies exactly the dry run list after a confirm', async () => {
    let applied = false;
    const { user, live, fetchMock } = await open(releaseReport('google', 'released'), {
      [ENABLE]: (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.apply) applied = true;
        return json({ applied: body.apply, enrolments: READY });
      },
    });
    expect(within(live).getByText('Released')).toBeInTheDocument();
    expect(within(live).queryByText(/isn't released/)).toBeNull();
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    expect(await within(live).findByText('Would turn on 2 accounts')).toBeInTheDocument();
    const list = within(live).getByRole('list', { name: 'Dry run' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Acme', 'Birch']);
    await user.click(within(live).getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Turn on 2 accounts?')).toBeInTheDocument();
    expect(applied).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(applied).toBe(true));
    expect(bodies(fetchMock)).toEqual([{ apply: false }, { apply: true, orgIds: ['o2', 'o3'] }]);
    expect(await screen.findByText('Turned on 2 accounts')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('says what changed on a 409 and offers the dry run again', async () => {
    let dryRuns = 0;
    const { user, live } = await open(releaseReport('google', 'released'), {
      [ENABLE]: (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.apply)
          return problem(409, 'WALLET_RELEASE_READY_CHANGED', 'The ready list changed.');
        dryRuns += 1;
        return json({
          applied: false,
          enrolments: dryRuns === 1 ? READY : [READY[0], { orgId: 'o9', orgName: 'Elm' }],
        });
      },
    });
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    await within(live).findByText('Would turn on 2 accounts');
    await user.click(within(live).getByRole('button', { name: 'Apply' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn on' }),
    );
    const alert = await within(live).findByRole('alert');
    expect(alert).toHaveTextContent('Now ready: Elm. No longer ready: Birch.');
    expect(within(live).queryByRole('button', { name: 'Apply' })).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Run the dry run again' }));
    expect(await within(live).findByText('Would turn on 2 accounts')).toBeInTheDocument();
    expect(within(live).getByText('Elm')).toBeInTheDocument();
    expect(within(live).queryByRole('alert')).toBeNull();
  });

  it('tells a failed apply that some accounts may already be on', async () => {
    const { user, live } = await open(releaseReport('google', 'released'), {
      [ENABLE]: (_url, init) =>
        JSON.parse(String(init?.body)).apply
          ? problem(500, 'INTERNAL', 'boom')
          : json({ applied: false, enrolments: READY }),
    });
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    await within(live).findByText('Would turn on 2 accounts');
    await user.click(within(live).getByRole('button', { name: 'Apply' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn on' }),
    );
    expect(await within(live).findByRole('alert')).toHaveTextContent(
      'Some may already be on. Run the dry run again to see what is left.',
    );
  });

  it('opens the kit step-up dialog when the dry run needs a recent sign-in', async () => {
    const { user, live } = await open(releaseReport('google', 'released'), {
      [ENABLE]: () => problem(403, 'STEP_UP_REQUIRED', 'Sign in again.'),
    });
    await user.click(within(live).getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText(STEP_UP_COPY.title)).toBeInTheDocument();
    expect(within(live).queryByRole('alert')).toBeNull();
  });

  it('shows only the tab provider', async () => {
    const { live } = await open(releaseReport('google', 'released'));
    expect(screen.getAllByRole('region', { name: /release$/ })).toHaveLength(2);
    expect(within(live).getByText('Released')).toBeInTheDocument();
  });
});
