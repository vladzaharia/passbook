import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { createElement, type ReactElement, useState } from 'react';
import { vi } from 'vitest';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { membershipsQuery, sessionQuery } from '@/web/lib/session.ts';
import { json, membershipFixture, sessionFixture } from '@/web/lib/test-utils.tsx';
import type { DesignDoc } from '../model.ts';
import { ScanStage, type ScanStageAction } from './scan-stage.tsx';

export function fixture(): { doc: DesignDoc; display: ScanDisplayDoc } {
  return {
    doc: {
      assets: [],
      passJson: { generic: { primaryFields: [{ key: 'seat', label: 'Seat' }] } },
      manifest: {
        schema: 1,
        name: 'Membership',
        inputs: {
          type: 'object',
          properties: {
            memberName: { type: 'string' },
            seat: { type: 'string' },
            tier: { type: 'string', 'x-scan': 'manager' },
            contactEmail: { type: 'string', format: 'email' },
          },
        },
        sample: {
          memberName: 'Alex',
          seat: 'A12',
          tier: 'Synthetic VIP',
          contactEmail: 'sample@example.test',
        },
        bindings: [{ to: { field: 'seat' }, value: '{{seat}}' }],
        display: { title: '{{memberName}}' },
        scan: { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      },
    },
    display: {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_ticket',
          title: 'Ticket',
          rows: [
            { id: 'r_seat', type: 'field', label: 'Seat', value: '{{inputs.seat}}' },
            { id: 'r_tier', type: 'field', label: 'Tier', value: '{{inputs.tier}}' },
          ],
        },
      ],
      notes: { refused: 'See the desk.' },
    },
  };
}

export function Stage({
  phone = false,
  orgId = 'org1',
  selected = null,
  onSelect = () => {},
  onAction,
}: {
  phone?: boolean;
  orgId?: string | null;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onAction?: (id: string, action: ScanStageAction) => void;
}) {
  const [current, setCurrent] = useState<ScanDisplayScreen>('ok');
  const { doc, display } = fixture();
  return createElement(ScanStage, {
    doc,
    display,
    templateId: 'tpl1',
    orgId,
    mode: 'test',
    screen: current,
    onScreenChange: setCurrent,
    selected,
    onSelect,
    onAction,
    phone,
  });
}

const pass = (id: string, title: string) => ({
  id,
  orgId: 'org1',
  templateId: 'tpl1',
  templateVersion: 'v1',
  identityId: 'identity1',
  serial: id,
  title,
  subtitle: null,
  externalId: null,
  status: 'active',
  mode: 'test',
  version: 1,
  connectionId: null,
  syncErrorCode: null,
  holderEmail: null,
  holderState: 'unassigned',
  ownerUserId: null,
  deviceCount: 0,
  removedAt: null,
  modifiedAt: 1,
  createdAt: 1,
});
const PASSES = [pass('pass-one', 'Pass one'), pass('pass-two', 'Pass two')];

export interface Pending {
  url: URL;
  init?: RequestInit;
  answer: (response: Response) => void;
}

/** Holds each real-pass preview request open; pass search answers at once. */
export function deferredPreview() {
  const requests: Pending[] = [];
  const fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((answer) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/v1/passes') {
          answer(json({ items: PASSES, nextCursor: null }));
          return;
        }
        requests.push({ url, init, answer });
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return requests;
}

export const response = (name: string, tier: string) =>
  json({
    scope: {
      inputs: {
        memberName: name,
        seat: 'B12',
        tier,
        contactEmail: 'never@example.test',
        rawOnly: 'Raw-only sentinel',
      },
      fields: { seat: 'B12' },
      pass: { title: name, barcode: 'never-a-barcode' },
      scanner: { name: 'Desk', role: 'manager' },
    },
  });

/** The stage inside a router and query client, as the pass picker needs the organization scope. */
export function renderInApp(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, sessionFixture('admin'));
  client.setQueryData(membershipsQuery.queryKey, { items: [membershipFixture('org1')] });
  const route = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/admin/templates?orgId=org1'] }),
  });
  return render(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
  );
}
