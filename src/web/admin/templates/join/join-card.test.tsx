import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { JoinReadinessIssue } from '@/shared/contracts/join.ts';
import { JOIN_COPY } from '@/shared/copy/join.ts';
import { setCsrfProvider } from '../../../lib/api.ts';
import { json, problem, stubFetch } from '../../../lib/test-utils.tsx';
import { setBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import { JoinCard, type JoinCardProps } from './join-card.tsx';
import { link, mount, stateOf, URL_OK } from './join-test-fixtures.tsx';

const PATH = '/api/v1/join-links/tpl-1';
const PROPS: JoinCardProps = {
  templateId: 'tpl-1',
  orgId: undefined,
  scopeOrgId: 'org-1',
  mode: 'live',
  canOperate: true,
  canPublish: true,
};

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  query: string;
}
/** A one-link server: PUT replaces fields on the stored link, rotate changes its url. */
function server(initial: ReturnType<typeof stateOf>, seen: Seen[] = []) {
  let state = initial;
  const handler = (url: URL, init?: RequestInit) => {
    const m = (init?.method ?? 'GET').toUpperCase();
    seen.push({
      method: m,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      query: url.search,
    });
    if (m === 'PUT') {
      const body = JSON.parse(String(init?.body));
      const { revision, ...rest } = body as { revision: number } & Record<string, unknown>;
      state = stateOf({
        ...(state.link ?? link({ enabled: false })),
        ...rest,
        revision: revision + 1,
      });
    }
    if (m === 'POST')
      state = stateOf(
        state.link ? { ...state.link, url: `${URL_OK}x`, revision: state.link.revision + 1 } : null,
      );
    return json(state);
  };
  stubFetch({ [PATH]: handler, [`${PATH}/rotate`]: handler });
  return seen;
}

beforeEach(() => {
  setCsrfProvider(async () => 'csrf');
  setBarcodeEngine(() => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfProvider(async () => undefined);
});

const card = async (over: Partial<JoinCardProps> = {}) => {
  const view = mount(<JoinCard {...PROPS} {...over} />);
  await screen.findByText(JOIN_COPY.card.open);
  return view;
};
const open = () => screen.getByRole('switch', { name: JOIN_COPY.card.open });

describe('join card: readiness', () => {
  const lines: [JoinReadinessIssue, RegExp][] = [
    [{ code: 'no_release' }, /Release this template in Live to turn on the join link\./],
    [{ code: 'barcode_input', label: 'Member id' }, /Needs a generated barcode\./],
    [{ code: 'input_needed', label: 'Plan' }, /Plan has no default\./],
    [{ code: 'archived' }, /This template is archived\./],
  ];
  for (const [issue, line] of lines) {
    it(`says ${issue.code} and keeps the switch off`, async () => {
      server(stateOf(null, { ready: false, issues: [issue] }));
      await card();
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(open()).toBeDisabled();
      if (issue.code === 'no_release')
        expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute(
          'href',
          expect.stringContaining('tab=versions'),
        );
      else if (issue.code !== 'archived')
        expect(screen.getByRole('link', { name: 'Design' })).toHaveAttribute(
          'href',
          expect.stringContaining('/design'),
        );
      else expect(screen.queryByRole('link', { name: /Design|Releases/ })).toBeNull();
    });
  }

  it('shows only the one line when the barcode cannot work, no fields', async () => {
    server(
      stateOf(null, { ready: false, issues: [{ code: 'barcode_input', label: 'Member id' }] }),
    );
    await card();
    expect(open()).toBeDisabled();
    expect(screen.queryByText(JOIN_COPY.card.askFor)).toBeNull();
    expect(screen.queryByLabelText(JOIN_COPY.card.dailyLimit)).toBeNull();
    expect(screen.queryByRole('switch', { name: JOIN_COPY.card.email })).toBeNull();
  });

  it('hides what it asks and the limit while off', async () => {
    server(stateOf(null, { ready: true, issues: [] }));
    await card();
    expect(open()).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: JOIN_COPY.card.email })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: JOIN_COPY.card.dailyLimit })).toBeNull();
  });

  it('says Test in a test-mode line', async () => {
    server(stateOf(null, { ready: false, issues: [{ code: 'no_release' }] }));
    await card({ mode: 'test' });
    expect(screen.getByText(/Release this template in Test/)).toBeInTheDocument();
  });
});

describe('join card: a link', () => {
  it('shows the link, its QR and the three actions', async () => {
    server(stateOf(link()));
    await card();
    expect(screen.getByText(URL_OK)).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: `QR code for ${URL_OK}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: JOIN_COPY.card.copy })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: JOIN_COPY.card.print })).toHaveAttribute(
      'href',
      expect.stringContaining('/join-sign'),
    );
    expect(screen.getByRole('button', { name: JOIN_COPY.card.rotate })).toBeEnabled();
    expect(screen.getByText('12 today')).toBeInTheDocument();
    expect(screen.getByDisplayValue('200')).toBeInTheDocument();
    expect(screen.queryByText(JOIN_COPY.card.limitReached)).toBeNull();
  });

  it('marks a spent day', async () => {
    server(stateOf(link({ issuedToday: 200, limitReached: true })));
    await card();
    expect(screen.getByText(JOIN_COPY.card.limitReached)).toBeInTheDocument();
  });

  it('copies the link', async () => {
    server(stateOf(link()));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await card();
    await userEvent.click(screen.getByRole('button', { name: JOIN_COPY.card.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_OK));
  });

  it('lets a name input be chosen only when several qualify', async () => {
    server(
      stateOf(
        link({
          nameInputs: [
            { key: 'a', label: 'First' },
            { key: 'b', label: 'Nick' },
          ],
          nameInput: 'a',
        }),
      ),
    );
    await card();
    expect(screen.getByRole('combobox', { name: /Name: Saved in First/ })).toBeInTheDocument();
  });
});

describe('join card: writes', () => {
  it('turns on by creating at revision 0, then shows the link', async () => {
    const seen = server(stateOf(null, { ready: true, issues: [] }));
    await card();
    await userEvent.click(open());
    await waitFor(() =>
      expect(seen.at(-1)).toMatchObject({ method: 'PUT', body: { enabled: true, revision: 0 } }),
    );
    expect(await screen.findByText(URL_OK)).toBeInTheDocument();
  });

  it('turns off at the link revision', async () => {
    const seen = server(stateOf(link()));
    await card();
    await userEvent.click(open());
    await waitFor(() => expect(seen.at(-1)?.body).toEqual({ enabled: false, revision: 3 }));
  });

  it('sends Email and the limit with the revision; a raised limit needs publish', async () => {
    const seen = server(stateOf(link()));
    await card();
    await userEvent.click(screen.getByRole('switch', { name: JOIN_COPY.card.email }));
    await waitFor(() => expect(seen.at(-1)?.body).toEqual({ askEmail: true, revision: 3 }));
    const field = screen.getByLabelText(JOIN_COPY.card.dailyLimit);
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.clear(field);
    await userEvent.type(field, '50{Enter}');
    await waitFor(() => expect(seen.at(-1)?.body).toEqual({ dailyLimit: 50, revision: 4 }));
  });

  it('a stale revision is the changed line, and the card reloads', async () => {
    let gets = 0;
    stubFetch({
      [PATH]: (_url, init) => {
        if ((init?.method ?? 'GET') === 'PUT') return problem(409, 'JOIN_LINK_CHANGED', 'changed');
        gets += 1;
        return json(stateOf(link()));
      },
    });
    await card();
    await userEvent.click(open());
    await waitFor(() => expect(gets).toBeGreaterThan(1));
  });

  it('confirms before making a new link, then shows the new one', async () => {
    const seen = server(stateOf(link()));
    await card();
    await userEvent.click(screen.getByRole('button', { name: JOIN_COPY.card.rotate }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(JOIN_COPY.rotateConfirm.title)).toBeInTheDocument();
    expect(within(dialog).getByText(JOIN_COPY.rotateConfirm.body)).toBeInTheDocument();
    expect(seen.some((s) => s.path.endsWith('/rotate'))).toBe(false);
    await userEvent.click(
      within(dialog).getByRole('button', { name: JOIN_COPY.rotateConfirm.confirm }),
    );
    await waitFor(() =>
      expect(seen.some((s) => s.method === 'POST' && s.path.endsWith('/rotate'))).toBe(true),
    );
    expect(await screen.findByText(`${URL_OK}x`)).toBeInTheDocument();
  });

  it('passes the org for a platform template', async () => {
    const seen = server(stateOf(link()));
    await card({ orgId: 'org-9' });
    expect(seen[0]?.query).toBe('?orgId=org-9');
  });
});

describe('join card: capabilities', () => {
  it('without passes:operate is state only: no switch to flip, no link', async () => {
    server(stateOf(link({ url: null })));
    await card({ canOperate: false, canPublish: false });
    expect(open()).toBeDisabled();
    expect(open()).toBeChecked();
    expect(screen.queryByRole('button', { name: JOIN_COPY.card.copy })).toBeNull();
    expect(screen.queryByRole('button', { name: JOIN_COPY.card.rotate })).toBeNull();
  });

  it('with operate only: turns off, but Email, a new link and a turn-on need an org admin', async () => {
    const seen = server(stateOf(link()));
    await card({ canPublish: false });
    expect(screen.getByRole('switch', { name: JOIN_COPY.card.email })).toBeDisabled();
    expect(screen.getByRole('button', { name: JOIN_COPY.card.rotate })).toBeDisabled();
    expect(screen.getAllByText(JOIN_COPY.card.askAdmin).length).toBeGreaterThan(0);
    expect(open()).toBeEnabled();
    await userEvent.click(open());
    await waitFor(() => expect(seen.at(-1)?.body).toEqual({ enabled: false, revision: 3 }));
    expect(
      await screen.findByText(JOIN_COPY.card.askAdmin, { selector: 'p.-mt-2' }),
    ).toBeInTheDocument();
    expect(open()).toBeDisabled();
  });

  it('shows nothing for a template the viewer cannot read links for', async () => {
    const fetched = stubFetch({ [PATH]: () => problem(404, 'not_found', 'Not found.') });
    mount(<JoinCard {...PROPS} />);
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(JOIN_COPY.card.title)).toBeNull());
  });
});

describe('join card: axe', () => {
  const widths = [1440, 820, 390];
  for (const theme of ['light', 'dark'] as const) {
    for (const width of widths) {
      it(`has no violations at ${width} in ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        server(
          stateOf(
            link({
              issuedToday: 200,
              limitReached: true,
              generated: [{ key: 'n', label: 'Card number' }],
            }),
          ),
        );
        const view = await card({ mode: 'test' });
        await screen.findByRole('img', { name: /QR code for/ });
        expect((await axe(view.container)).violations).toEqual([]);
        delete document.documentElement.dataset.theme;
      });
    }
  }
  it('has no violations when not ready', async () => {
    server(
      stateOf(null, {
        ready: false,
        issues: [{ code: 'barcode_input', label: 'Member id' }, { code: 'archived' }],
      }),
    );
    const view = await card();
    expect((await axe(view.container)).violations).toEqual([]);
  });
});
