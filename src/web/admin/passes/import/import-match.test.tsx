import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { body, open, setupImportDom } from './import-open-fixtures.ts';
import { checked, importDto, json } from './import-test-fixtures.ts';

setupImportDom();

const post = (posts: unknown[]) => (_u: URL, init?: RequestInit) => {
  posts.push(body(init));
  return json(checked());
};

describe('match columns', () => {
  it('matches by name, shows each field with its column, and posts the plan', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(importDto(), { '/api/v1/pass-imports/imp1/check': post(posts) });
    expect(await screen.findByRole('heading', { name: 'Match the columns' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Column for Member name/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Column for Holder email: Email/ })).toBeTruthy();
    expect(screen.getByText(/columns used/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Check/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      plan: {
        mapping: { name: { from: '/Name' }, level: { from: '/Level' } },
        holderEmail: { from: '/Email' },
        keepManual: false,
        save: true,
      },
    });
  });

  it('lists each distinct choice value with the option it becomes', async () => {
    await open(importDto());
    const map = await screen.findByRole('list', { name: 'Level values' });
    expect(within(map).getByText('blue')).toBeTruthy();
    expect(within(map).getByRole('combobox', { name: /Option for blue: Blue/ })).toBeTruthy();
  });

  it('refuses to find passes by an email column that was cleared', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(importDto(), { '/api/v1/pass-imports/imp1/check': post(posts) });
    await screen.findByRole('heading', { name: 'Match the columns' });
    await user.click(screen.getByRole('combobox', { name: /Existing passes/ }));
    await user.click(await screen.findByRole('option', { name: 'Update when email matches' }));
    await user.click(screen.getByRole('combobox', { name: /Column for Holder email/ }));
    await user.click(await screen.findByRole('option', { name: 'No column' }));
    await user.click(screen.getByRole('button', { name: /^Check/ }));
    expect(await screen.findByText('Map a Holder email column to match on it.')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('hides the keep-edited switch for Always create new', async () => {
    const user = userEvent.setup();
    await open(importDto());
    await screen.findByRole('heading', { name: 'Match the columns' });
    await user.click(screen.getByRole('combobox', { name: /Existing passes/ }));
    await user.click(await screen.findByRole('option', { name: 'Always create new' }));
    expect(screen.queryByText("Don't overwrite edits made in the console")).toBeNull();
  });

  it('shows the check failure', async () => {
    const user = userEvent.setup();
    await open(importDto(), {
      '/api/v1/pass-imports/imp1/check': () =>
        json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'IMPORT_STATE',
            detail: 'The import changed. Reload.',
          },
          409,
        ),
    });
    await user.click(await screen.findByRole('button', { name: /^Check/ }));
    expect(await screen.findByText('The import changed. Reload.')).toBeTruthy();
  });
});
