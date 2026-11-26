import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBudget, spend } from '../console/budget.ts';
import { SandboxChip } from './sandbox-chip.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => vi.resetModules());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  resetBudget();
});

const ready = { kind: 'ready', slug: 'acme' } as const;

describe('the sandbox chip', () => {
  it('names the sandbox and opens its menu: the Workbench home, the quickstart, Start over, Delete', () => {
    render(<SandboxChip variant="strip" state={ready} />);
    const face = screen.getByRole('button', { name: 'Sandbox menu' });
    expect(face.getAttribute('title')).toBe(
      'Your test sandbox: acme. New emails go to the Test inbox.',
    );
    expect(face.textContent).toContain('acme');
    expect(face.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(face);
    expect(face.getAttribute('aria-expanded')).toBe('true');
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Workbench home', '/developers#workbench'],
      ['Quickstart', '/developers/quickstart#sandbox'],
      ['Start over', '/developers/quickstart#start-over'],
      ['Delete sandbox', '/developers/quickstart#delete-sandbox'],
    ]);
    // Focus goes into the menu; arrows move it and wrap.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(items[3] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    // Escape closes it and gives focus back to the chip.
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'Escape' });
    expect(screen.getByRole('menu', { hidden: true }).hidden).toBe(true);
    expect(document.activeElement).toBe(face);
  });

  it('opens from the keyboard, and closes on a choice or a press outside', () => {
    render(<SandboxChip variant="strip" state={ready} />);
    const face = screen.getByRole('button', { name: 'Sandbox menu' });
    fireEvent.keyDown(face, { key: 'ArrowDown' });
    expect(face.getAttribute('aria-expanded')).toBe('true');
    // A hash-only link leaves the page where it is: the menu closes anyway.
    const item = screen.getAllByRole('menuitem')[2] as HTMLAnchorElement;
    item.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(item);
    expect(face.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(face);
    fireEvent.pointerDown(document.body);
    expect(face.getAttribute('aria-expanded')).toBe('false');
  });

  it('rings the mark and leads the menu with a running operation on the sandbox', () => {
    const { container } = render(
      <SandboxChip
        variant="strip"
        state={{
          ...ready,
          activity: { title: 'Delete sandbox', text: 'Removing Test passes · 4 of 12' },
        }}
      />,
    );
    expect(container.querySelector('.sbx')?.hasAttribute('data-busy')).toBe(true);
    const face = screen.getByRole('button', { name: 'Sandbox menu: Delete sandbox, running' });
    fireEvent.click(face);
    expect(screen.getByRole('menu').textContent).toContain(
      'Delete sandboxRemoving Test passes · 4 of 12',
    );
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
  });

  it('is the way to make a sandbox, or says it is closed', () => {
    const { rerender } = render(<SandboxChip variant="bar" state={{ kind: 'none' }} />);
    const link = screen.getByRole('link', { name: 'Create sandbox' });
    expect(link.getAttribute('href')).toBe('/developers/quickstart#sandbox');
    rerender(<SandboxChip variant="bar" state={{ kind: 'closed' }} />);
    expect(screen.getByRole('link', { name: 'Sandbox closed' })).toBeTruthy();
  });

  it('carries the Run budget in the bar, repainting as runs are spent', () => {
    render(<SandboxChip variant="bar" state={ready} />);
    expect(screen.getByRole('button', { name: 'Sandbox menu' }).textContent).toBe('ASandbox');
    const meter = screen.getByRole('meter', { name: 'Runs left this minute' });
    expect(meter.getAttribute('aria-valuenow')).toBe('60');
    act(() => {
      for (let i = 0; i < 52; i++) spend();
    });
    expect(meter.getAttribute('aria-valuenow')).toBe('8');
    expect(meter.querySelector('.budget-label')?.textContent).toBe('8/60 per min');
    expect(meter.dataset.low).toBe('true');
  });
});

describe('the top bar chip island', () => {
  const mountWith = async (table: Record<string, Response>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => table[url]?.clone() ?? json({}, 404)),
    );
    document.body.innerHTML = '<span id="host"><a>Sign in</a></span>';
    const host = document.getElementById('host') as HTMLElement;
    const { barChipIsland } = await import('./mount.tsx');
    await act(async () => barChipIsland.mount(host));
    return host;
  };
  const authed = json({ authenticated: true, csrfToken: 'c', roles: ['developer'] });

  it('stays hidden for a signed-out visitor', async () => {
    const host = await mountWith({ '/api/v1/session': json({ authenticated: false }) });
    expect(host.hidden).toBe(true);
    expect(host.textContent).toBe('Sign in');
  });

  it('shows the sandbox with its menu', async () => {
    const host = await mountWith({
      '/api/v1/session': authed,
      '/api/v1/developer/sandbox': json({ sandbox: { id: 's', orgId: 'o', orgSlug: 'acme' } }),
    });
    expect(host.hidden).toBe(false);
    expect(within(host).getByRole('button', { name: 'Sandbox menu' })).toBeTruthy();
    expect(within(host).getByRole('meter')).toBeTruthy();
  });
});
