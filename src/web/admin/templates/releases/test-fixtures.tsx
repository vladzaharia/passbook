import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  TemplateApproval,
  TemplateCandidate,
  TemplateRelease,
  TemplateReleaseImpact,
} from '@/shared/contracts/template-releases.ts';
import { json, stubFetch } from '../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../ui/tooltip.tsx';
import { TemplateReleasesPanel } from './template-releases-panel.tsx';
import type { TemplateReleasesPanelProps } from './types.ts';

export const TEMPLATE = 'template-1';
export const CANDIDATE_HASH = 'a'.repeat(64);
export const CONTENT_HASH = 'b'.repeat(64);
export const OLD_HASH = 'c'.repeat(64);
export const SCOPE = { orgId: 'org-1', mode: 'live', provider: 'apple' } as const;
export const VERSIONS = [
  { version: 'version-1', active: true, createdAt: 1_700_000_000_000, displayOnly: false },
  { version: 'version-2', active: false, createdAt: 1_700_000_001_000, displayOnly: false },
] as const;

export function candidate(overrides: Partial<TemplateCandidate> = {}): TemplateCandidate {
  return {
    id: 'candidate-1',
    templateId: TEMPLATE,
    ...SCOPE,
    version: 'version-2',
    contentHash: CONTENT_HASH,
    candidateHash: CANDIDATE_HASH,
    adapterRevision: 4,
    adapterCapabilities: ['barcode', 'nfc'],
    audiencePolicyRevision: 3,
    authorId: 'candidate-author',
    versionAuthorId: 'version-author',
    authorName: 'Ada Author',
    versionAuthorName: 'Vera Versioner',
    createdAt: 1_700_000_002_000,
    approvals: [],
    ...overrides,
  };
}

export function approval(overrides: Partial<TemplateApproval> = {}): TemplateApproval {
  return {
    id: 'approval-1',
    candidateId: 'candidate-1',
    candidateHash: CANDIDATE_HASH,
    reviewerId: 'reviewer-1',
    reviewerName: 'Rae Reviewer',
    createdAt: 1_700_000_003_000,
    ...overrides,
  };
}

export const IMPACT: TemplateReleaseImpact = {
  fromVersion: 'version-1',
  toVersion: 'version-2',
  passes: { count: 12, capped: false },
  diff: {
    fields: [{ label: 'Seat', kind: 'changed', from: 'A1', to: 'B2' }],
    images: [],
    barcode: [{ label: 'Format', kind: 'added', from: null, to: 'QR' }],
    colors: [{ label: 'Background', kind: 'changed', from: '#000000', to: '#ffffff' }],
  },
  more: { fields: 0, images: 0, barcode: 0, colors: 0 },
};

export function release(overrides: Partial<TemplateRelease> = {}): TemplateRelease {
  return {
    id: 'release-1',
    templateId: TEMPLATE,
    ...SCOPE,
    version: 'version-1',
    generation: 1,
    candidateHash: OLD_HASH,
    source: 'approved',
    action: 'release',
    previousReleaseId: null,
    createdBy: 'publisher-1',
    createdByName: 'Pia Publisher',
    createdAt: 1_700_000_000_000,
    candidateId: 'old-candidate',
    approvalId: 'old-approval',
    ...overrides,
  };
}

export const ALL_CAPABILITIES = [
  'templates:read',
  'templates:author',
  'templates:review',
  'templates:publish',
] as const;

export function panelProps(
  overrides: Partial<TemplateReleasesPanelProps> = {},
): TemplateReleasesPanelProps {
  return {
    templateId: TEMPLATE,
    templateOrigin: 'uploaded',
    templateStatus: 'active',
    templateOrgId: SCOPE.orgId,
    orgId: SCOPE.orgId,
    mode: SCOPE.mode,
    versions: VERSIONS,
    capabilities: ALL_CAPABILITIES,
    currentUserId: 'operator-1',
    ...overrides,
  };
}

export function mountPanel(overrides: Partial<TemplateReleasesPanelProps> = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60_000 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <main>{children}</main>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }
  return {
    ...render(<TemplateReleasesPanel {...panelProps(overrides)} />, { wrapper: Wrapper }),
    client,
  };
}

export interface SeenRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Small, stateful HTTP boundary: mutations are followed by real query invalidations/refetches. */
export function releaseServer(
  options: {
    candidates?: TemplateCandidate[];
    active?: TemplateRelease | null;
    history?: TemplateRelease[];
    impact?: () => Response;
    publishError?: () => Response;
    rollbackError?: () => Response;
  } = {},
) {
  const state = {
    candidates: options.candidates ?? [],
    active: options.active ?? null,
    history: options.history ?? [],
    requests: [] as SeenRequest[],
  };
  const headId = () =>
    state.history.reduce<TemplateRelease | null>(
      (head, item) => (!head || item.generation > head.generation ? item : head),
      null,
    )?.id ?? null;
  const record = (url: URL, init?: RequestInit) => {
    const request = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    state.requests.push(request);
    return request;
  };
  const base = `/api/v1/templates/${TEMPLATE}`;
  stubFetch({
    [`${base}/candidates`]: (url, init) => {
      const request = record(url, init);
      if (request.method === 'GET') return json({ items: state.candidates });
      const created = candidate({
        orgId: String(request.body.orgId),
        mode: request.body.mode === 'test' ? 'test' : 'live',
        version: String(request.body.version),
      });
      state.candidates = [...state.candidates, created];
      return json(created, 201);
    },
    [`${base}/candidates/candidate-1/approve`]: (url, init) => {
      record(url, init);
      const created = approval();
      state.candidates = state.candidates.map((item) =>
        item.id === created.candidateId
          ? { ...item, approvals: [...item.approvals, created] }
          : item,
      );
      return json(created, 201);
    },
    [`${base}/releases/impact`]: (url, init) => {
      record(url, init);
      return options.impact ? options.impact() : json(IMPACT);
    },
    [`${base}/releases`]: (url, init) => {
      const request = record(url, init);
      if (request.method === 'GET') return json({ active: state.active, items: state.history });
      if (options.publishError) return options.publishError();
      const selected = state.candidates.find((item) => item.id === request.body.candidateId);
      if (!selected) throw new Error('Unknown candidate in publish request');
      const created = release({
        id: 'release-new',
        orgId: selected.orgId,
        mode: selected.mode,
        provider: selected.provider,
        version: selected.version,
        generation: Number(request.body.expectedGeneration) + 1,
        candidateHash: selected.candidateHash,
        candidateId: selected.id,
        approvalId: String(request.body.approvalId),
        previousReleaseId: headId(),
      });
      state.active = created;
      state.history = [created, ...state.history];
      return json(created, 201);
    },
    [`${base}/releases/rollback`]: (url, init) => {
      const request = record(url, init);
      if (options.rollbackError) return options.rollbackError();
      const target = state.history.find((item) => item.id === request.body.releaseId);
      if (!target) throw new Error('Unknown release in rollback request');
      const created = release({
        ...target,
        id: 'release-rollback',
        generation: Number(request.body.expectedGeneration) + 1,
        action: 'rollback',
        previousReleaseId: headId(),
      });
      state.active = created;
      state.history = [created, ...state.history];
      return json(created, 201);
    },
  });
  return state;
}
