import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import { json, stubFetch } from '../../../lib/test-utils.tsx';
import { RolloutBanner } from './rollout-banner.tsx';

afterEach(() => vi.unstubAllGlobals());

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));

const rollout = (over: Partial<TemplateRollout> = {}): TemplateRollout => ({
  releaseVersion: 'version-2',
  releaseId: 'rel-2',
  fromVersion: 'version-1',
  total: 10,
  onRelease: 10,
  remaining: 0,
  updating: [],
  failedCount: 0,
  failed: [],
  startedAt: 1,
  runId: null,
  running: false,
  stalled: false,
  changes: [],
  tell: { text: 'x', until: 2, key: 'k' },
  ...over,
});

const TEMPLATE = {
  id: 't1',
  name: 'Gym',
  versions: [
    { version: 'version-1', createdAt: 1 },
    { version: 'version-2', createdAt: 2 },
  ],
} as unknown as ComponentProps<typeof RolloutBanner>['template'];

function mount(data: TemplateRollout, caps: string[]) {
  stubFetch({ '/api/v1/templates/t1/rollout': () => json(data) });
  const scope = { orgId: 'org-1', membership: { capabilities: caps } } as unknown as ComponentProps<
    typeof RolloutBanner
  >['scope'];
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RolloutBanner template={TEMPLATE} scope={scope} />
    </QueryClientProvider>,
  );
}

describe('rollout banner', () => {
  it('offers Tell holders only to a caller who can send', async () => {
    mount(rollout(), ['messages:manage']);
    expect(await screen.findByText(/You can tell holders/)).toBeInTheDocument();
  });

  it('shows nothing for a caller who cannot send once everything is done', async () => {
    const { container } = mount(rollout(), []);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it('does not claim every pass moved when some cannot', async () => {
    mount(rollout({ onRelease: 7, remaining: 3, failedCount: 3, stalled: true }), []);
    expect(
      await screen.findByText(/3 passes can't move to v2: the rebuild did not start/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/on every pass/)).toBeNull();
  });
});
