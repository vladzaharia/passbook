import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { axe } from 'vitest-axe';
import type { Tag, TagBinding } from '@/shared/contracts/nfc-tags.ts';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import { type FetchHandler, json, sessionFixture, stubFetch } from '@/web/lib/test-utils.tsx';
import type { Enrollment } from './enroll-api.ts';

export const NOW = 1_800_000_000_000;

export function bindingFixture(over: Partial<TagBinding> = {}): TagBinding {
  return {
    id: 'b1',
    tagId: 't1',
    scope: 'pass',
    passId: 'p1',
    passTitle: 'Gym pass',
    userId: null,
    holderName: null,
    source: 'scanner',
    lent: false,
    boundAt: NOW - 86_400_000,
    boundByName: 'Ana R.',
    scannerName: 'Front desk iPad',
    endedAt: null,
    endCause: null,
    ...over,
  };
}

export function tagFixture(over: Partial<Tag> = {}): Tag {
  return {
    id: 't1',
    mode: 'live',
    kind: 'uid',
    assurance: 'basic',
    hint: '7F3A',
    label: 'Blue fob',
    pool: false,
    status: 'active',
    state: 'assigned',
    createdAt: NOW - 86_400_000,
    lastSeenAt: null,
    keysetId: null,
    binding: bindingFixture(),
    ...over,
  };
}

export const personTag = (over: Partial<Tag> = {}) =>
  tagFixture({
    id: 't2',
    label: 'Key card',
    hint: '1B09',
    binding: bindingFixture({
      id: 'b2',
      tagId: 't2',
      scope: 'user',
      userId: 'u9',
      holderName: 'Maya Okafor',
      boundAt: NOW,
    }),
    ...over,
  });

export const scannerFixture = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Front desk iPad',
  sessionName: 'Front desk',
  role: 'desk',
  online: true,
  unavailable: null,
  secureOnly: false,
  lastUsedAt: null,
  ...over,
});

export function enrollmentFixture(over: Partial<Enrollment> = {}): Enrollment {
  return {
    id: 'e1',
    passId: 'p1',
    scannerId: 's1',
    scannerName: 'Front desk iPad',
    scope: 'pass',
    state: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    endedAt: null,
    binding: null,
    errorCode: null,
    shownAt: null,
    hint: null,
    ...over,
  };
}

export const page = (items: unknown[]) => json({ items, nextCursor: null });

/** The viewports and themes every tag surface is checked in. */
export const AXE_MATRIX = [1440, 820, 390].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => [width, theme] as const),
);

export async function axeAt(container: HTMLElement, width: number, theme: 'light' | 'dark') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  document.documentElement.dataset.theme = theme;
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
  try {
    return (await axe(container)).violations;
  } finally {
    delete document.documentElement.dataset.theme;
  }
}

/** Renders `ui` inside the providers and a router (rows link to users and passes). */
export function renderTags(ui: ReactNode, handlers: Record<string, FetchHandler> = {}) {
  const fetchMock = stubFetch({
    '/api/v1/session': () => json(sessionFixture('admin')),
    ...handlers,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const root = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, fetchMock, queryClient };
}

export const calls = (m: ReturnType<typeof stubFetch>, method: string, suffix: string) =>
  m.mock.calls.filter(
    ([u, init]) => String(u).split('?')[0]?.endsWith(suffix) && (init?.method ?? 'GET') === method,
  );
