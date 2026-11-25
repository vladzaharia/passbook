import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests, setMode } from '../../../lib/mode.ts';
import { json, problem, stubFetch } from '../../../lib/test-utils.tsx';
import { TemplateReleasesPanel } from './template-releases-panel.tsx';
import {
  approval,
  candidate,
  mountPanel,
  panelProps,
  release,
  releaseServer,
  TEMPLATE,
} from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

describe('template release panel', () => {
  it('scopes both GETs and their cache by template, organization, and explicit mode', async () => {
    // The panel's explicit live mode must override the opposite global mode header.
    setMode('test');
    const seen: { path: string; method: string; query: string[][]; header: string | null }[] = [];
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const delayedOrg2 = deferred.withResolvers<Response>();
    const handler = (url: URL, init?: RequestInit) => {
      const orgId = url.searchParams.get('orgId') ?? '';
      const mode = url.searchParams.get('mode') === 'test' ? 'test' : 'live';
      const templateId = url.pathname.split('/')[4] ?? '';
      seen.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        query: Array.from(url.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b)),
        header: new Headers(init?.headers).get('x-passbook-mode'),
      });
      const fingerprint =
        templateId === 'template-2' ? '4' : orgId === 'org-2' ? '3' : mode === 'test' ? '2' : '1';
      if (
        templateId === 'template-1' &&
        orgId === 'org-2' &&
        url.pathname.endsWith('/candidates')
      ) {
        return delayedOrg2.promise;
      }
      return url.pathname.endsWith('/candidates')
        ? json({
            items: [candidate({ templateId, orgId, mode, candidateHash: fingerprint.repeat(64) })],
            nextCursor: null,
          })
        : json({ active: null, items: [], nextCursor: null });
    };
    stubFetch({
      '/api/v1/templates/template-1/candidates': handler,
      '/api/v1/templates/template-1/releases': handler,
      '/api/v1/templates/template-2/candidates': handler,
      '/api/v1/templates/template-2/releases': handler,
    });
    const view = mountPanel({ templateOrgId: null });
    await waitFor(() =>
      expect(
        seen.some((r) => r.path === '/api/v1/templates/template-1/releases' && r.header === 'live'),
      ).toBe(true),
    );
    view.rerender(<TemplateReleasesPanel {...panelProps({ templateOrgId: null, mode: 'test' })} />);
    await waitFor(() =>
      expect(
        seen.some((r) => r.path === '/api/v1/templates/template-1/releases' && r.header === 'test'),
      ).toBe(true),
    );
    view.rerender(
      <TemplateReleasesPanel
        {...panelProps({ templateOrgId: null, mode: 'test', orgId: 'org-2' })}
      />,
    );
    expect(await screen.findByText(/Loading releases/)).toBeInTheDocument();
    delayedOrg2.resolve(
      json({
        items: [candidate({ orgId: 'org-2', mode: 'test', candidateHash: '3'.repeat(64) })],
        nextCursor: null,
      }),
    );
    await waitFor(() =>
      expect(seen.some((r) => r.query.some(([k, v]) => k === 'orgId' && v === 'org-2'))).toBe(true),
    );
    view.rerender(
      <TemplateReleasesPanel
        {...panelProps({
          templateId: 'template-2',
          templateOrgId: null,
          mode: 'test',
          orgId: 'org-2',
        })}
      />,
    );
    await waitFor(() =>
      expect(seen.some((r) => r.path === '/api/v1/templates/template-2/releases')).toBe(true),
    );
    view.rerender(<TemplateReleasesPanel {...panelProps({ templateOrgId: null })} />);
    await waitFor(() =>
      expect(
        seen.some((r) => r.path === '/api/v1/templates/template-1/releases' && r.header === 'live'),
      ).toBe(true),
    );

    const scopes = [
      ['template-1', 'org-1', 'live'],
      ['template-1', 'org-1', 'test'],
      ['template-1', 'org-2', 'test'],
      ['template-2', 'org-2', 'test'],
    ] as const;
    for (const [template, org, mode] of scopes) {
      for (const resource of ['candidates', 'releases']) {
        expect(seen).toContainEqual({
          path: `/api/v1/templates/${template}/${resource}`,
          method: 'GET',
          query: [
            ['mode', mode],
            ['orgId', org],
            ['provider', 'apple'],
          ],
          header: mode,
        });
      }
    }
    expect(seen.every((r) => r.query.some(([k, v]) => k === 'orgId' && v))).toBe(true);
  });

  it('asks for an organization without making unscoped requests and explains provider availability', () => {
    const fetch = stubFetch({});
    mountPanel({ orgId: undefined });
    expect(screen.getByText('Select an organization.')).toBeInTheDocument();
    expect(screen.queryByText(/offers unavailable|release workflow/)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fetch or offer actions for a different owning organization', () => {
    const fetch = stubFetch({});
    mountPanel({ orgId: 'org-2' });
    expect(screen.getByText('Select the owning organization.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create candidate' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats built-in releases as system managed', async () => {
    const system = release({
      source: 'system',
      action: 'system',
      orgId: null,
      candidateId: null,
      approvalId: null,
    });
    releaseServer({ active: system, history: [system] });
    mountPanel({ templateOrigin: 'baked', templateOrgId: null });
    await screen.findByRole('list', { name: 'Versions' });
    expect(screen.queryByText(/managed by the system/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create candidate' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /Approve candidate|Publish candidate|Restore/,
      }),
    ).not.toBeInTheDocument();
  });

  it('never offers rollback to the head or a system release', async () => {
    const head = release({ id: 'head', generation: 3 });
    const system = release({
      id: 'system',
      generation: 1,
      source: 'system',
      action: 'system',
      candidateId: null,
      approvalId: null,
    });
    releaseServer({ active: head, history: [head, system] });
    mountPanel();
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Versions' });
    await releasesLoaded();
    await user.click(screen.getByRole('button', { name: 'Actions for v1' }));
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('displays scoped list failures instead of presenting an empty release history', async () => {
    stubFetch({
      [`/api/v1/templates/${TEMPLATE}/candidates`]: () =>
        problem(409, 'TEMPLATE_MODE_MISMATCH', 'The requested mode does not match the session.'),
      [`/api/v1/templates/${TEMPLATE}/releases`]: () =>
        json({ active: null, items: [], nextCursor: null }),
    });
    mountPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The requested mode does not match the session.',
    );
    expect(screen.queryByText('Not released')).not.toBeInTheDocument();
  });

  it('opens and dismisses the rollback dialog with the keyboard at a phone viewport', async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const user = userEvent.setup();
    const previous = release({ id: 'previous', generation: 1 });
    const head = release({ id: 'head', generation: 2 });
    releaseServer({ active: head, history: [head, previous] });
    mountPanel();
    await releasesLoaded();
    const trigger = await screen.findByRole('button', { name: 'Actions for v1' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole('textbox', { name: /Reason/ })).toBeInTheDocument();
    expect((await axe(document.body)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore v1' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('self-approval and promote', () => {
  it('shows the chip on the release that used a self-approval', async () => {
    releaseServer({
      candidates: [
        candidate({ approvals: [approval({ kind: 'sole', reviewerId: 'candidate-author' })] }),
      ],
      active: release({ approvalId: 'approval-1', candidateId: 'candidate-1' }),
      history: [release({ approvalId: 'approval-1', candidateId: 'candidate-1' })],
    });
    mountPanel();
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Versions' });
    await pickRowAction(user, 'v1', 'Technical details');
    const sheet = await screen.findByRole('dialog', { name: 'v1 details' });
    expect(within(sheet).getByText('Self-approved')).toBeInTheDocument();
  });
});
