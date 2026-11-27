import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests, setMode } from '../../../lib/mode.ts';
import { json, renderApp } from '../../../lib/test-utils.tsx';
import { CONNECTOR } from '../../passes/test-fixtures.ts';
import { returnTarget } from './outbound-flow.tsx';
import { type Calls, endpoint, hooks, manager } from './test-fixtures.ts';

const open = (path: string, calls: Calls[], handlers = hooks(calls)) =>
  renderApp(path, { session: 'admin', memberships: [manager], selectedOrg: 'org1', handlers });

afterEach(() => resetModeForTests());

describe('every way in lands in the wizard, on the outbound path', () => {
  it.each([
    '/admin/connections/webhooks/new',
    '/admin/o/org1/connections/webhooks/new',
    '/admin/connections/new?source=outbound',
    '/admin/o/org1/connections/new?source=outbound',
  ])('%s', async (path) => {
    await open(path, []);
    expect(await screen.findByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
    expect(screen.getByRole('group', { name: 'On your server' })).toBeVisible();
  });

  it('opens in Test, where endpoints live, with no picker to go back to', async () => {
    setMode('test');
    await open('/admin/o/org1/connections/webhooks/new', []);
    expect(await screen.findByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('is the Send events tile of the picker, and Back returns to it', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      '/admin/o/org1/connections/new',
      calls,
      hooks(calls, undefined, {
        '/api/v1/connectors': () =>
          json({
            items: [{ ...CONNECTOR, type: 'demo', displayName: 'Demo', category: 'try' }],
            nextCursor: null,
          }),
      }),
    );
    await user.click(await screen.findByRole('radio', { name: /Send to your server/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('radio', { name: /Send to your server/ })).toBeVisible();
  });
});

describe('resuming an endpoint that exists', () => {
  it.each([
    '/admin/connections/webhooks/we1/setup',
    '/admin/o/org1/connections/webhooks/we1/setup',
  ])('%s opens at Verify, with the first phase and the secret done', async (path) => {
    await open(path, []);
    expect(
      await screen.findByRole('heading', { name: 'Check the signature', level: 2 }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copy signing secret' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Set up your server', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New secret' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add endpoint' })).toBeNull();
  });
});

describe('an endpoint that was never tested', () => {
  it('says Not tested and links to Finish setup from the list and the page', async () => {
    const calls: Calls[] = [];
    const state = { endpoints: [endpoint({ lastSuccessAt: null, lastStatus: null })] };
    await open('/admin/connections?tab=webhooks', calls, hooks(calls, state));
    expect(await screen.findByText('Not tested')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Finish setup' })).toHaveAttribute(
      'href',
      expect.stringContaining('/webhooks/we1/setup'),
    );
  });

  it('leads the page with it', async () => {
    const calls: Calls[] = [];
    const state = { endpoints: [endpoint({ lastSuccessAt: null, lastStatus: null })] };
    await open('/admin/connections/webhooks/we1', calls, hooks(calls, state));
    expect(await screen.findByRole('link', { name: 'Finish setup' })).toBeVisible();
  });
});

describe('the way back', () => {
  it('goes only to the developer site', () => {
    expect(returnTarget('/developers/webhooks')).toBe('/developers/webhooks');
    expect(returnTarget('/workbench/o/sbx/events?tab=endpoints')).toBe(
      '/workbench/o/sbx/events?tab=endpoints',
    );
    expect(returnTarget('//evil.example/developers/')).toBeUndefined();
    expect(returnTarget('https://evil.example')).toBeUndefined();
    expect(returnTarget('/admin')).toBeUndefined();
  });
});

describe('one place to create an endpoint', () => {
  it('keeps the create call inside the wizard', () => {
    const root = join(process.cwd(), 'src/web/admin');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const text = readFileSync(path, 'utf8');
          if (/const \{[^}]*\bcreate\b[^}]*\} = useSecretCalls\(\)/.test(text))
            found.push(entry.name);
        }
      }
    };
    walk(root);
    expect(found).toEqual(['outbound-flow.tsx']);
  });
});
