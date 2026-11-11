import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { DEFAULT_SCAN_ACTION } from '@/shared/scan-defaults.ts';
import { json, membershipFixture, problem, renderApp } from '../../../lib/test-utils.tsx';
import { ORG, templateDetail, templateSummary } from '../../passes/test-fixtures.ts';
import { sampleDoc } from './fixtures.ts';
import type { DesignDoc } from './model.ts';

const VERSION = 'a1b2c3d4e5f6a7b8';
const ISSUE = {
  severity: 'error',
  code: 'FIELD_VALUE',
  message: 'Tier needs a value.',
  path: 'generic.secondaryFields[0].value',
};

interface Posted {
  dryRun: boolean;
  manifest: { scan?: { display?: { header: { title?: string } } } };
  passJson: { logoText?: string; generic: Record<string, { key: string }[]> };
  assets: { name: string; upload?: string }[];
}

function setup(
  over: {
    template?: Record<string, unknown>;
    issues?: unknown[];
    fail?: boolean;
    /** The first dry run builds; later ones fail with no pass, as the server does on an error. */
    nullOnError?: boolean;
    doc?: DesignDoc;
    saveError?: boolean;
    waitForDryRun?: (body: Posted) => Promise<void>;
    waitForSave?: (body: Posted) => Promise<void>;
    saveResponse?: {
      saved?: boolean;
      version?: string | null;
    };
  } = {},
) {
  const posts: Posted[] = [];
  const activations: unknown[] = [];
  const doc = over.doc ?? sampleDoc();
  const handlers = {
    '/api/v1/templates/tpl1': () =>
      json(templateDetail({ activeVersion: VERSION, ...over.template })),
    [`/api/v1/templates/tpl1/versions/${VERSION}`]: () =>
      json({
        version: VERSION,
        createdAt: 1,
        createdBy: null,
        assets: [
          {
            name: 'icon@3x.png',
            slot: 'icon',
            scale: 3,
            size: 100,
            crc32: 1,
            sha1: 'a'.repeat(40),
          },
        ],
        report: { ok: true, issues: [] },
        active: true,
        displayOnly: false,
        passCount: 0,
        manifest: doc.manifest,
        passJson: doc.passJson,
      }),
    '/api/v1/templates/tpl1/versions': async (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Posted;
      posts.push(body);
      if (body.dryRun) await over.waitForDryRun?.(body);
      else await over.waitForSave?.(body);
      if (!body.dryRun && over.saveError)
        return problem(409, 'VERSION_CONFLICT', 'The active version changed.');
      // nullOnError: the first dry run builds; later ones fail with the issues and no pass.
      const issues = over.nullOnError && posts.length === 1 ? [] : (over.issues ?? []);
      return json({
        saved: !body.dryRun,
        version: 'feedfacefeedface',
        created: true,
        displayOnly: false,
        report: {
          ok: !issues.some((i) => (i as { severity: string }).severity === 'error'),
          issues,
        },
        assets: [
          {
            name: 'icon@3x.png',
            slot: 'icon',
            scale: 3,
            size: 100,
            crc32: 1,
            sha1: 'a'.repeat(40),
          },
        ],
        // The server builds no pass when an issue is an error.
        passJson:
          over.nullOnError && issues.length
            ? null
            : {
                ...body.passJson,
                serialNumber: 'x',
                passTypeIdentifier: 'p',
                teamIdentifier: 't',
              },
        ...(!body.dryRun ? over.saveResponse : {}),
        template: null,
      });
    },
    '/api/v1/templates/tpl1/activate': (_url: URL, init?: RequestInit) => {
      activations.push(JSON.parse(String(init?.body)));
      return json(templateDetail());
    },
  };
  return { posts, activations, handlers };
}

const scanDoc = (): DesignDoc => {
  const doc = sampleDoc();
  doc.manifest.scan = {
    actions: [DEFAULT_SCAN_ACTION],
    display: { v: 1, header: { title: 'Welcome' } },
  };
  return doc;
};

async function scanHeader() {
  await userEvent.click(await screen.findByRole('radio', { name: 'Scan screen' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Header' }));
  return screen.findByLabelText('Result title');
}

async function readyToSave() {
  await screen.findByText('Ready to save.');
  await waitFor(() => expect(screen.queryByText('Checking')).toBeNull());
}

/** Hold a response until the test releases it; the web target is ES2023. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

const open = (s: ReturnType<typeof setup>) =>
  renderApp('/admin/templates/tpl1/design', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: s.handlers,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // Storage is blocked in this runtime.
  }
});

describe('designer', () => {
  it('refetches ownership before reopening the designer without an explicit org', async () => {
    const s = setup();
    let moved = false;
    let reads = 0;
    let held = false;
    const movedCard = templateDetail({
      activeVersion: VERSION,
      orgId: 'org2',
      orgName: 'Harbor',
      name: 'Moved card',
    });
    let resolve!: (response: Response) => void;
    // The web target is ES2023, before Promise.withResolvers.
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { router, fetchMock } = await renderApp('/admin/templates/tpl1/design', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        ...s.handlers,
        '/api/v1/templates/tpl1': () => {
          reads += 1;
          if (!moved) return json(templateDetail({ activeVersion: VERSION, name: 'Former card' }));
          // A response body reads once: the first read waits, later reads get their own.
          if (held) return json(movedCard);
          held = true;
          return pending;
        },
      },
    });
    await screen.findByRole('navigation', { name: 'Structure' });
    const versionReads = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes(`/versions/${VERSION}`)).length;
    const before = versionReads();
    moved = true;
    await act(async () => {
      await router.navigate({
        to: '/admin/templates/$templateId/design',
        params: { templateId: 'tpl1' },
        search: { orgId: undefined },
      });
    });
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.queryByText('Former card')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Structure' })).toBeNull();
    expect(versionReads()).toBe(before);
    await act(async () => {
      resolve(json(movedCard));
    });
    expect(await screen.findByRole('navigation', { name: 'Structure' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    expect(screen.queryByText('Former card')).toBeNull();
  });

  it('canonicalizes a bare designer link to the resource organization', async () => {
    localStorage.setItem('wallet-org-filter', ORG.id);
    const s = setup({ template: { orgId: 'org2', orgName: 'Harbor' } });
    const { router, fetchMock } = await renderApp('/admin/templates/tpl1/design', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      handlers: s.handlers,
    });
    expect(await screen.findByRole('navigation', { name: 'Structure' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    const versionUrl = fetchMock.mock.calls
      .map(([url]) => new URL(String(url), 'http://localhost'))
      .find((url) => url.pathname === `/api/v1/templates/tpl1/versions/${VERSION}`);
    expect(versionUrl?.searchParams.get('orgId')).toBe('org2');
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Copper card' })).toHaveAttribute(
      'href',
      '/admin/templates/tpl1?orgId=org2',
    );
  });

  it('requires an explicit organization after an unscoped shared designer read is denied', async () => {
    localStorage.setItem('wallet-org-filter', ORG.id);
    const user = userEvent.setup();
    const s = setup();
    const requested: (string | null)[] = [];
    await renderApp('/admin/templates/tpl1/design', {
      session: 'user',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      handlers: {
        ...s.handlers,
        '/api/v1/templates/tpl1': (url) => {
          const orgId = url.searchParams.get('orgId');
          requested.push(orgId);
          return orgId === 'org2'
            ? json(templateDetail({ activeVersion: VERSION, orgId: null, orgName: null }))
            : problem(403, 'forbidden', 'Forbidden.');
        },
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(requested.every((orgId) => orgId === null)).toBe(true);
    expect(screen.queryByRole('navigation', { name: 'Structure' })).toBeNull();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(
      await screen.findByText(/Only platform administrators can change shared templates/),
    ).toBeInTheDocument();
    expect(requested).toContain('org2');
    expect(requested).not.toContain(ORG.id);
  });

  it('lets an author save an inactive version without offering publication', async () => {
    const user = userEvent.setup();
    const s = setup();
    await renderApp('/admin/templates/tpl1/design', {
      session: 'user',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:author'] }),
      ],
      selectedOrg: ORG.id,
      handlers: s.handlers,
    });
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)).toHaveLength(1);
    expect(s.posts.filter((p) => !p.dryRun)[0]).not.toHaveProperty('activate');
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('saves scan changes without activation for an author lacking publish access', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc() });
    await renderApp('/admin/templates/tpl1/design', {
      session: 'user',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:author'] }),
      ],
      selectedOrg: ORG.id,
      handlers: s.handlers,
    });
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    const saved = s.posts.filter((p) => !p.dryRun);
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty('activate');
    expect(saved[0]).not.toHaveProperty('expectedActiveVersion');
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review and activate' })).toBeNull();
  });

  it('opens the latest inactive candidate when a template has no active version', async () => {
    const first = templateDetail().versions[0]!;
    const s = setup({ template: { activeVersion: null, versions: [{ ...first, active: false }] } });
    const { fetchMock } = await open(s);
    expect(await screen.findByRole('navigation', { name: 'Structure' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/versions/${VERSION}`))).toBe(
      true,
    );
  });

  it('shows an empty state instead of waiting forever when no version exists', async () => {
    const s = setup({ template: { activeVersion: null, versions: [] } });
    const { fetchMock } = await open(s);
    expect(await screen.findByText('No versions yet')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Structure' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/versions/${VERSION}`))).toBe(
      false,
    );
  });

  it('shows an uploaded shared template read-only to a tenant author', async () => {
    const s = setup({ template: { orgId: null, orgName: null } });
    await renderApp('/admin/templates/tpl1/design', {
      session: 'user',
      memberships: [membershipFixture(ORG.id)],
      selectedOrg: ORG.id,
      handlers: s.handlers,
    });
    expect(
      await screen.findByText(/Only platform administrators can change shared templates/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
  });

  it('does not mount the designer, version, or preview for another organization', async () => {
    const s = setup({
      template: { orgId: 'org2', orgName: 'Harbor', name: 'Private template', origin: 'baked' },
    });
    const { fetchMock } = await renderApp('/admin/templates/tpl1/design', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: ORG.id,
      handlers: s.handlers,
    });
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByText('Private template')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Structure' })).toBeNull();
    expect(screen.queryByTestId('designer-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    const paths = fetchMock.mock.calls.map(
      ([url]) => new URL(String(url), 'http://localhost').pathname,
    );
    expect(paths).not.toContain(`/api/v1/templates/tpl1/versions/${VERSION}`);
    expect(paths).not.toContain('/api/v1/templates/previews');
    expect(s.posts).toEqual([]);
  });

  it('unmounts the designer as soon as the selected organization changes', async () => {
    const user = userEvent.setup();
    const s = setup();
    await renderApp('/admin/templates/tpl1/design', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: ORG.id,
      handlers: s.handlers,
    });
    await screen.findByRole('navigation', { name: 'Structure' });
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Structure' })).toBeNull();
    expect(screen.queryByTestId('designer-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
  });

  it('opens an uploaded shared template in the selected organization', async () => {
    const user = userEvent.setup();
    const s = setup({ template: { orgId: null, orgName: null } });
    await open(s);
    expect(await screen.findByRole('navigation', { name: 'Structure' })).toBeInTheDocument();
    // The save bar appears with the first edit.
    await user.type(await screen.findByLabelText('Logo text'), '!');
    expect(await screen.findByRole('button', { name: 'Save version' })).toBeInTheDocument();
  });

  it('shows structure, the card with its flip, and issues, with no axe violations', async () => {
    const s = setup();
    const { container } = await open(s);
    expect(await screen.findByRole('navigation', { name: 'Structure' })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Issues' })).toBeInTheDocument();
    await screen.findByText('Ready to save.');
    await userEvent.click(screen.getByRole('button', { name: 'Colors' }));
    expect(await screen.findByLabelText('Background')).toHaveValue('#141e3c');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('has no axe violations in any inspector', async () => {
    const user = userEvent.setup();
    const s = setup();
    const { container } = await open(s);
    await screen.findByRole('navigation', { name: 'Structure' });
    for (const name of [
      /^Images/,
      /^Primary/,
      /^Back/,
      /^Inputs/,
      /^Barcode/,
      /^Relevance/,
      /^Template/,
    ]) {
      await user.click(await screen.findByRole('button', { name }));
      if (String(name).includes('Primary')) {
        await user.click(await screen.findByRole('button', { name: /^Member/ }));
        await screen.findByLabelText('Change message');
      }
      if (String(name).includes('Inputs')) {
        await user.click(await screen.findByRole('button', { name: /^Name/ }));
        await screen.findByLabelText('Sample');
      }
      expect((await axe(container)).violations, String(name)).toEqual([]);
    }
  });

  it('drags a field to another position', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Secondary/ }));
    const list = await screen.findByRole('list', { name: 'Secondary fields' });
    const rows = within(list).getAllByRole('listitem');
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
    };
    fireEvent.dragStart(rows[0] as HTMLElement, { dataTransfer });
    fireEvent.dragOver(rows[1] as HTMLElement, { dataTransfer });
    fireEvent.drop(rows[1] as HTMLElement, { dataTransfer });
    await waitFor(() => {
      const names = within(screen.getByRole('list', { name: 'Secondary fields' })).getAllByRole(
        'button',
        { name: /^Move .* up$/ },
      );
      expect(names[0]).toHaveAttribute('aria-label', 'Move since up');
    });
  });

  it('undoes and redoes from the buttons and the keyboard, and guards unsaved edits', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    const logo = await screen.findByLabelText('Logo text');
    await user.clear(logo);
    await user.type(logo, 'Hi');
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByLabelText('Logo text')).toHaveValue('Hi');
    // Typing in one go is one undo step.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Logo text')).toHaveValue('Org');
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    fireEvent.keyDown(screen.getByLabelText('Logo text'), {
      key: 'z',
      shiftKey: true,
      ctrlKey: true,
    });
    expect(screen.getByLabelText('Logo text')).toHaveValue('Hi');
    fireEvent.keyDown(screen.getByLabelText('Logo text'), { key: 'z', ctrlKey: true });
    expect(screen.getByLabelText('Logo text')).toHaveValue('Org');
  });

  it('adds a field, opens its editor and sends it in the next check', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Header/ }));
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    expect(await screen.findByLabelText('Label')).toBeInTheDocument();
    await waitFor(() =>
      expect(s.posts.some((p) => (p.passJson.generic.headerFields?.length ?? 0) === 1)).toBe(true),
    );
    expect(s.posts.every((p) => p.dryRun)).toBe(true);
  });

  it('reorders with Alt+Arrow and the move buttons, and announces it', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Secondary/ }));
    const list = await screen.findByRole('list', { name: 'Secondary fields' });
    const first = within(list).getAllByRole('button', { expanded: false })[0] as HTMLElement;
    first.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByText('tier moved to position 2 of 2.')).toBeInTheDocument();
    const keys = within(list)
      .getAllByRole('button', { name: /^Move .* up$/ })
      .map((b) => b.getAttribute('aria-label'));
    expect(keys).toEqual(['Move since up', 'Move tier up']);
    expect(within(list).getByRole('button', { name: 'Move since up' })).toBeDisabled();
  });

  it('links an issue to the field it concerns', async () => {
    const user = userEvent.setup();
    const s = setup({ issues: [ISSUE] });
    await open(s);
    await user.click(await screen.findByRole('button', { name: /Tier needs a value/ }));
    const row = await screen.findByRole('button', { name: /^Tier/, expanded: true });
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('warns about low contrast and about nothing else when colors are fine', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: 'Colors' }));
    const fg = await screen.findByLabelText('Text');
    await user.clear(fg);
    await user.type(fg, 'rgb(20,30,60)');
    expect(
      (await screen.findAllByText(/^Text contrast is \d+\.\d:1; use at least 4\.5:1\.$/)).length,
    ).toBeGreaterThan(0);
  });

  it('takes a PNG for a slot and sends it as an upload', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Images/ }));
    const png = new Uint8Array(33);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82], 0);
    new DataView(png.buffer).setUint32(16, 114);
    new DataView(png.buffer).setUint32(20, 114);
    const file = new File([png], 'icon.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => png.buffer });
    const row = (await screen.findByRole('button', { name: 'Replace Icon' })).closest('li');
    await user.upload(row?.querySelector('input[type=file]') as HTMLInputElement, file);
    await waitFor(() =>
      expect(s.posts.some((p) => p.assets.some((a) => a.name === 'icon@3x.png' && a.upload))).toBe(
        true,
      ),
    );
  });

  it('saves an inactive version and links to the release review', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await screen.findByText('Ready to save.');
    await waitFor(() => expect(screen.queryByText('Checking')).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\./)).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)).toHaveLength(1);
    expect(s.posts.filter((p) => !p.dryRun)[0]).not.toHaveProperty('activate');
    expect(screen.getByRole('link', { name: 'Review release' })).toHaveAttribute(
      'href',
      `/admin/templates/tpl1?tab=versions&orgId=${ORG.id}`,
    );
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(s.activations).toEqual([]);
  });

  it('keeps focus while typing a multi-character input name and field key', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Inputs/ }));
    await user.click(await screen.findByRole('button', { name: /^Name/ }));
    const name = await screen.findByLabelText('Name', { selector: 'input' });
    await user.clear(name);
    await user.type(name, 'member');
    expect(name).toHaveFocus();
    expect(name).toHaveValue('member');
    await user.tab();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Name/ })).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /^Primary/ }));
    await user.click(await screen.findByRole('button', { name: /^Member/ }));
    const key = await screen.findByLabelText('Key');
    await user.clear(key);
    await user.type(key, 'who');
    expect(key).toHaveFocus();
    expect(key).toHaveValue('who');
  });

  it('keeps the designer and its edits when another administrator changes the active version', async () => {
    const user = userEvent.setup();
    const s = setup();
    let active = VERSION;
    s.handlers['/api/v1/templates/tpl1'] = () => json(templateDetail({ activeVersion: active }));
    const { queryClient } = await open(s);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await screen.findByText('Ready to save.');
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    await screen.findByText(/Version saved\./);
    active = 'feedfacefeedface';
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'templates', 'detail', 'tpl1'] });
    });
    expect(screen.getByLabelText('Logo text')).toHaveValue('Org!');
  });

  it('keeps a further draft without a stale prompt when the active version changes', async () => {
    const user = userEvent.setup();
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    const s = setup();
    let active = VERSION;
    s.handlers['/api/v1/templates/tpl1'] = () => json(templateDetail({ activeVersion: active }));
    const { queryClient } = await open(s);
    const logo = await screen.findByLabelText('Logo text');
    await user.type(logo, '!');
    await screen.findByText('Ready to save.');
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    await user.type(await screen.findByLabelText('Logo text'), '?');
    await waitFor(
      () =>
        expect(
          [...mem.keys()].some((k) => k.startsWith('passbook:designer:') && k.endsWith(':tpl1')),
        ).toBe(true),
      {
        timeout: 3000,
      },
    );
    active = 'feedfacefeedface';
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'templates', 'detail', 'tpl1'] });
    });
    expect(screen.queryByText(/unsaved draft from an older version/)).toBeNull();
    expect(screen.getByLabelText('Logo text')).toHaveValue('Org!?');
  });

  it('flags blank barcode text and blocks saving', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Barcode/ }));
    await user.click(await screen.findByRole('combobox', { name: 'Message' }));
    await user.click(await screen.findByRole('option', { name: 'Text in the template' }));
    const text = await screen.findByLabelText('Message text');
    await user.clear(text);
    expect(await screen.findAllByText('Enter the barcode text, or pick an input.')).toHaveLength(2);
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    expect(s.posts.every((p) => p.dryRun)).toBe(true);
  });

  it('edits beacons as keyed rows: row state stays with its row through a move', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Relevance/ }));
    const add = await screen.findByRole('button', { name: 'Add beacon' });
    await user.click(add);
    await user.click(add);
    const uuids = await screen.findAllByLabelText(/^UUID/);
    await user.type(uuids[0] as HTMLElement, 'nope');
    await user.tab();
    expect(await screen.findByText('Check the format.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move Beacon 1 down' }));
    const moved = await screen.findAllByLabelText(/^UUID/);
    expect(moved[1]).toHaveValue('nope');
    expect(moved[0]).toHaveValue('');
  });

  it('labels an empty image slot Add, with the visible word in its name', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('button', { name: /^Images/ }));
    const adds = await screen.findAllByRole('button', { name: /^Add / });
    for (const add of adds) expect(add).toHaveTextContent(/^Add$/);
  });

  it('keeps the last card while an error stops the pass from building', async () => {
    const user = userEvent.setup();
    const s = setup({ issues: [ISSUE], nullOnError: true });
    await open(s);
    const preview = await screen.findByTestId('designer-preview');
    expect((await within(preview).findAllByText('Org')).length).toBeGreaterThan(0);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await screen.findByText('1 to fix');
    expect(within(preview).getAllByText('Org').length).toBeGreaterThan(0);
  });

  it('will not save while the check has errors', async () => {
    const user = userEvent.setup();
    const s = setup({ issues: [ISSUE] });
    await open(s);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await screen.findByText('1 to fix');
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    expect(s.posts.every((p) => p.dryRun)).toBe(true);
  });

  it('shows a built-in template read only, with Duplicate', async () => {
    const s = setup({ template: templateSummary({ origin: 'baked', orgId: null }) });
    await open(s);
    expect(
      await screen.findByText('This template is read only. Duplicate it to design your own.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Issues' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    // The structure is shown but cannot be used.
    expect(screen.getByRole('navigation', { name: 'Structure', hidden: true })).toBeInTheDocument();
    expect(s.posts).toEqual([]);
  });

  it('shows only the preview on a phone', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 639'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const s = setup();
    await open(s);
    expect(await screen.findByText('Preview only')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Structure' })).toBeNull();
    expect(await screen.findByRole('radio', { name: 'Details' })).toBeInTheDocument();
  });

  it('keeps the two selections and shares undo across mode switches', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc() });
    await open(s);
    await user.click(await screen.findByRole('button', { name: 'Colors' }));
    expect(await screen.findByLabelText('Background')).toBeInTheDocument();
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    expect(await screen.findByLabelText('Background')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('radio', { name: 'Pass' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Background')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await user.click(screen.getByRole('radio', { name: 'Scan screen' }));
    expect(await screen.findByLabelText('Result title')).toHaveValue('Hello');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Result title')).toHaveValue('Welcome');
    expect(screen.getByRole('radio', { name: 'Scan screen' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('recovers a scan edit after reload and discards the shared draft', async () => {
    const user = userEvent.setup();
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    const s = setup({ doc: scanDoc() });
    const view = await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await waitFor(
      () => expect([...mem.values()].some((v) => v.includes('"title":"Hello"'))).toBe(true),
      { timeout: 3000 },
    );
    view.unmount();

    await open(s);
    expect(await screen.findByText('Restored your unsaved draft.')).toBeInTheDocument();
    expect(await scanHeader()).toHaveValue('Hello');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByLabelText('Result title')).toHaveValue('Welcome');
    await waitFor(() =>
      expect([...mem.values()].some((v) => v.includes('"title":"Hello"'))).toBe(false),
    );
  });

  it('saves a scan-only change as an inactive version', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc() });
    await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)).toMatchObject([
      {
        manifest: { scan: { display: { header: { title: 'Hello' } } } },
      },
    ]);
    expect(screen.getByRole('link', { name: 'Review release' })).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)[0]).not.toHaveProperty('expectedActiveVersion');
  });

  it('saves a new scan display with implicit scanner defaults as inactive', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.click(await screen.findByRole('radio', { name: 'Scan screen' }));
    await user.click(await screen.findByRole('button', { name: 'Start blank' }));
    fireEvent.change(await screen.findByLabelText('Result title'), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)).toMatchObject([
      {
        manifest: {
          scan: {
            actions: [DEFAULT_SCAN_ACTION],
            display: { header: { title: 'Hello' } },
          },
        },
      },
    ]);
  });

  it('saves successive scan changes without activating either version', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc() });
    await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await screen.findByText(/Version saved\. Existing releases/);
    fireEvent.change(screen.getByLabelText('Result title'), { target: { value: 'Hello again' } });
    await readyToSave();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(s.posts.filter((p) => !p.dryRun)).toHaveLength(2));
    const saved = s.posts.filter((p) => !p.dryRun);
    expect(saved[1]).not.toHaveProperty('activate');
    expect(saved[1]).not.toHaveProperty('expectedActiveVersion');
  });

  it('keeps later scan edits in a draft based on the saved version', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    const s = setup({ doc: scanDoc(), waitForSave: () => gate.promise });
    await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(s.posts.filter((p) => !p.dryRun)).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Result title'), { target: { value: 'Hello again' } });
    gate.resolve();
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    expect(screen.getByLabelText('Result title')).toHaveValue('Hello again');
    await waitFor(
      () =>
        expect(
          [...mem.values()].some(
            (v) => v.includes('"base":"feedfacefeedface"') && v.includes('"title":"Hello again"'),
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Result title')).toHaveValue('Hello');
  });

  it('uses the reviewed version path for a mixed pass and scan change', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc() });
    await open(s);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    const saved = s.posts.filter((p) => !p.dryRun);
    expect(saved).toMatchObject([
      {
        passJson: { logoText: 'Org!' },
        manifest: { scan: { display: { header: { title: 'Hello' } } } },
      },
    ]);
    expect(saved[0]).not.toHaveProperty('expectedActiveVersion');
    expect(screen.getByRole('link', { name: 'Review release' })).toBeInTheDocument();
  });

  it('blocks invalid scan edits even after switching to Pass', async () => {
    const user = userEvent.setup();
    const s = setup({
      doc: scanDoc(),
      issues: [
        {
          severity: 'warning',
          code: 'SCAN_DISPLAY_TITLE',
          path: 'scan.display.header.title',
          message: 'A result word cannot be in the band title.',
        },
      ],
    });
    await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Denied' } });
    expect(
      (await screen.findAllByText('A result word cannot be in the band title.')).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    await waitFor(() => expect(screen.queryByText('Checking')).toBeNull());
    const issues = within(screen.getByRole('region', { name: 'Issues' }));
    expect(issues.getAllByText('A result word cannot be in the band title.')).toHaveLength(1);
    expect(issues.getByText('1 to fix')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(s.posts.every((p) => p.dryRun)).toBe(true);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('waits for the latest dry run rather than saving against an older result', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    let started = false;
    const s = setup({
      doc: scanDoc(),
      waitForDryRun: (body) => {
        if (body.manifest.scan?.display?.header.title !== 'Hello') return Promise.resolve();
        started = true;
        return gate.promise;
      },
    });
    await open(s);
    const title = await scanHeader();
    await readyToSave();
    fireEvent.change(title, { target: { value: 'Hello' } });
    await waitFor(() => expect(started).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(s.posts.every((p) => p.dryRun)).toBe(true);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    gate.resolve();
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
  });

  it('sends a scan screen save through release review, not activation', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc() });
    await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\. Existing releases/)).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)).toHaveLength(1);
    expect(s.posts.filter((p) => !p.dryRun)[0]).not.toHaveProperty('activate');
    expect(screen.getByRole('link', { name: 'Review release' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('lists scan screen problems once, in Issues, and opens the part they name', async () => {
    const user = userEvent.setup();
    const doc = scanDoc();
    doc.manifest.scan = {
      actions: [DEFAULT_SCAN_ACTION],
      display: {
        v: 1,
        header: {},
        panels: [
          {
            id: 'p_bad',
            rows: [
              { id: 'r_a', type: 'big', value: 'A' },
              { id: 'r_b', type: 'big', value: 'B' },
              { id: 'r_c', type: 'big', value: 'C' },
            ],
          },
        ],
      },
    };
    const s = setup({ doc });
    await open(s);
    await user.click(await screen.findByRole('radio', { name: 'Scan screen' }));
    const issues = await screen.findByRole('region', { name: 'Issues' });
    await within(issues).findByText(/Use two big values at most/i);
    expect(screen.queryByRole('region', { name: 'Scan screen issues' })).toBeNull();
    expect(screen.getAllByText(/Phone fit:/)).toHaveLength(1);
    await user.click(within(issues).getByText(/Use two big values at most/i));
    const panel = document.querySelector('[data-target="scan-display:p_bad"]');
    await waitFor(() => expect(panel).toHaveAttribute('aria-expanded', 'true'));
  });

  it('asks before replacing an invalid saved scan screen', async () => {
    const user = userEvent.setup();
    const doc = scanDoc();
    doc.manifest.scan = { actions: [DEFAULT_SCAN_ACTION], display: { v: 2, header: {} } };
    const s = setup({ doc });
    await open(s);
    await user.click(await screen.findByRole('radio', { name: 'Scan screen' }));
    expect(await screen.findByText('The saved scan screen is invalid')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace with default' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Replace the saved scan screen?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('The saved scan screen is invalid')).toBeInTheDocument();
    expect(s.posts.every((p) => p.dryRun)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Replace with default' }));
    const again = await screen.findByRole('alertdialog', {
      name: 'Replace the saved scan screen?',
    });
    await user.click(within(again).getByRole('button', { name: 'Replace with default' }));
    await waitFor(() => expect(screen.queryByText('The saved scan screen is invalid')).toBeNull());
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
  });

  it('keeps the draft when the server returns an unsaved response', async () => {
    const user = userEvent.setup();
    const s = setup({ doc: scanDoc(), saveResponse: { saved: false, version: null } });
    await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(
      await screen.findByText(
        'The server did not save this version. Review the issues and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Result title')).toHaveValue('Hello');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByText('Scan screen saved and active.')).toBeNull();
  });

  it('preserves the scan draft and its base after a version conflict', async () => {
    const user = userEvent.setup();
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    const s = setup({ doc: scanDoc(), saveError: true });
    const view = await open(s);
    fireEvent.change(await scanHeader(), { target: { value: 'Hello' } });
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await screen.findByText('Could not save');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(
      [...mem.values()].some(
        (v) => v.includes(`"base":"${VERSION}"`) && v.includes('"title":"Hello"'),
      ),
    ).toBe(true);
    view.unmount();
    await open(s);
    expect(await screen.findByText('Restored your unsaved draft.')).toBeInTheDocument();
    expect(await scanHeader()).toHaveValue('Hello');
  });
});
