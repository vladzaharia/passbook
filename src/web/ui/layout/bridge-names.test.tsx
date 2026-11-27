import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BridgeChip } from './bridge-chip.tsx';
import { OpenInWorkbench } from './open-in-workbench.tsx';
import { SidebarFoot } from './sidebar-foot.tsx';

vi.mock('../../lib/workbench-bridge.ts', () => ({
  QUIET_AFTER: 3,
  bridgeLabel: () => 'Events',
  useBridgeOrigin: () => ({ return: '/workbench/events', hops: 0 }),
  useWorkbenchBridge: () => ({ orgId: 'o1', records: true, href: () => '/workbench' }),
}));

const visible = (el: HTMLElement) =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

describe('Workbench bridge accessible names (label-content-name-mismatch)', () => {
  it.each([
    ['sidebar foot', <SidebarFoot key="f" />, 'Workbench'],
    ['open in workbench', <OpenInWorkbench key="o" tool="home" />, 'Open in Workbench'],
    ['origin chip', <BridgeChip key="c" />, 'Events'],
  ])('%s name contains its visible text', (_n, ui, name) => {
    render(ui);
    const link = screen.getByRole('link', { name: new RegExp(name, 'i') });
    const label = (link.getAttribute('aria-label') ?? '').toLowerCase();
    if (label) expect(label).toContain(visible(link));
  });
});
