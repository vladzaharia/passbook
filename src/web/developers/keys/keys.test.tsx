import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SANDBOX_KEY_SCOPES } from '../../../shared/contracts/developer-home.ts';
import {
  KEY_PRESETS,
  presetOf,
  presetsWithin,
  SANDBOX_CEILING,
} from '../../../shared/developers-keys.ts';
import { HIDE_MS } from '../ui/reveal-sheet.tsx';
import { homeDone, NOW } from '../workbench/home-fixtures.ts';
import { type KeyApi, KeyError } from './api.ts';
import { KeysPage } from './keys-page.tsx';
import { maskSecret } from './model.ts';

const SECRET = 'pbp_test_demo0001_demo-demo-demo-demo';
const DAY = 86_400_000;

beforeAll(() => {
  // jsdom has no modal dialogs.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const minted = (over: Record<string, unknown> = {}) => ({
  id: 'k-new',
  orgId: homeDone.sandbox?.orgId,
  name: 'CI issuer',
  scopes: ['passes:read', 'passes:write', 'templates:read'],
  secret: SECRET,
  ...over,
});

function api(over: Partial<KeyApi> = {}): KeyApi {
  return {
    mint: vi.fn(async () => minted() as never),
    roll: vi.fn(
      async () =>
        ({
          key: minted({ name: 'Sandbox key' }),
          previous: { retireAt: NOW + 3_600_000 },
        }) as never,
    ),
    revoke: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function page(a: KeyApi, hash = '') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(homeDone)),
  );
  return render(<KeysPage initial={homeDone} csrf="c" api={a} now={() => NOW} hash={hash} />);
}

/** Every string held in the React tree's props and hook state under `root`. */
function heldStrings(root: Element): string[] {
  const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  let fiber = (root as unknown as Record<string, { return: unknown }>)[key ?? ''] as
    | Record<string, unknown>
    | undefined;
  while (fiber?.return) fiber = fiber.return as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object' && depth < 6 && !seen.has(v) && !(v instanceof Node)) {
      seen.add(v);
      for (const k of Object.keys(v))
        if (k !== 'return' && k !== 'stateNode') walk((v as never)[k], depth + 1);
    }
  };
  const visit = (f: Record<string, unknown> | null | undefined) => {
    for (let n = f; n; n = n.sibling as Record<string, unknown> | null) {
      walk(n.memoizedProps, 0);
      walk(n.memoizedState, 0);
      visit(n.child as Record<string, unknown> | null);
    }
  };
  visit(fiber);
  return out;
}

describe('the shared preset map', () => {
  it('fits under the sandbox ceiling, which holds no key minting or terminal scope', () => {
    // The till acts as a terminal, which a sandbox key cannot, so the portal hides it.
    for (const p of presetsWithin(SANDBOX_CEILING))
      for (const s of p.scopes) expect(SANDBOX_KEY_SCOPES).toContain(s);
    expect(presetsWithin(SANDBOX_CEILING).length).toBe(KEY_PRESETS.length - 1);
    for (const banned of ['api-keys:write', 'scans:write', 'scanning:admin'])
      expect(SANDBOX_CEILING).not.toContain(banned);
    expect(presetOf(['templates:read', 'passes:write', 'passes:read'])).toBe('Issue passes');
    expect(presetOf(SANDBOX_CEILING)).toBe('Full sandbox');
    expect(presetOf(['passes:read'])).toBeNull();
  });
});

describe('Keys page', () => {
  it('lists the sandbox keys masked, with access, expiry and last use', () => {
    page(api());
    // The frame's title row has the h1; the page gives it the count (in place here: no frame).
    expect(screen.getByText(/^\d+ keys?$/)).toBeTruthy();
    const row = screen.getByText('Sandbox key').closest('tr') as HTMLElement;
    expect(within(row).getByText('pbp_test_Ab12Cd_…')).toBeTruthy();
    expect(within(row).getByText('Issue passes')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Roll' })).toBeTruthy();
    // A rolling key has no Roll of its own.
    const ci = screen.getByText('CI').closest('tr') as HTMLElement;
    expect(within(ci).queryByRole('button', { name: 'Roll' })).toBeNull();
    expect(within(ci).getByText('Rolling')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Rain City Fit/ }).getAttribute('href')).toBe(
      '/admin/o/019a-live-2/api-keys',
    );
  });

  it('mints a personal Test key under the ceiling, shows it once, hides it after Copy and clears it on Done', async () => {
    const a = api();
    const user = userEvent.setup();
    page(a);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'CI issuer');
    await user.click(screen.getByRole('radio', { name: /Issue passes/ }));
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(a.mint).toHaveBeenCalledWith({
      orgId: homeDone.sandbox?.orgId,
      name: 'CI issuer',
      scopes: ['passes:read', 'passes:write', 'templates:read'],
      expiresAt: expect.any(Number),
    });
    const call = (a.mint as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { expiresAt: number };
    expect(Math.abs(call.expiresAt - Date.now() - 7 * DAY)).toBeLessThan(60_000);
    // Shown once.
    expect(screen.getByTestId('ks-secret').textContent).toBe(`PASSBOOK_KEY=${SECRET}`);
    expect(screen.getByText('Shown once')).toBeTruthy();
    // The scan can see it while shown.
    expect(heldStrings(screen.getByTestId('ks-secret')).some((v) => v.includes(SECRET))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Copy .env' }));
    expect(await navigator.clipboard.readText()).toBe(`PASSBOOK_KEY=${SECRET}`);
    await waitFor(() =>
      expect(screen.getByTestId('ks-secret').textContent).toContain(maskSecret(SECRET)),
    );
    // After Copy no props or hook state anywhere in the tree holds the secret.
    expect(heldStrings(screen.getByTestId('ks-secret')).some((v) => v.includes(SECRET))).toBe(
      false,
    );
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByText('Paste it into .env, then clear your clipboard.')).toBeTruthy();
    // Copied: nothing to show again.
    expect(screen.queryByRole('button', { name: 'Show again' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('ks-secret')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('hides an uncopied key after 60 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    page(api());
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'CI issuer');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByTestId('ks-secret').textContent).toContain(SECRET);
    // Not copied: the sheet does not close on Escape (the key would be lost).
    await act(async () => {
      screen
        .getByRole('dialog', { hidden: true })
        .dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(screen.getByTestId('ks-secret')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByText('Copy the key first. It is not shown again.')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(HIDE_MS + 100);
    });
    expect(document.body.textContent).not.toContain(SECRET);
    // Still open and uncopied: Show again brings it back, and the timer starts over.
    await user.click(screen.getByRole('button', { name: 'Show again' }));
    expect(screen.getByTestId('ks-secret').textContent).toContain(SECRET);
  });

  it('Pick scopes offers only the sandbox ceiling and needs one scope', async () => {
    const a = api();
    const user = userEvent.setup();
    page(a);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'x');
    await user.click(screen.getByRole('radio', { name: 'Pick scopes' }));
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(SANDBOX_CEILING.length);
    expect(document.body.textContent).not.toContain('api-keys:write');
    expect(document.body.textContent).not.toContain('scans:write');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByText('Pick at least one scope.')).toBeTruthy();
    expect(a.mint).not.toHaveBeenCalled();
    await user.click(boxes[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(a.mint).toHaveBeenCalledWith(expect.objectContaining({ scopes: [SANDBOX_CEILING[0]] }));
  });

  it('a stale sign-in shows one link to Polaris ID that returns to the page', async () => {
    const a = api({
      mint: vi.fn(async () => {
        throw new KeyError(
          403,
          'STEP_UP_REQUIRED',
          'Confirm.',
          '/auth/oidc/start?prompt=login&max_age=0&next=%2Fadmin',
        );
      }),
    });
    const user = userEvent.setup();
    page(a);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const link = await screen.findByRole('link', { name: 'Continue' });
    expect(link.getAttribute('href')).toBe(
      '/auth/oidc/start?prompt=login&max_age=0&next=%2Fdevelopers%2Fkeys%23new',
    );
  });

  it('a step-up url that is not a same-origin /auth/ path is not followed', async () => {
    const a = api({
      mint: vi.fn(async () => {
        throw new KeyError(403, 'STEP_UP_REQUIRED', 'x', 'https://x//evil.com/a');
      }),
    });
    const user = userEvent.setup();
    page(a);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const link = await screen.findByRole('link', { name: 'Continue' });
    expect(link.getAttribute('href')?.startsWith('/auth/')).toBe(true);
  });

  it('Roll keeps the access, reveals the new key once and says when the old one stops', async () => {
    const a = api();
    const user = userEvent.setup();
    page(a);
    const row = screen.getByText('Sandbox key').closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Roll' }));
    expect(screen.getByText('The old key stops in 1 hour.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Roll key' }));
    expect(a.roll).toHaveBeenCalledWith(homeDone.sandbox?.orgId, '019a-key-1', 1);
    expect(screen.getByTestId('ks-secret').textContent).toContain(SECRET);
    expect(screen.getByText(/The old key stops \d\d:\d\d\./)).toBeTruthy();
  });

  it('#<key id> opens the Roll sheet for an active key only', () => {
    page(api(), '#019a-key-1');
    expect(screen.getByRole('heading', { name: 'Roll Sandbox key?' })).toBeTruthy();
  });

  it('a replay that returns no secret says so instead of showing nothing', async () => {
    const a = api({ mint: vi.fn(async () => minted({ secret: undefined }) as never) });
    const user = userEvent.setup();
    page(a);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByText('The key was not returned. Roll it for a new one.')).toBeTruthy();
  });

  it('Revoke asks first', async () => {
    const a = api();
    const user = userEvent.setup();
    page(a);
    const row = screen.getByText('Sandbox key').closest('tr') as HTMLElement;
    await user.click(within(row).getByLabelText('More: Sandbox key'));
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    expect(a.revoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(a.revoke).toHaveBeenCalledWith(homeDone.sandbox?.orgId, '019a-key-1');
  });
});
