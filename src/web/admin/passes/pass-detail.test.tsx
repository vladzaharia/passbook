import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, problem, renderApp } from '../../lib/test-utils.tsx';
import {
  ORG,
  passDetail,
  passSummary,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

interface Server {
  pass: ReturnType<typeof passDetail>;
  calls: { method: string; path: string; init?: RequestInit }[];
}

function handlers(
  server: Server,
  extra: Record<string, FetchHandler> = {},
): Record<string, FetchHandler> {
  const log =
    (path: string, fn: FetchHandler): FetchHandler =>
    (url, init) => {
      server.calls.push({ method: method(init), path, init });
      return fn(url, init);
    };
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
    '/api/v1/passes/p1': log('/passes/p1', () => json(server.pass)),
    '/api/v1/passes/p1/assets': () => json({ items: [] }),
    '/api/v1/delivery': () => json({ items: server.pass.deliveries }),
    '/api/v1/audit': () =>
      json({
        items: [
          {
            id: 1,
            at: 1,
            orgId: 'org1',
            actorType: 'user',
            actorId: 'u1',
            action: 'pass.update',
            targetType: 'pass',
            targetId: 'p1',
            requestId: null,
            detail: null,
          },
        ],
        nextCursor: null,
      }),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, log(k, v)])),
  };
}

function newServer(over: Record<string, unknown> = {}): Server {
  return { pass: passDetail(over), calls: [] };
}

function patchAware(server: Server, onPatch: (init?: RequestInit) => Response) {
  return handlers(server, {
    '/api/v1/passes/p1': (_u, init) =>
      method(init) === 'PATCH' ? onPatch(init) : json(server.pass),
  });
}

describe('pass detail: save and conflicts', () => {
  it('saves only the changed keys with the loaded version in If-Match', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: patchAware(server, () => {
        server.pass = passDetail({
          version: 4,
          personalization: { name: 'Sam Jones Jr', level: 'copper' },
        });
        return json(server.pass);
      }),
    });
    await user.type(await screen.findByLabelText(/Member name/), ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    const patch = server.calls.find((c) => c.method === 'PATCH');
    expect(headersOf(patch?.init)['if-match']).toBe('3');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ input: { name: 'Sam Jones Jr' } });
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones Jr');
  });

  it('keeps the draft on 412 and offers merge, then saves against the new version', async () => {
    const user = userEvent.setup();
    const server = newServer();
    let patches = 0;
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: patchAware(server, () => {
        patches += 1;
        if (patches === 1) {
          // Someone else saved first.
          server.pass = passDetail({
            version: 4,
            personalization: { name: 'Sam Jones', level: 'blue' },
          });
          return problem(412, 'VERSION_CONFLICT', 'The resource changed. Reload and retry.');
        }
        server.pass = passDetail({
          version: 5,
          personalization: { name: 'Sam Jones Jr', level: 'blue' },
        });
        return json(server.pass);
      }),
    });
    const input = await screen.findByLabelText(/Member name/);
    await user.type(input, ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const banner = await screen.findByText(/This pass changed since you opened it/);
    expect(banner).toBeInTheDocument();
    // The draft survives.
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones Jr');
    const merge = screen.getByRole('button', { name: 'Merge my edits' });
    await waitFor(() => expect(merge).toBeEnabled());
    await user.click(merge);
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toBe(2));
    const sent = server.calls.filter((c) => c.method === 'PATCH');
    expect(headersOf(sent[1]?.init)['if-match']).toBe('4');
    // Only my change is sent; the other admin's level is not overwritten.
    expect(JSON.parse(String(sent[1]?.init?.body))).toEqual({ input: { name: 'Sam Jones Jr' } });
    await waitFor(() => expect(screen.queryByText(/This pass changed/)).not.toBeInTheDocument());
  });

  it('reloads the server values and drops the draft on request', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: patchAware(server, () => {
        server.pass = passDetail({
          version: 4,
          personalization: { name: 'Server Name', level: 'copper' },
        });
        return problem(412, 'VERSION_CONFLICT', 'Changed.');
      }),
    });
    await user.type(await screen.findByLabelText(/Member name/), ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const reload = await screen.findByRole('button', { name: 'Reload' });
    await waitFor(() => expect(reload).toBeEnabled());
    await user.click(reload);
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Server Name');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('adopts a newer server version silently while the form is clean', async () => {
    const server = newServer();
    const { queryClient } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: handlers(server),
    });
    expect(await screen.findByLabelText(/Member name/)).toHaveValue('Sam Jones');
    server.pass = passDetail({ version: 4, personalization: { name: 'Changed', level: 'copper' } });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'passes'] });
    await waitFor(() => expect(screen.getByLabelText(/Member name/)).toHaveValue('Changed'));
    expect(screen.queryByText(/This pass changed/)).not.toBeInTheDocument();
  });

  it('shows server field errors from a 422 and keeps the draft', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: patchAware(server, () =>
        problem(422, 'VALIDATION', 'Invalid.', [{ path: 'input.name', message: 'Name is taken.' }]),
      ),
    });
    await user.type(await screen.findByLabelText(/Member name/), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name is taken.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jonesx');
  });

  it('resets a manual field to the connection', async () => {
    const user = userEvent.setup();
    const server = newServer({ connectionId: 'c1' });
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: patchAware(server, (init) => {
        server.pass = passDetail({
          connectionId: 'c1',
          version: 4,
          fieldSources: { name: 'connection', level: 'manual' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ resetToConnection: ['name'] });
        return json(server.pass);
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Reset Member name to connection' }),
    );
    await waitFor(() => expect(screen.getAllByText('Connection').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Reset Member name to connection' })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: handlers(newServer()),
    });
    await screen.findByLabelText(/Member name/);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('pass detail: tabs', () => {
  it('assigns a waiting holder', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/holders/assign': (_u, init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            passId: 'p1',
            email: 'new@example.com',
          });
          return json({
            passId: 'p1',
            state: 'waiting',
            email: 'new@example.com',
            ownerUserId: null,
            ownerName: null,
            blockedUserIds: [],
            updatedAt: 1,
          });
        },
      }),
    });
    const email = await screen.findByLabelText('Holder email');
    await user.clear(email);
    await user.type(email, 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/holders/assign')).toBe(true),
    );
  });

  it('confirms before reassigning an owned pass', async () => {
    const user = userEvent.setup();
    const server = newServer({
      holderState: 'owned',
      ownerUserId: 'u9',
      holderEmail: 'a@example.com',
    });
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/holders/reassign': () =>
          json({
            passId: 'p1',
            state: 'waiting',
            email: 'b@example.com',
            ownerUserId: null,
            ownerName: null,
            blockedUserIds: [],
            updatedAt: 1,
          }),
      }),
    });
    expect(await screen.findByRole('link', { name: 'u9' })).toHaveAttribute(
      'href',
      '/admin/users/u9',
    );
    const email = screen.getByLabelText('Holder email');
    await user.clear(email);
    await user.type(email, 'b@example.com');
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(server.calls.some((c) => c.path === '/api/v1/holders/reassign')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Reassign' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/holders/reassign')).toBe(true),
    );
  });

  it('rejects a non-PNG image before upload and shows server image errors', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=images', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/passes/p1/assets/thumbnail@2x.png': () =>
          problem(422, 'IMAGE_INVALID', 'Image is smaller than 90x90.'),
      }),
    });
    await screen.findByText('No overrides');
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['nope'], 'bad.png', { type: 'image/png' }));
    expect(await screen.findByText('Not a PNG file.')).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);

    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 40);
    new DataView(png.buffer).setUint32(20, 40);
    await user.upload(input, new File([png], 'ok.png', { type: 'image/png' }));
    expect(await screen.findByText('Image is smaller than 90x90.')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('retries a failed email delivery with an idempotency key', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/passes/p1/resend-email': () => json({ ok: true }, 202),
      }),
    });
    const b = await screen.findByRole('button', { name: 'Retry' });
    await user.click(b);
    await waitFor(() => {
      const call = server.calls.find((c) => c.path === '/api/v1/passes/p1/resend-email');
      expect(headersOf(call?.init)['idempotency-key']).toBeTruthy();
    });
  });

  it('renders a retained version and diffs two versions', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=versions', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/passes/p1/versions/2': () =>
          json(passDetail({ version: 2, passJson: { ...SAMPLE_PASS_JSON, description: 'Old' } })),
        '/api/v1/passes/p1/diff': () =>
          json({ changes: [{ path: 'description', from: 'Old', to: 'Membership' }] }),
      }),
    });
    expect(await screen.findByText('description: "Old"')).toBeInTheDocument();
    expect(screen.getByText('description: "Membership"')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Render v1' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Render v2' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/versions/2')).toBe(true),
    );
  });

  it('lists activity from the audit log', async () => {
    await renderApp('/admin/passes/p1?tab=activity', {
      session: 'admin',
      handlers: handlers(newServer()),
    });
    expect(await screen.findByText('pass.update')).toBeInTheDocument();
  });

  it('shows the device count', async () => {
    await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      handlers: handlers(newServer()),
    });
    expect(await screen.findByText('Registered devices')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('pass detail: header actions', () => {
  it('needs the serial typed before deleting, then returns to the list', async () => {
    const user = userEvent.setup();
    const server = newServer();
    const { router } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/passes/p1': (_u, init) =>
          method(init) === 'DELETE' ? json({ ok: true }) : json(server.pass),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete pass' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Type SER-001 to confirm'), 'SER-001');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes'));
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('voids and rotates the link after confirmation', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: handlers(server, {
        '/api/v1/passes/p1/void': () => json(passSummary({ status: 'voided' })),
        '/api/v1/passes/p1/rotate-link': () =>
          json({ downloadUrl: '/p/new/pass.pkpass', publicUrl: '/p/new' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/void')).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Rotate link' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/rotate-link')).toBe(true),
    );
  });

  it('opens the public page in a new tab without a referrer', async () => {
    await renderApp('/admin/passes/p1', { session: 'admin', handlers: handlers(newServer()) });
    const link = await screen.findByRole('link', { name: 'Open public page' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('shows an error state when the pass is missing', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
        '/api/v1/passes/p1': () => problem(404, 'not_found', 'Pass not found.'),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Pass not found.');
  });
});
