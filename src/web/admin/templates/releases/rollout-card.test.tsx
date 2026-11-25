import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import { json, stubFetch } from '../../../lib/test-utils.tsx';
import { RolloutCard } from './rollout-card.tsx';

afterEach(() => vi.unstubAllGlobals());

const rollout = (over: Partial<TemplateRollout> = {}): TemplateRollout => ({
  releaseVersion: 'version-2',
  releaseId: 'rel-2',
  fromVersion: 'version-1',
  total: 10,
  onRelease: 4,
  remaining: 6,
  updating: [{ version: 'version-1', count: 6 }],
  failedCount: 0,
  failed: [],
  startedAt: 1,
  runId: null,
  running: false,
  stalled: false,
  changes: [],
  tell: { text: 'Gym has a new design.', until: 2, key: 'rollout-tell:rel-2' },
  ...over,
});

const TEMPLATE = {
  id: 't1',
  name: 'Gym',
  versions: [
    { version: 'version-1', createdAt: 1 },
    { version: 'version-2', createdAt: 2 },
  ],
} as unknown as ComponentProps<typeof RolloutCard>['template'];

const scope = (caps: string[]) =>
  ({ orgId: 'org-1', membership: { capabilities: caps } }) as unknown as ComponentProps<
    typeof RolloutCard
  >['scope'];

function mount(caps = ['messages:manage']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RolloutCard template={TEMPLATE} scope={scope(caps)} />
    </QueryClientProvider>,
  );
}

describe('rollout card', () => {
  it('splits passes by version and Tell holders sends one message to the passes on the release', async () => {
    const posted: { body: unknown; key: string | null }[] = [];
    const previews: unknown[] = [];
    stubFetch({
      '/api/v1/templates/t1/rollout': () => json(rollout()),
      '/api/v1/broadcasts/preview': (_url, init) => {
        previews.push(JSON.parse(String(init?.body)));
        return json({ targeted: 4, onDevice: 3, overBudget: 0, limit: 5 });
      },
      '/api/v1/broadcasts': (_url, init) => {
        posted.push({
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get('idempotency-key'),
        });
        return json({}, 201);
      },
    });
    mount();
    expect(await screen.findByText('Updating passes to v2')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Passes on the release' })).toHaveAttribute(
      'aria-valuenow',
      '4',
    );
    const bar = screen.getByRole('progressbar', { name: 'Passes on the release' });
    const segments = [...bar.querySelectorAll('[data-segment]')];
    expect(segments.map((s) => s.getAttribute('data-segment'))).toEqual(['release', 'version-1']);
    expect(segments.map((s) => (s as HTMLElement).style.flexGrow)).toEqual(['4', '6']);
    const legend = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(legend).toEqual(['v2 · 4', 'v1 · 6']);
    await userEvent.click(screen.getByRole('button', { name: 'Tell holders' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Tell 4 holders' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(previews[0]).toMatchObject({ target: { templateIds: ['t1'], version: 'version-2' } });
    expect(posted[0]?.key).toBe('rollout-tell:rel-2');
    expect(posted[0]?.body).toMatchObject({
      kind: 'message',
      notify: true,
      clearAfter: 7 * 24 * 3_600_000,
      patch: { message: 'Gym has a new design.' },
      target: { templateIds: ['t1'], version: 'version-2' },
    });
  });

  it('shows the lock-screen counter and who is still updating', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () => json(rollout()),
      '/api/v1/broadcasts/preview': () =>
        json({ targeted: 4, onDevice: 3, overBudget: 0, limit: 5 }),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Tell holders' }));
    expect(await screen.findByText(/21\/120/)).toBeInTheDocument();
    expect(screen.getByText(/3 on a phone/)).toBeInTheDocument();
    expect(screen.getByText(/6 passes are still updating/)).toBeInTheDocument();
  });

  it('blocks an empty message with its error instead of a disabled button', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () => json(rollout()),
      '/api/v1/broadcasts/preview': () =>
        json({ targeted: 4, onDevice: 3, overBudget: 0, limit: 5 }),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Tell holders' }));
    const field = await screen.findByRole('textbox', { name: /Notify on the lock screen/ });
    await userEvent.clear(field);
    await userEvent.click(await screen.findByRole('button', { name: 'Tell 4 holders' }));
    expect(await screen.findByText('Write a message.')).toBeInTheDocument();
  });

  it('renders nothing once every pass is on the release and holders were told', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () =>
        json(rollout({ onRelease: 10, remaining: 0, updating: [], tell: null })),
    });
    const { container } = mount();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('counts passes that cannot update, hides Tell holders without messages:manage, no list without passes:read', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () =>
        json(rollout({ onRelease: 7, remaining: 3, updating: [], failedCount: 3, failed: [] })),
    });
    mount([]);
    expect(await screen.findByText("3 passes can't move to v2")).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain(
      "Can't update · 3",
    );
    expect(screen.queryByRole('button', { name: 'Tell holders' })).toBeNull();
    expect(screen.queryByRole('button', { name: /that can't update/ })).toBeNull();
  });

  it('says so when no rebuild started', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () =>
        json(rollout({ remaining: 6, updating: [], failedCount: 6, stalled: true, tell: null })),
    });
    mount();
    expect(await screen.findByText(/The rebuild did not start/)).toBeInTheDocument();
  });

  it('shows what changed between the two versions on request', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () =>
        json(
          rollout({
            changes: [
              {
                group: 'colors',
                more: 0,
                rows: [
                  {
                    label: 'Background',
                    kind: 'changed',
                    from: { type: 'color', color: '#000000' },
                    to: { type: 'color', color: '#ffffff' },
                  },
                ],
              },
            ],
          }),
        ),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /What changed v1 → v2/ }));
    expect(await screen.findByText('Background')).toBeInTheDocument();
  });

  it('says a newer release replaced this one when the key is no longer the release', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () => json(rollout()),
      '/api/v1/broadcasts/preview': () =>
        json({ targeted: 4, onDevice: 3, overBudget: 0, limit: 5 }),
      '/api/v1/broadcasts': () =>
        json(
          {
            type: 'x',
            title: 'Reserved',
            status: 422,
            code: 'IDEMPOTENCY_KEY_RESERVED',
            detail: 'raw text',
          },
          422,
        ),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Tell holders' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Tell 4 holders' }));
    expect(
      await screen.findByText('A newer release replaced this one. Reload.'),
    ).toBeInTheDocument();
  });
});
