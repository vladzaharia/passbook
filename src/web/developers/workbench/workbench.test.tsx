import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateSession } from '../console/session.ts';
import { homeClosed, homeDone, homeFresh, homeNone, homeProgressed } from './home-fixtures.ts';
import { mount } from './index.tsx';
import { WorkbenchIsland } from './island.tsx';
import { ago, duration, keyState, left, masked, meter, sparkPoints, ticksOf } from './model.ts';
import { Workbench } from './workbench.tsx';

const noCalls = async () => [];
afterEach(() => vi.unstubAllGlobals());

describe('workbench model', () => {
  it('formats the time and the clocks without the device clock', () => {
    expect(duration(222_000)).toBe('3:42');
    expect(duration(3_725_000)).toBe('1:02:05');
    expect(ago(1000, 30_000)).toBe('now');
    expect(ago(0, 5 * 60_000)).toBe('5 min');
    expect(left(10 * 86_400_000, 0)).toBe('10 d');
    expect(left(1000, 0)).toBe('<1 min');
  });

  it('builds ticks from the server track, sign-in first', () => {
    if (!homeProgressed.progress) throw new Error('fixture');
    const ticks = ticksOf(homeProgressed.progress);
    expect(ticks.map((t) => [t.id, t.at !== null, t.current])).toEqual([
      ['signin', true, false],
      ['sandbox', true, false],
      ['call', true, false],
      ['change', false, true],
      ['webhook', false, false],
    ]);
  });

  it('draws, meters and masks', () => {
    expect(sparkPoints([0, 0], 10, 10)).toBe('0.0,9.0 10.0,9.0');
    expect(meter(12, 500)).toBe(2);
    expect(meter(9, null)).toBe(0);
    const [sandbox, ci] = homeDone.keys;
    expect(sandbox && keyState(sandbox, homeDone.now)).toBe('active');
    expect(ci && keyState(ci, homeDone.now)).toBe('rolling');
    expect(masked({ secretPrefix: 'pbp_test_Ab12Cd' })).toBe('pbp_test_Ab12Cd_…');
  });
});

describe('Workbench', () => {
  it('no sandbox: one way in and the Live orgs', () => {
    render(<Workbench home={homeNone} loadCalls={noCalls} />);
    expect(screen.getByRole('heading', { name: 'No sandbox yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create sandbox' }).getAttribute('href')).toBe(
      '/developers/quickstart#sandbox',
    );
    expect(screen.getAllByRole('link', { name: 'Live key' })[0]?.getAttribute('href')).toBe(
      '/admin/o/019a-live-1/api-keys',
    );
  });

  it('fresh: the track asks to continue, nothing used yet', () => {
    render(<Workbench home={homeFresh} loadCalls={noCalls} />);
    expect(screen.getByTestId('wb-track-count').textContent).toBe('2 of 5');
    expect(screen.getByRole('link', { name: 'Continue' }).getAttribute('href')).toBe(
      '/developers/quickstart',
    );
    expect(screen.getByText('No calls yet.')).toBeTruthy();
    expect(screen.getByText('pbp_test_Ab12Cd_…')).toBeTruthy();
    expect(screen.getByText('Test only')).toBeTruthy();
  });

  it('done: the time, the pass fan and every card filled', () => {
    render(<Workbench home={homeDone} loadCalls={noCalls} />);
    expect(screen.getByTestId('wb-track-time').textContent).toBe('First pass in 3:22');
    expect(screen.queryByRole('link', { name: 'Continue' })).toBeNull();
    expect(screen.getAllByRole('link', { name: /QS-104/ })).toHaveLength(3);
    expect(screen.getByText('Rolling')).toBeTruthy();
    expect(screen.getByText('hooks.example.dev')).toBeTruthy();
    expect(document.querySelector('.wb-meter')?.getAttribute('data-used')).toBe('2');
    expect(screen.getByText('of 500')).toBeTruthy();
  });

  it('closed: no track, no New key, the reopen window', () => {
    render(<Workbench home={homeClosed} loadCalls={noCalls} />);
    expect(screen.queryByRole('heading', { name: 'Quickstart' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New key' })).toBeNull();
    expect(screen.getByTestId('wb-closed').textContent).toBe('Closed 2 d ago. Reopen within 28 d.');
    expect(screen.getByText('Keys stopped when the sandbox closed.')).toBeTruthy();
  });

  it('filters calls by source with one log read per source', async () => {
    const load = vi.fn(async () => [homeProgressed.calls[3]].filter((c) => c !== undefined));
    render(<Workbench home={homeProgressed} loadCalls={load} />);
    const calls = screen.getByRole('region', { name: 'Calls' });
    expect(within(calls).getAllByRole('link').length).toBeGreaterThan(5);
    await userEvent.click(within(calls).getByRole('button', { name: 'Run here' }));
    await waitFor(() =>
      expect(within(calls).getByText('Run here', { selector: '.sr' })).toBeTruthy(),
    );
    await userEvent.click(within(calls).getByRole('button', { name: 'All' }));
    await userEvent.click(within(calls).getByRole('button', { name: 'Run here' }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('try');
  });
});

describe('after Reset', () => {
  it('reads the new home as soon as Reset succeeds, and the Calls card shows its calls', async () => {
    vi.doMock('../console/turnstile.ts', () => ({ verify: async () => 'token' }));
    vi.doMock('../console/sandbox-actions.ts', async (orig) => ({
      ...(await orig<typeof import('../console/sandbox-actions.ts')>()),
      resetSandbox: async () => ({
        secret: 'pbp_test_NEW',
        deleted: { passes: 1, captures: 1, calls: 38 },
        resetsLeft: 2,
      }),
    }));
    vi.resetModules();
    const { Workbench: Fresh } = await import('./workbench.tsx');
    const { updateSession: set } = await import('../console/session.ts');
    set({
      kind: 'ready',
      csrf: 'c',
      siteKey: 'k',
      sandbox: { id: 's', orgSlug: 'x', templateId: null },
    });
    const onChanged = vi.fn();
    const { rerender } = render(
      <Fresh home={homeProgressed} loadCalls={noCalls} onChanged={onChanged} />,
    );
    const calls = screen.getByRole('region', { name: 'Calls' });
    expect(within(calls).getAllByRole('link').length).toBeGreaterThan(5);
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    await screen.findByText(/Reset\. Deleted 1 pass/);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The refreshed home has no calls: the card follows it at once.
    rerender(
      <Fresh home={{ ...homeProgressed, calls: [] }} loadCalls={noCalls} onChanged={onChanged} />,
    );
    await waitFor(() => expect(within(calls).getByText('No calls yet.')).toBeTruthy());
    vi.doUnmock('../console/turnstile.ts');
    vi.doUnmock('../console/sandbox-actions.ts');
  });
});

describe('Reset and Reopen panels', () => {
  const mockActions = async () => {
    vi.doMock('../console/turnstile.ts', () => ({ verify: async () => 'token' }));
    vi.doMock('../console/sandbox-actions.ts', async (orig) => ({
      ...(await orig<typeof import('../console/sandbox-actions.ts')>()),
      resetSandbox: async () => ({ secret: 'pbp_test_NEW', deleted: { passes: 0 }, resetsLeft: 2 }),
      reopenSandbox: async () => ({ secret: 'pbp_test_REOPENED' }),
    }));
    vi.resetModules();
    const { updateSession: set } = await import('../console/session.ts');
    set({
      kind: 'ready',
      csrf: 'c',
      siteKey: 'k',
      sandbox: { id: 's', orgSlug: 'x', templateId: null },
    });
    return (await import('./workbench.tsx')).Workbench;
  };
  afterEach(() => {
    vi.doUnmock('../console/turnstile.ts');
    vi.doUnmock('../console/sandbox-actions.ts');
  });

  it('puts the Reset confirm on its own row below the buttons, not between them', async () => {
    const Fresh = await mockActions();
    const { container } = render(<Fresh home={homeProgressed} loadCalls={noCalls} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    const confirm = await screen.findByRole('region', { name: 'Reset this sandbox?' });
    expect(container.querySelector('.wb-head-actions')?.contains(confirm)).toBe(false);
    expect(container.querySelector('.wb-head')?.contains(confirm)).toBe(true);
  });

  it('keeps the new key on screen when the refreshed home flips the sandbox from closed to open', async () => {
    const Fresh = await mockActions();
    const onChanged = vi.fn();
    const { rerender } = render(
      <Fresh home={homeClosed} loadCalls={noCalls} onChanged={onChanged} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await screen.findByText('Reopened. Your key was replaced.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    rerender(<Fresh home={homeProgressed} loadCalls={noCalls} onChanged={onChanged} />);
    expect(screen.getByText(/PASSBOOK_KEY=pbp_test_REOPENED/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/pbp_test_REOPENED/)).toBeNull();
  });
});

describe('WorkbenchIsland', () => {
  it('reads the home once and renders it; a refusal says so', async () => {
    const fetchFn = vi.fn(async () => Response.json(homeFresh));
    render(<WorkbenchIsland fetchFn={fetchFn} />);
    expect(await screen.findByRole('heading', { name: homeFresh.sandbox?.name })).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/developer/home', expect.anything());
  });

  it('offers Retry on a failure, and no Retry for no access', async () => {
    const failing = vi.fn(async () => new Response(null, { status: 500 }));
    const { unmount } = render(<WorkbenchIsland fetchFn={failing} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(failing).toHaveBeenCalledTimes(2);
    unmount();
    render(<WorkbenchIsland fetchFn={async () => new Response(null, { status: 403 })} />);
    expect(await screen.findByText(/No developer access/)).toBeTruthy();
  });
});

describe('the workbench island mount', () => {
  const page = () => {
    document.body.innerHTML =
      '<div class="hero"><h1>Hero</h1></div><div id="workbench" data-island="workbench"><section><p>Signed-out card</p></section></div>';
    return document.getElementById('workbench') as HTMLElement;
  };
  const hero = () => document.querySelector<HTMLElement>('.hero');
  afterEach(() => document.body.replaceChildren());

  it('leaves the signed-out card in the slot when signed out', async () => {
    updateSession({ kind: 'out' });
    const el = page();
    await mount(el);
    expect(el.textContent).toBe('Signed-out card');
    expect(hero()?.textContent).toBe('Hero');
  });

  it('leaves it alone without developer access', async () => {
    updateSession({ kind: 'none', csrf: 'c', siteKey: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const el = page();
    await mount(el);
    expect(el.textContent).toBe('Signed-out card');
    expect(hero()?.textContent).toBe('Hero');
  });

  it('takes the card place for a developer, committed before mount resolves, and never touches the hero', async () => {
    updateSession({ kind: 'none', csrf: 'c', siteKey: '' });
    const fetchFn = vi.fn(async () => Response.json(homeFresh));
    vi.stubGlobal('fetch', fetchFn);
    const el = page();
    const heroNode = hero();
    await act(() => mount(el));
    // Synchronous: no frame where the card is gone and the Workbench is not there yet, or the reverse.
    expect(el.textContent).not.toContain('Signed-out card');
    expect(el.querySelector('.wb')).not.toBeNull();
    expect(hero()).toBe(heroNode);
    expect(hero()?.textContent).toBe('Hero');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(await screen.findByRole('heading', { name: homeFresh.sandbox?.name })).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('header chip after Reset or Reopen', () => {
  it('syncChip turns a closed session into a ready one from the same home', async () => {
    const { onSession, loadSession: load } = await import('../console/session.ts');
    const { syncChip } = await import('./island.tsx');
    updateSession({ kind: 'closed', csrf: 'c' });
    const kinds: string[] = [];
    const stop = onSession((s) => kinds.push(s.kind));
    await syncChip(homeFresh);
    expect(kinds).toEqual(['ready']);
    expect((await load()).kind).toBe('ready');
    await syncChip(homeClosed);
    expect(kinds).toEqual(['ready', 'closed']);
    stop();
  });
});
