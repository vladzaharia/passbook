import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests, setMode } from '../../../lib/mode.ts';
import { membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import { baseHandlers, finished, importDto, json, ORG } from './import-test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

function setup(over: Record<string, unknown> = {}, memberships = [membership]) {
  const posts: Record<string, unknown>[] = [];
  const handlers = {
    ...baseHandlers(),
    '/api/v1/pass-imports': (_u: URL, init?: RequestInit) => {
      if (method(init) === 'POST') {
        posts.push(JSON.parse(String(init?.body)));
        return json(importDto(), 201);
      }
      return json({ items: [], nextCursor: null });
    },
    '/api/v1/pass-imports/imp1': () => json(importDto()),
    ...over,
  };
  return {
    posts,
    render: () =>
      renderApp('/admin/passes/import', {
        session: 'admin',
        memberships,
        handlers,
        selectedOrg: ORG.id,
      }),
  };
}

afterEach(() => resetModeForTests());

describe('import page', () => {
  it('posts the template and the file, then opens the draft', async () => {
    const user = userEvent.setup();
    const t = setup();
    const { container, router } = await t.render();
    await screen.findByRole('button', { name: 'Next' });
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['Name,Id\nMaya,A1'], 'people.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.posts[0]).toEqual({
      templateId: 'tpl1',
      source: { kind: 'file', name: 'people.csv', csv: 'Name,Id\nMaya,A1' },
      mapping: 'auto',
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/admin\/o\/[^/]+\/passes\/import\/imp1$/),
    );
  });

  it('refuses a spreadsheet file with guidance and posts nothing', async () => {
    const user = userEvent.setup();
    const t = setup();
    const { container } = await t.render();
    await screen.findByRole('button', { name: 'Next' });
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'people.xlsx'));
    expect(await screen.findByText('Save the sheet as CSV first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    expect(t.posts).toHaveLength(0);
  });

  it('posts pasted rows and a sheet link', async () => {
    const user = userEvent.setup();
    const t = setup();
    await t.render();
    await user.click(await screen.findByRole('radio', { name: 'Paste' }));
    await user.type(screen.getByLabelText('Rows'), 'A,B');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.posts[0]).toMatchObject({ source: { kind: 'file', name: 'pasted.csv', csv: 'A,B' } });
  });

  it('refuses pasted text over 2 MB and a file that is not UTF-8', async () => {
    const user = userEvent.setup();
    const t = setup();
    const { container } = await t.render();
    await screen.findByRole('button', { name: 'Next' });
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([0x4e, 0xe9, 0x0a])], 'latin.csv'));
    expect(await screen.findByText('The file is not UTF-8. Save it as CSV UTF-8.')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Paste' }));
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: 'x'.repeat(2_000_001) } });
    expect(await screen.findByText('The file is larger than 2 MB.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('posts a sheet link as a url source', async () => {
    const user = userEvent.setup();
    const t = setup();
    await t.render();
    await user.click(await screen.findByRole('radio', { name: 'Sheet link' }));
    expect(screen.getByText(/Publish to web/)).toBeTruthy();
    await user.type(screen.getByLabelText('Link'), 'https://docs.google.com/x/pub?output=csv');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.posts[0]).toMatchObject({
      source: { kind: 'url', url: 'https://docs.google.com/x/pub?output=csv' },
    });
  });

  it('shows the server problem when the file is refused', async () => {
    const user = userEvent.setup();
    const t = setup({
      '/api/v1/pass-imports': (_u: URL, init?: RequestInit) =>
        method(init) === 'POST'
          ? json(
              {
                type: 'about:blank',
                title: 'Unprocessable',
                status: 422,
                code: 'IMPORT_TOO_MANY_ROWS',
                detail: 'The file has more than 2,000 rows.',
              },
              422,
            )
          : json({ items: [], nextCursor: null }),
    });
    await t.render();
    await user.click(await screen.findByRole('radio', { name: 'Paste' }));
    await user.type(screen.getByLabelText('Rows'), 'A');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('The file has more than 2,000 rows.')).toBeTruthy();
  });

  it('says so when no template has a release', async () => {
    const t = setup({
      '/api/v1/templates/eligible': () => json({ items: [], nextCursor: null }),
    });
    await t.render();
    expect(await screen.findByText('No released templates in this mode.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('notes Test mode', async () => {
    setMode('test');
    const t = setup();
    await t.render();
    expect(await screen.findByText(/Test mode: passes are made as test passes/)).toBeTruthy();
  });

  it('lists the recent imports as links, and an empty state when there are none', async () => {
    const t = setup({
      '/api/v1/pass-imports': () =>
        json({
          items: [finished({ id: 'imp7', source: { kind: 'file', name: 'march.csv' } })],
          nextCursor: null,
        }),
    });
    await t.render();
    const link = await screen.findByRole('link', { name: 'march.csv' });
    expect(link.getAttribute('href')).toContain('/admin/passes/import/imp7');
    const row = link.closest('li') as HTMLElement;
    expect(within(row).getByText('Done')).toBeTruthy();
  });

  it('shows the empty recent list', async () => {
    const t = setup();
    await t.render();
    expect(await screen.findByText('No imports yet')).toBeTruthy();
  });

  it('refuses a member without the operate capability', async () => {
    const t = setup({}, [membershipFixture(ORG.id, { capabilities: ['passes:read'] })]);
    await t.render();
    expect(await screen.findByText(/operator or admin role/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });
});
