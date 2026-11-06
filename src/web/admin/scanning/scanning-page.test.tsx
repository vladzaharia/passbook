import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { ENTITY } from '@/web/lib/entities.ts';
import { ADMIN_NAV, ADMIN_NAV_GROUPS, isOrgScoped } from '@/web/lib/nav.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { ScanLink } from './scan-link.tsx';

const empty = () => json({ items: [], nextCursor: null });
const handlers = {
  '/api/v1/scanners': empty,
  '/api/v1/scan-events': empty,
  '/api/v1/scan-staff': empty,
  '/api/v1/scans': empty,
};

describe('Scanning nav and entities', () => {
  it('puts Scanning in the Messages group, scoped to the org', () => {
    const item = ADMIN_NAV.find((i) => i.to === '/admin/scanning');
    expect(item).toMatchObject({ label: 'Scanning', orgScoped: true, entity: 'scanner' });
    const group = ADMIN_NAV_GROUPS.find((g) => g.some((i) => i.to === '/admin/scanning'));
    expect(group?.map((i) => i.label)).toEqual(['Messages', 'Scanning', 'Test inbox']);
    expect(isOrgScoped('/admin/scanning')).toBe(true);
    expect(isOrgScoped('/admin/scanning/scanners/s1')).toBe(true);
  });

  it('names the scanning entities and gives "Event" to the occasion', () => {
    expect(ENTITY.scanner.label).toBe('Scanner');
    expect(ENTITY.event.label).toBe('Event');
    expect(ENTITY.staff.plural).toBe('staff');
    expect(ENTITY.activity).toMatchObject({ label: 'Entry', plural: 'entries' });
  });
});

describe('Scanning page', () => {
  it('shows the empty scanners tab with its one primary', async () => {
    const { container } = await renderApp('/admin/scanning', { session: 'admin', handlers });
    expect(await screen.findByRole('heading', { name: 'Scanning', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('No scanners yet')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Scanners' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('button', { name: 'New scanner' })).toHaveLength(2);
    expect((await axe(container)).violations).toEqual([]);
  });

  it.each([
    ['events', 'No events yet'],
    ['staff', 'No staff yet'],
    ['scans', 'No scans yet'],
  ])('renders the %s tab with its empty state', async (tab, title) => {
    const { container } = await renderApp(`/admin/scanning?tab=${tab}`, {
      session: 'admin',
      handlers,
    });
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps the filters in the URL when the tab changes', async () => {
    const { router } = await renderApp(
      '/admin/scanning?tab=scans&scannerId=s1&outcome=refused&orgId=o1',
      { session: 'admin', handlers },
    );
    await screen.findByText('No scans yet');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Events' }));
    await screen.findByText('No events yet');
    expect(router.state.location.search).toMatchObject({
      tab: 'events',
      scannerId: 's1',
      outcome: 'refused',
      orgId: 'o1',
    });
  });

  it('leaves the default tab out of the URL', async () => {
    const { router } = await renderApp('/admin/scanning?tab=staff', {
      session: 'admin',
      handlers,
    });
    await screen.findByText('No staff yet');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Scanners' }));
    await screen.findByText('No scanners yet');
    expect(router.state.location.search).not.toHaveProperty('tab');
  });

  it('ignores an unknown tab', async () => {
    await renderApp('/admin/scanning?tab=nope', { session: 'admin', handlers });
    expect(await screen.findByText('No scanners yet')).toBeInTheDocument();
  });

  it('links the event page back to Scanning with typed routes', async () => {
    await renderApp('/admin/scanning/events/e1', { session: 'admin', handlers });
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const link = within(crumbs).getByRole('link', { name: 'Scanning' });
    const destination = new URL(link.getAttribute('href') ?? '', 'https://wallet.test');
    expect(destination.pathname).toBe('/admin/scanning');
  });
});

describe('links to /scan', () => {
  it('are plain anchors: /scan is its own document', () => {
    render(<ScanLink event="e1">Open scanner</ScanLink>);
    const link = screen.getByRole('link', { name: 'Open scanner' });
    expect(link).toHaveAttribute('href', '/scan?event=e1');
  });

  it('never go through the router', () => {
    const dir = join(process.cwd(), 'src/web/admin/scanning');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.tsx?$/.test(n) && !n.includes('.test.') ? [p] : [];
      });
    for (const path of walk(dir)) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(/\bto[=:]\s*\{?['"]\/scan(['"?#/])/);
    }
  });
});
