import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { createElement, Fragment, useState } from 'react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import { json, membershipFixture, sessionFixture, stubFetch } from '@/web/lib/test-utils.tsx';
import { EligibleTemplatePicker } from './eligible-template-picker.tsx';
import { useEligibleTemplates, useOrgTemplates, useScanEvents } from './scanner-api.ts';
import { eligibleTemplateFixture, NOW, templateFixture } from './test-fixtures.ts';

export const northwind = membershipFixture('o1', { orgName: 'Northwind' });
export const harbor = membershipFixture('o2', { orgName: 'Harbor' });
const event = {
  id: 'e1',
  orgId: 'o1',
  mode: 'live',
  name: 'Northwind event',
  templateIds: [],
  match: null,
  opensAt: NOW,
  closesAt: NOW + 3_600_000,
  timeZone: 'UTC',
  capacity: null,
  reentry: false,
  note: null,
  status: 'upcoming',
  arrived: 0,
  expected: 0,
  scanners: 0,
};

export function setup(
  requested: string | undefined,
  memberships: OrgMembership[] = [northwind, harbor],
  resource: 'events' | 'templates' | 'eligible' | 'choices' = 'events',
  resourceMode?: 'live' | 'test',
  initialSelected: string[] = [],
  holdLive = false,
) {
  localStorage.removeItem('wallet-org-filter');
  const requests: (string | null)[] = [];
  const eligibleRequests: URL[] = [];
  const detailRequests: string[] = [];
  const deferred = Promise as PromiseConstructor & {
    withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
  };
  const testMode = deferred.withResolvers<Response>();
  const liveMode = deferred.withResolvers<Response>();
  stubFetch({
    '/api/v1/scan-events': (url) => {
      requests.push(url.searchParams.get('orgId'));
      return json({
        items: [event, { ...event, id: 'e2', orgId: 'o2', name: 'Foreign event' }],
        nextCursor: null,
      });
    },
    '/api/v1/templates': (url) => {
      requests.push(url.searchParams.get('orgId'));
      return json({
        items: [
          templateFixture(),
          templateFixture({ id: 'shared', orgId: null, orgName: null, name: 'Shared ticket' }),
          templateFixture({ id: 'foreign', orgId: 'o2', name: 'Foreign ticket' }),
        ],
        nextCursor: null,
      });
    },
    '/api/v1/templates/eligible': (url) => {
      requests.push(url.searchParams.get('orgId'));
      eligibleRequests.push(url);
      if (url.searchParams.get('mode') === 'test') return testMode.promise;
      if (holdLive) return liveMode.promise;
      if (url.searchParams.get('cursor') === 'next') {
        return json({
          items: [eligibleTemplateFixture({ templateId: 'later', name: 'Later ticket' })],
          nextCursor: null,
        });
      }
      return json({
        items: [
          eligibleTemplateFixture(),
          eligibleTemplateFixture({
            templateId: 'shared',
            templateOrgId: null,
            origin: 'baked',
            name: 'Shared ticket',
          }),
          eligibleTemplateFixture({
            templateId: 'shared-uploaded',
            templateOrgId: null,
            origin: 'uploaded',
            name: 'Shared scoped ticket',
          }),
          eligibleTemplateFixture({
            templateId: 'foreign',
            templateOrgId: 'o2',
            name: 'Foreign ticket',
          }),
          eligibleTemplateFixture({
            templateId: 'value',
            name: 'Value only',
            supportsCheckIn: false,
          }),
        ],
        nextCursor: 'next',
      });
    },
    '/api/v1/templates/t1': (url) => {
      detailRequests.push(url.pathname);
      return json({});
    },
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  queryClient.setQueryData(['session'], sessionFixture('admin'));
  queryClient.setQueryData(['org-memberships', 'me'], { items: memberships });
  queryClient.setQueryData(['admin', 'scanning', 'events', 'options', 'o2', true], {
    items: [{ ...event, orgId: 'o2', name: 'Cached Harbor event' }],
    nextCursor: null,
  });
  queryClient.setQueryData(['admin', 'scanning', 'templates', 'o2', true], {
    items: [templateFixture({ orgId: 'o2', name: 'Cached Harbor template' })],
    nextCursor: null,
  });
  queryClient.setQueryData(['admin', 'scanning', 'events', 'options', null], {
    items: [{ ...event, name: 'Cached unscoped event' }],
    nextCursor: null,
  });
  queryClient.setQueryData(['admin', 'scanning', 'templates', null], {
    items: [templateFixture({ name: 'Cached unscoped template' })],
    nextCursor: null,
  });
  queryClient.setQueryData(
    ['admin', 'templates', 'eligible', 'scanning', 'o2', 'live', 'apple', true],
    {
      pages: [
        {
          items: [eligibleTemplateFixture({ templateOrgId: 'o2', name: 'Cached Harbor eligible' })],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    },
  );
  if (holdLive) {
    queryClient.setQueryData(
      ['admin', 'templates', 'eligible', 'scanning', 'o1', 'live', 'apple', true],
      {
        pages: [
          { items: [eligibleTemplateFixture({ name: 'Stale approved ticket' })], nextCursor: null },
        ],
        pageParams: [undefined],
      },
    );
  }
  function Probe() {
    const events = useScanEvents(resource === 'events' ? requested : undefined);
    const templates = useOrgTemplates(resource === 'templates' ? requested : undefined);
    const eligible = useEligibleTemplates(
      resource === 'eligible' ? requested : undefined,
      true,
      resourceMode,
    );
    const [selected, setSelected] = useState(initialSelected);
    if (resource === 'choices') {
      return createElement(EligibleTemplatePicker, {
        orgId: requested ?? '',
        selected,
        onChange: setSelected,
        requireCheckIn: true,
      });
    }
    const items =
      resource === 'events'
        ? events.data?.items
        : resource === 'templates'
          ? templates.data?.items
          : eligible.data?.pages.flatMap((page) => page.items);
    return createElement(
      Fragment,
      null,
      createElement(
        'p',
        { 'data-testid': 'events' },
        items?.map((item) => item.name).join(', ') || 'No data',
      ),
      createElement(
        'p',
        { 'data-testid': 'query-error' },
        (resource === 'events' ? events.error : templates.error)?.message,
      ),
      resource === 'events'
        ? createElement(
            'button',
            { type: 'button', onClick: () => void events.refetch() },
            'Refresh events',
          )
        : resource === 'templates'
          ? createElement(
              'button',
              { type: 'button', onClick: () => void templates.refetch() },
              'Refresh templates',
            )
          : null,
    );
  }
  const root = createRootRoute({ component: Outlet });
  const scanning = createRoute({
    getParentRoute: () => root,
    path: '/admin/scanning',
    validateSearch: (search: Record<string, unknown>) => ({
      orgId: typeof search.orgId === 'string' ? search.orgId : undefined,
    }),
    component: Probe,
  });
  const router = createRouter({
    routeTree: root.addChildren([scanning]),
    history: createMemoryHistory({ initialEntries: ['/admin/scanning?orgId=o1'] }),
  });
  render(createElement(AppProviders, { queryClient }, createElement(RouterProvider, { router })));
  return { router, requests, queryClient, eligibleRequests, detailRequests, testMode, liveMode };
}
