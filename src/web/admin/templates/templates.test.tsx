import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '../../lib/test-utils.tsx';
import { ORG, SAMPLE_PASS_JSON, templateDetail, templateSummary } from '../passes/test-fixtures.ts';
import { importPolling } from './api.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const orgs = () => json({ items: [ORG], nextCursor: null });
const preview = () => json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a' });

describe('templates list', () => {
  it('marks baked templates and sends the origin filter', async () => {
    const seen: URL[] = [];
    await renderApp('/admin/templates?origin=baked', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': (url) => {
          seen.push(url);
          return json({
            items: [
              templateSummary({
                id: 'b1',
                name: 'Starter',
                origin: 'baked',
                orgId: null,
                orgName: null,
                passCount: 0,
              }),
              templateSummary(),
            ],
            nextCursor: null,
          });
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'Starter' })).toHaveAttribute(
      'href',
      '/admin/templates/b1',
    );
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getAllByText('Baked').length).toBeGreaterThan(1);
    expect(seen[0]?.searchParams.get('origin')).toBe('baked');
  });

  it('adds includeArchived when asked and keeps it in the URL', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/templates', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': (url) => {
          seen.push(url);
          return json({ items: [templateSummary()], nextCursor: null });
        },
      },
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Show archived' }));
    await waitFor(() => expect(seen.at(-1)?.searchParams.get('includeArchived')).toBe('true'));
    expect((router.state.location.search as { archived?: boolean }).archived).toBe(true);
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/templates', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      },
    });
    await screen.findByRole('link', { name: 'Copper card' });
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('template detail', () => {
  it('shows versions with issue counts and the selected validation report', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    expect(await screen.findByText('Missing @3x icon.')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Report for ffeeddccbbaa' }));
    expect(await screen.findByText('Duplicate key.')).toBeInTheDocument();
    expect(screen.getByText('generic.primaryFields')).toBeInTheDocument();
    // A version with errors cannot be activated.
    expect(screen.getByRole('button', { name: 'Activate ffeeddccbbaa' })).toBeDisabled();
  });

  it('activates a version with the rebuild option', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const detail = templateDetail();
    detail.versions[1] = {
      ...detail.versions[1],
      report: { ok: true, issues: [] },
    } as (typeof detail.versions)[1];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(detail),
        '/api/v1/templates/tpl1/preview': preview,
        '/api/v1/templates/tpl1/activate': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(detail);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Activate ffeeddccbbaa' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Rebuild all passes/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ version: 'ffeeddccbbaa9988', rebuildPasses: true }]),
    );
  });

  it('offers Customize for baked templates and no delete', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/templates/b1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/b1': () =>
          json(templateDetail({ id: 'b1', origin: 'baked', orgId: null })),
        '/api/v1/templates/b1/preview': preview,
        '/api/v1/templates/b1/clone': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(templateDetail({ id: 'copy1', name: 'Copy' }), 201);
        },
        '/api/v1/templates/copy1': () => json(templateDetail({ id: 'copy1', name: 'Copy' })),
        '/api/v1/templates/copy1/preview': preview,
      },
    });
    expect(await screen.findByRole('button', { name: 'Customize' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    expect(await within(dialog).findByText('Choose an organization.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: "Henry's" }));
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(bodies).toEqual([{ orgId: 'org1', name: 'Copper card copy' }]));
  });

  it('assigns the organization and shows the conflict as the form error', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let conflict = true;
    await renderApp('/admin/templates/b1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/b1': (_u, init) => {
          if (method(init) === 'PATCH') {
            bodies.push(JSON.parse(String(init?.body)));
            if (conflict)
              return problem(
                409,
                'TEMPLATE_USED_BY_OTHER_ORG',
                'Passes of another organization use this template. Reissue or delete them first.',
              );
            return json(templateDetail({ id: 'b1', origin: 'baked', orgId: 'org1' }));
          }
          return json(templateDetail({ id: 'b1', origin: 'baked', orgId: null, orgName: null }));
        },
        '/api/v1/templates/b1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Inputs' }));
    const select = await screen.findByRole('combobox', { name: 'Organization' });
    expect(select).toHaveTextContent('None');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: "Henry's" }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Passes of another organization/);
    conflict = false;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ orgId: 'org1' }, { orgId: 'org1' }]));
  });

  it('archives when passes use it and explains the rule', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const { router } = await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/tpl1': (_u, init) => {
          if (method(init) === 'DELETE') {
            calls.push('DELETE');
            return json({ ok: true });
          }
          return json(templateDetail({ passCount: 4 }));
        },
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('archived while passes use them and deleted when none do');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/templates'));
    expect(calls).toEqual(['DELETE']);
  });

  it('shows the manifest', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Manifest' }));
    const editor = await screen.findByRole('textbox', { name: 'Manifest JSON' });
    expect((editor as HTMLTextAreaElement).value).toContain('"inputs"');
  });

  it('saves an edited manifest and shows server errors by path', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/tpl1/preview': preview,
        '/api/v1/templates/tpl1/manifest': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length === 1
            ? problem(422, 'MANIFEST_INVALID', 'The manifest is invalid.', [
                { path: '/bindings/0/to', message: 'Unknown target.' },
              ])
            : json(templateDetail());
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Manifest' }));
    const editor = await screen.findByRole('textbox', { name: 'Manifest JSON' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(editor);
    await user.paste(' ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('/bindings/0/to: Unknown target.')).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
  });

  it('rejects malformed JSON before calling the server', async () => {
    const user = userEvent.setup();
    let calls = 0;
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/tpl1/preview': preview,
        '/api/v1/templates/tpl1/manifest': () => {
          calls += 1;
          return json(templateDetail());
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Manifest' }));
    await user.click(await screen.findByRole('textbox', { name: 'Manifest JSON' }));
    await user.paste('{');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid JSON');
    expect(calls).toBe(0);
  });

  it('shows an error state for a missing template', async () => {
    await renderApp('/admin/templates/nope', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/nope': () => problem(404, 'not_found', 'Template not found.'),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Template not found.');
  });
});

describe('template upload', () => {
  const previous = importPolling.ms;
  beforeEach(() => {
    importPolling.ms = 15;
  });
  afterEach(() => {
    importPolling.ms = previous;
  });

  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: "Henry's" }));
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['zip'], 'card.zip', { type: 'application/zip' }));
    await user.click(screen.getByRole('button', { name: 'Upload' }));
  }

  it('uploads, polls the workflow, shows the report and links the template', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const posted: { url: URL; init?: RequestInit }[] = [];
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': (url, init) => {
          posted.push({ url, init });
          return json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202);
        },
        '/api/v1/templates/uploads/up1': () => {
          polls += 1;
          const base = {
            uploadId: 'up1',
            templateId: null,
            version: null,
            report: null,
            error: null,
          };
          if (polls === 1) return json({ ...base, status: 'queued', step: null });
          if (polls < 4) return json({ ...base, status: 'running', step: 'validate' });
          return json({
            ...base,
            status: 'complete',
            step: null,
            templateId: 'tpl7',
            version: 'abc',
            report: {
              ok: true,
              issues: [{ severity: 'warning', code: 'IMG', message: 'Dropped unused slot.' }],
            },
          });
        },
      },
    });
    await fill(user);
    expect(await screen.findByText('Processing: validate')).toBeInTheDocument();
    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText('Dropped unused slot.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open template' })).toHaveAttribute(
      'href',
      '/admin/templates/tpl7',
    );
    expect(posted[0]?.url.searchParams.get('orgId')).toBe('org1');
    const headers = (posted[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/zip');
    // Polling stops at the final state.
    const settled = polls;
    await new Promise((r) => setTimeout(r, 80));
    expect(polls).toBe(settled);
  });

  it('shows the failure and lets the user try again', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': () =>
          json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202),
        '/api/v1/templates/uploads/up1': () =>
          json({
            uploadId: 'up1',
            status: 'errored',
            step: 'unzip',
            templateId: null,
            version: null,
            error: 'Archive has too many entries.',
            report: {
              ok: false,
              issues: [{ severity: 'error', code: 'ZIP_LIMIT', message: 'More than 100 entries.' }],
            },
          }),
      },
    });
    await fill(user);
    expect(await screen.findByText('Archive has too many entries.')).toBeInTheDocument();
    expect(screen.getByText('More than 100 entries.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('maps the IMPORT_INVALID code to a sentence', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': () =>
          json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202),
        '/api/v1/templates/uploads/up1': () =>
          json({
            uploadId: 'up1',
            status: 'errored',
            step: 'validate',
            templateId: null,
            version: null,
            error: 'IMPORT_INVALID',
            report: { ok: false, issues: [] },
          }),
      },
    });
    await fill(user);
    expect(
      await screen.findByText('The package has errors. Fix them and upload again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('IMPORT_INVALID')).toBeNull();
  });

  it('shows the server error when the upload is rejected', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': () => problem(413, 'TOO_LARGE', 'File is over 15 MB.'),
      },
    });
    await fill(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('File is over 15 MB.');
  });

  it('rejects other file types before upload and keeps Upload disabled', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      handlers: { '/api/v1/orgs': orgs },
    });
    await screen.findByRole('combobox', { name: 'Organization' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByText(/unsupported type/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/templates/upload', {
      session: 'admin',
      handlers: { '/api/v1/orgs': orgs },
    });
    await screen.findByRole('combobox', { name: 'Organization' });
    expect((await axe(container)).violations).toEqual([]);
  });
});
