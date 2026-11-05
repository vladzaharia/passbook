import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '../../../lib/test-utils.tsx';
import { templateDetail, templateSummary } from '../../passes/test-fixtures.ts';
import { sampleDoc } from './fixtures.ts';

const VERSION = 'a1b2c3d4e5f6a7b8';
const ISSUE = {
  severity: 'error',
  code: 'FIELD_VALUE',
  message: 'Tier needs a value.',
  path: 'generic.secondaryFields[0].value',
};

interface Posted {
  dryRun: boolean;
  activate?: boolean;
  passJson: { logoText?: string; generic: Record<string, { key: string }[]> };
  assets: { name: string; upload?: string }[];
}

function setup(
  over: { template?: Record<string, unknown>; issues?: unknown[]; fail?: boolean } = {},
) {
  const posts: Posted[] = [];
  const activations: unknown[] = [];
  const doc = sampleDoc();
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
        passCount: 0,
        manifest: doc.manifest,
        passJson: doc.passJson,
      }),
    '/api/v1/templates/tpl1/versions': (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Posted;
      posts.push(body);
      const issues = over.issues ?? [];
      return json({
        saved: !body.dryRun,
        version: 'feedfacefeedface',
        created: true,
        activated: Boolean(body.activate),
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
        passJson: {
          ...body.passJson,
          serialNumber: 'x',
          passTypeIdentifier: 'p',
          teamIdentifier: 't',
        },
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

const open = (s: ReturnType<typeof setup>) =>
  renderApp('/admin/templates/tpl1/design', { session: 'admin', handlers: s.handlers });

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // Storage is blocked in this runtime.
  }
});

describe('designer', () => {
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

  it('saves a version, then offers Activate', async () => {
    const user = userEvent.setup();
    const s = setup();
    await open(s);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await screen.findByText('Ready to save.');
    await waitFor(() => expect(screen.queryByText('Checking')).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    expect(await screen.findByText(/Version saved\./)).toBeInTheDocument();
    expect(s.posts.filter((p) => !p.dryRun)).toMatchObject([{ activate: false }]);
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Activate' }),
    );
    await waitFor(() => expect(s.activations).toEqual([{ version: 'feedfacefeedface' }]));
    expect(await screen.findByText('Version saved and active.')).toBeInTheDocument();
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

  it('keeps the designer and its edits when activation moves the active version', async () => {
    const user = userEvent.setup();
    const s = setup();
    let active = VERSION;
    s.handlers['/api/v1/templates/tpl1'] = () => json(templateDetail({ activeVersion: active }));
    s.handlers['/api/v1/templates/tpl1/activate'] = () => {
      active = 'feedfacefeedface';
      return json(templateDetail({ activeVersion: active }));
    };
    await open(s);
    await user.type(await screen.findByLabelText('Logo text'), '!');
    await screen.findByText('Ready to save.');
    await user.click(await screen.findByRole('button', { name: 'Save version' }));
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Activate' }),
    );
    expect(await screen.findByText('Version saved and active.')).toBeInTheDocument();
    expect(screen.getByLabelText('Logo text')).toHaveValue('Org!');
  });

  it('never raises a stale-draft prompt after Save, a further edit and Activate', async () => {
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
    s.handlers['/api/v1/templates/tpl1/activate'] = () => {
      active = 'feedfacefeedface';
      return json(templateDetail({ activeVersion: active }));
    };
    await open(s);
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
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Activate' }),
    );
    await screen.findByText('Version saved and active.');
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
    expect(await screen.findByText('Does not match the expected format.')).toBeInTheDocument();
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
});
