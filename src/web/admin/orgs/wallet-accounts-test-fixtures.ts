import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi } from 'vitest';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability, OrgMembership } from '@/shared/contracts/org-membership.ts';
import type {
  WalletProvider,
  WalletProviderReadiness,
} from '@/shared/contracts/wallet-providers.ts';
import { setCsrfProvider } from '@/web/lib/api.ts';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, stubFetch } from '@/web/lib/test-utils.tsx';
import { WalletAccountsPanel } from './wallet-accounts.tsx';

const PATH = '/api/v1/wallet-providers/accounts';
export const KEY = '-----BEGIN PRIVATE KEY-----\nU0VDUkVUX0tFWQ==\n-----END PRIVATE KEY-----';
export const CERT = '-----BEGIN CERTIFICATE-----\nQ0VSVElGSUNBVEU=\n-----END CERTIFICATE-----';
export const KEY_CONTENT = 'U0VDUkVUX0tFWQ==';
const ALL: OrgCapability[] = [
  'org:read',
  'integrations:read',
  'integrations:manage',
  'members:manage',
];

type Request = { method: string; url: URL; headers: Headers; body: Record<string, unknown> };

export function membership(orgId = 'org-1', capabilities: OrgCapability[] = ALL): OrgMembership {
  const roles: OrgMembership['roles'] = capabilities.includes('members:manage')
    ? ['org_admin']
    : capabilities.includes('integrations:manage')
      ? ['integration_admin']
      : ['read_only'];
  return {
    id: `membership-${orgId}`,
    orgId,
    orgName: 'Example',
    orgSlug: 'example',
    userId: 'user-1',
    roles,
    capabilities,
    createdAt: 1,
    revokedAt: null,
  };
}

export function ready(
  orgId: string,
  mode: Mode,
  provider: WalletProvider,
  overrides: Partial<WalletProviderReadiness> = {},
): WalletProviderReadiness {
  return {
    orgId,
    mode,
    provider,
    accountId: null,
    revision: 0,
    state: 'absent',
    externalApprovalVerified: false,
    issuance: { state: 'disabled', reason: 'not_released' },
    updatedAt: null,
    ...overrides,
  };
}

export function walletServer(
  options: {
    memberships?: OrgMembership[];
    initial?: WalletProviderReadiness[];
    putError?: Response;
    revokeError?: Response;
    holdPut?: Promise<void>;
  } = {},
) {
  const requests: Request[] = [];
  const records = new Map<string, WalletProviderReadiness>();
  const recordKey = (orgId: string, mode: Mode, provider: WalletProvider) =>
    `${orgId}:${mode}:${provider}`;
  for (const item of options.initial ?? [])
    records.set(recordKey(item.orgId, item.mode, item.provider), item);
  const handle = async (url: URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const request = { method, url, headers: new Headers(init?.headers), body };
    requests.push(request);
    const orgId = String(method === 'GET' ? url.searchParams.get('orgId') : body.orgId);
    const mode = (method === 'GET' ? url.searchParams.get('mode') : body.mode) as Mode;
    const provider = (
      method === 'GET' ? url.searchParams.get('provider') : body.provider
    ) as WalletProvider;
    const key = recordKey(orgId, mode, provider);
    const previous = records.get(key) ?? ready(orgId, mode, provider);
    if (method === 'GET') return json(previous);
    if (method === 'PUT') {
      if (options.holdPut !== undefined) await options.holdPut;
      if (options.putError) return options.putError;
    }
    if (url.pathname.endsWith('/revoke') && options.revokeError) return options.revokeError;
    const state = method === 'PUT' ? 'configured' : 'revoked';
    const next: WalletProviderReadiness = {
      ...previous,
      state,
      accountId: 'account-1',
      revision: previous.revision + 1,
      updatedAt: 1_700_000_000_000,
    };
    records.set(key, next);
    return json(next);
  };
  const fetchMock = stubFetch({
    '/api/v1/orgs/memberships/me': () => json({ items: options.memberships ?? [membership()] }),
    [PATH]: handle,
    [`${PATH}/revoke`]: handle,
  });
  return { requests, records, fetchMock };
}

export function mount(orgId = 'org-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, createElement('main', null, children));
  }
  return { ...render(createElement(WalletAccountsPanel, { orgId }), { wrapper: Wrapper }), client };
}

export function fillGoogle(region: HTMLElement, key = KEY) {
  fireEvent.change(within(region).getByLabelText(/^Issuer ID/), { target: { value: '123456' } });
  fireEvent.change(within(region).getByLabelText(/^Service account email/), {
    target: { value: 'wallet@project.iam.gserviceaccount.com' },
  });
  fireEvent.change(within(region).getByLabelText(/^Service account private key \(PKCS#8 PEM\)/), {
    target: { value: key },
  });
}

export function fillSamsung(region: HTMLElement) {
  fireEvent.change(within(region).getByLabelText(/^Partner ID/), {
    target: { value: 'partner_1' },
  });
  fireEvent.change(within(region).getByLabelText(/^Certificate ID/), { target: { value: 'AB12' } });
  fireEvent.change(within(region).getByLabelText(/^Card ID/), { target: { value: 'card_1' } });
  fireEvent.change(within(region).getByLabelText(/^Partner private key \(PKCS#8 PEM\)/), {
    target: { value: KEY },
  });
  fireEvent.change(within(region).getByLabelText(/^Partner certificate \(PEM\)/), {
    target: { value: CERT },
  });
  fireEvent.change(within(region).getByLabelText(/^Samsung certificate \(PEM\)/), {
    target: { value: CERT },
  });
}

export function setupWalletAccountsTest() {
  resetModeForTests();
  setCsrfProvider(async () => undefined);
}

export function cleanupWalletAccountsTest() {
  cleanup();
  resetModeForTests();
  vi.unstubAllGlobals();
}
