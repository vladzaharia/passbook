import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { JoinLinkDto, JoinLinkState } from '@/shared/contracts/join.ts';
import { TooltipProvider } from '../../../ui/index.ts';

export const URL_OK = 'https://passbook.mobile/j/AAAAAAAAAAAAAAAAAAAAAA';

export const link = (over: Partial<JoinLinkDto> = {}): JoinLinkDto => ({
  id: 'jl-1',
  templateId: 'tpl-1',
  mode: 'live',
  enabled: true,
  nameInput: 'memberName',
  nameInputs: [{ key: 'memberName', label: 'Member' }],
  askEmail: false,
  generated: [],
  dailyLimit: 200,
  issuedToday: 12,
  limitReached: false,
  url: URL_OK,
  ready: true,
  issues: [],
  revision: 3,
  createdAt: 1,
  rotatedAt: null,
  ...over,
});

export const stateOf = (
  l: JoinLinkDto | null,
  over: Partial<JoinLinkState> = {},
): JoinLinkState => ({
  link: l,
  ready: l?.ready ?? true,
  issues: l?.issues ?? [],
  ...over,
});

/** The card needs a router for its links; a bare one with the three routes they point at. */
export function mount(ui: ReactNode) {
  const root = createRootRoute({ component: () => <main>{ui}</main> });
  const routes = [
    '/admin/templates/$templateId',
    '/admin/templates/$templateId/design',
    '/admin/templates/$templateId/join-sign',
  ].map((path) => createRoute({ getParentRoute: () => root, path, component: () => null }));
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
