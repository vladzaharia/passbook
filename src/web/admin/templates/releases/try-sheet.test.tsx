import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json, membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import {
  ORG,
  passDetail,
  previewsHandler,
  templateDetail,
  templateReleaseList,
} from '../../passes/test-fixtures.ts';

beforeEach(() => setCsrfProvider(async () => 'csrf'));
afterEach(() => {
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

const member = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const DRAFT = 'ffeeddccbbaa9988';
const state = (over: Record<string, unknown> = {}) => ({
  live: null,
  test: null,
  draft: { version: DRAFT, at: 1_700_000_100_000 },
  review: { state: 'none' },
  alone: true,
  next: 'try',
  ...over,
});
const done = { outcome: 'released', releaseId: 'r1', generation: 1, approvalKind: 'test' };

async function open(
  devices: () => Response,
  over: Record<string, (url: URL, init?: RequestInit) => Response> = {},
) {
  const calls: { url: URL; init?: RequestInit | undefined }[] = [];
  const detail = templateDetail({ release: state() });
  detail.versions[1] = { ...detail.versions[1], report: { ok: true, issues: [] } } as never;
  const rendered = await renderApp('/admin/templates/tpl1', {
    session: 'admin',
    memberships: [member],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(detail),
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/tpl1/release': (url, init) => {
        calls.push({ url, init });
        return json({ version: DRAFT, modes: { test: done }, state: state({ next: 'release' }) });
      },
      '/api/v1/templates/tpl1/releases': () =>
        json(templateReleaseList({ mode: 'test', version: DRAFT, id: 'r1' })),
      '/api/v1/passes': (url, init) => {
        if (init?.method !== 'POST') return json({ items: [], nextCursor: null });
        calls.push({ url, init });
        return json(
          passDetail({ id: 'p1', publicUrl: 'https://x.test/p/1', downloadUrl: '/d/1' }),
          201,
        );
      },
      '/api/v1/passes/p1/devices': devices,
      ...over,
    },
  });
  return { ...rendered, calls };
}

it('releases to Test, makes a sample pass for the admin with no email, and waits for the phone', async () => {
  const user = userEvent.setup();
  const { calls } = await open(() => json({ version: 1, devices: [], removal: null }));
  await user.click(await screen.findByRole('button', { name: 'Try on my phone' }));
  const sheet = await screen.findByRole('dialog', { name: 'Try on my phone' });
  await waitFor(() =>
    expect(sheet.querySelector('p[role=status]')).toHaveTextContent('Waiting for your phone'),
  );
  const [release, pass] = calls.map((c) => ({
    body: JSON.parse(String(c.init?.body)) as Record<string, unknown>,
    headers: new Headers(c.init?.headers),
  }));
  expect(release?.body).toMatchObject({ version: DRAFT, modes: ['test'] });
  expect(pass?.body).toMatchObject({
    mode: 'test',
    releaseId: 'r1',
    releaseGeneration: 1,
    input: { name: 'Sam' },
    sendEmail: false,
  });
  expect(pass?.headers.get('x-passbook-mode')).toBe('test');
  expect(pass?.headers.get('idempotency-key')).toBeTruthy();
  // Release is never blocked: it leads once the phone is on, and is there before.
  expect(within(sheet).getByRole('button', { name: 'Release v2' })).toBeEnabled();
});

it('cheers when the phone registers and offers Release', async () => {
  const user = userEvent.setup();
  const { container } = await open(() =>
    json({
      version: 1,
      devices: [
        {
          device: 'abc',
          status: 'current',
          registeredAt: 1,
          unregisteredAt: null,
          lastFetch: null,
          lastPush: null,
          removal: null,
        },
      ],
      removal: null,
    }),
  );
  await user.click(await screen.findByRole('button', { name: 'Try on my phone' }));
  const sheet = await screen.findByRole('dialog', { name: 'Try on my phone' });
  await waitFor(() =>
    expect(sheet.querySelector('p[role=status]')).toHaveTextContent('On your phone'),
  );
  await waitFor(() =>
    expect(within(sheet).getByRole('button', { name: 'Release v2' })).toBeEnabled(),
  );
  expect((await axe(container)).violations).toEqual([]);
});

it('names the step that failed and offers another try', async () => {
  const user = userEvent.setup();
  await open(() => json({ version: 1, devices: [], removal: null }), {
    '/api/v1/passes': () =>
      json({ type: 'about:blank', title: 'Down', status: 500, code: 'INTERNAL' }, 500),
  });
  await user.click(await screen.findByRole('button', { name: 'Try on my phone' }));
  const sheet = await screen.findByRole('dialog', { name: 'Try on my phone' });
  const steps = await within(sheet).findByRole('list', { name: 'Progress' });
  await waitFor(() => expect(steps).toHaveTextContent('Make your pass (failed)'));
  expect(steps).toHaveTextContent('Release v2 to Test (done)');
  expect(within(sheet).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});
