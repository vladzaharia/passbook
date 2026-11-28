import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { DesignIndex } from './design-index.tsx';

let items: unknown[] = [];
vi.mock('../host/tool-host.tsx', () => ({
  useToolHost: () => ({ context: { kind: 'org', orgId: 'org-1' } }),
}));
vi.mock('../../lib/tool-api.tsx', () => ({
  useToolKey: () => ['test'],
  useToolApi: () => ({ get: async () => ({ items }) }),
}));
vi.mock('../shell/tool-page.tsx', () => ({
  ToolPage: (p: { children: ReactNode; primary?: ReactNode; count?: string }) => (
    <div>
      <span>{p.count}</span>
      {p.primary}
      {p.children}
    </div>
  ),
}));
vi.mock('../states/states.tsx', () => ({
  ToolEmpty: (p: { action: ReactNode }) => <div>No templates{p.action}</div>,
  ToolFailed: () => <div>failed</div>,
}));
vi.mock('../../ui/row-link.tsx', () => ({
  RowLink: (p: { children: ReactNode }) => <a href="/x">{p.children}</a>,
}));

function tpl(id: string, name: string, orgId: string, status = 'active') {
  return { id, name, orgId, status, passCount: 1, fromBlueprint: null };
}

function renderIndex() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DesignIndex />
    </QueryClientProvider>,
  );
}

describe('DesignIndex', () => {
  it('empty: the empty state holds the blueprint action', async () => {
    items = [];
    renderIndex();
    expect(await screen.findByText('No templates')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start from a blueprint' })).toBeTruthy();
  });

  it('lists only this org’s live templates', async () => {
    items = [
      tpl('a', 'Mine', 'org-1'),
      tpl('b', 'Shared', 'other'),
      tpl('c', 'Gone', 'org-1', 'deleted'),
    ];
    renderIndex();
    await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy());
    expect(screen.queryByText('Shared')).toBeNull();
    expect(screen.queryByText('Gone')).toBeNull();
    expect(screen.getByText('1 template')).toBeTruthy();
  });
});
