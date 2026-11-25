import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../../lib/test-utils.tsx';
import type { VersionReleases } from './releases/version-info.ts';
import { VersionList, visibleVersions } from './version-list.tsx';

type Template = ComponentProps<typeof VersionList>['template'];

const DAY = 86_400_000;
const hash = (n: number) => `version-${n}`;
const versions = (count: number, extra: Record<number, object> = {}) =>
  Array.from({ length: count }, (_, i) => ({
    version: hash(i + 1),
    active: i + 1 === 2,
    createdAt: 1_700_000_000_000 + i * DAY,
    createdBy: null,
    displayOnly: false,
    assets: [],
    report: { ok: true, issues: [] },
    passCount: 0,
    ...extra[i + 1],
  }));
const template = (count: number, extra: Record<number, object> = {}) =>
  ({
    id: 't1',
    orgId: 'org1',
    passesOnOlderVersions: 0,
    versions: versions(count, extra),
  }) as unknown as Template;

const info = (over: Partial<VersionReleases> = {}): VersionReleases => ({
  orgId: 'org1',
  live: hash(2),
  test: hash(2),
  releasedAt: new Map([[hash(2), 1_700_100_000_000]]),
  releaseOf: new Map(),
  selfApproved: new Set(),
  restore: new Map(),
  busy: false,
  ...over,
});

function mount(t: Template, releases: VersionReleases | null, draft?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VersionList template={t} releases={releases} draft={draft} onReport={() => undefined} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('visibleVersions', () => {
  it('keeps the pinned versions and the newest three others, newest first', () => {
    const newest = [...versions(8)].reverse();
    const shown = visibleVersions(newest, new Set([hash(2)]), false).map((v) => v.version);
    expect(shown).toEqual([hash(8), hash(7), hash(6), hash(2)]);
    expect(visibleVersions(newest, new Set([hash(2)]), true)).toHaveLength(8);
  });
});

describe('version list', () => {
  it('shows Live and Test as badges, the release date, and passes only above zero', async () => {
    mount(
      template(3, {
        2: { passCount: 4 },
        3: { report: { ok: true, issues: [{ severity: 'warning' }] } },
      }),
      info(),
    );
    const rows = within(screen.getByRole('list', { name: 'Versions' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('v3'),
      expect.stringContaining('v2'),
      expect.stringContaining('v1'),
    ]);
    expect(rows[0]).toHaveTextContent('1 warning');
    expect(rows[0]).toHaveTextContent(/Saved/);
    expect(rows[0]).not.toHaveTextContent('pass');
    expect(rows[1]).toHaveTextContent('Live');
    expect(rows[1]).toHaveTextContent('Test');
    expect(rows[1]).toHaveTextContent(/Released.*· 4 passes/);
    expect(screen.queryByText('System')).toBeNull();
  });

  it('collapses to Live, the draft and three more, and expands on request', async () => {
    const user = userEvent.setup();
    mount(template(9), info(), hash(9));
    const list = screen.getByRole('list', { name: 'Versions' });
    // Draft v9, the newest three others (v8, v7, v6), and Live v2.
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Draft');
    await user.click(screen.getByRole('button', { name: 'Show all 9 versions' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('has one menu per row: Release, Restore, Compare, Report and Technical details', async () => {
    const user = userEvent.setup();
    const restore = vi.fn();
    const onRelease = vi.fn();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <VersionList
          template={template(3)}
          releases={info({ restore: new Map([[hash(1), restore]]) })}
          onRelease={onRelease}
          onReport={() => undefined}
        />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions for v1' }));
    const names = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(names).toEqual(['Release', 'Restore', 'Compare', 'Report', 'Technical details']);
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
    expect(restore).toHaveBeenCalledTimes(1);
    // Live has nothing to release, restore or compare against itself.
    await user.click(screen.getByRole('button', { name: 'Actions for v2' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Report',
      'Technical details',
    ]);
  });

  it('opens what a version changes against Live in a side sheet', async () => {
    const user = userEvent.setup();
    stubFetch({
      '/api/v1/templates/t1/release': () =>
        json({
          version: hash(3),
          modes: { live: { outcome: 'released', from: hash(2), impact: null } },
          diff: [
            {
              group: 'colors',
              more: 0,
              rows: [
                {
                  kind: 'changed',
                  label: 'Background',
                  from: { type: 'color', color: '#111111' },
                  to: { type: 'color', color: '#222222' },
                },
              ],
            },
          ],
          fromVersion: hash(2),
          state: {},
        }),
    });
    mount(template(3), info());
    await user.click(screen.getByRole('button', { name: 'Actions for v3' }));
    await user.click(screen.getByRole('menuitem', { name: 'Compare' }));
    const sheet = await screen.findByRole('dialog', { name: 'v3 changes' });
    expect(await within(sheet).findByText('Background')).toBeInTheDocument();
    expect(sheet).toHaveTextContent('v3 against v2 (Live)');
  });
});
