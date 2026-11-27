import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '../../../lib/mode.ts';
import { json, renderApp } from '../../../lib/test-utils.tsx';
import { CONNECTOR } from '../../passes/test-fixtures.ts';
import { comeBack, returnTarget } from './outbound-return.ts';
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

describe('a sandbox at its endpoint quota', () => {
  it('says so on the Where step and holds Next with the reason', async () => {
    const calls: Calls[] = [];
    await renderApp('/admin/o/org1/connections/new?source=outbound', {
      session: 'admin',
      memberships: [{ ...manager, testOnly: true }],
      selectedOrg: 'org1',
      handlers: hooks(calls, undefined, {
        '/api/v1/workbench/summary': () =>
          json({
            now: Date.now(),
            quickstart: null,
            errors: 0,
            failedDeliveries: 0,
            listening: false,
            inboxNew: 0,
            keysExpiring: 0,
            quotas: {
              passes: { used: 0, limit: null },
              templates: { used: 0, limit: null },
              endpoints: { used: 3, limit: 3 },
              keys: { used: 0, limit: null },
            },
          }),
      }),
    });
    expect(await screen.findByText('3 of 3 endpoints. Delete one to add another.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Endpoint limit reached.')).toBeVisible();
  });
});

describe('the way back', () => {
  it('lands on the Workbench by hash and on the docs by ?endpoint=', () => {
    expect(comeBack('/workbench/o/sbx/events?tab=endpoints', 'we1')).toBe(
      '/workbench/o/sbx/events?tab=endpoints#we1',
    );
    expect(comeBack('/developers/webhooks', 'we1')).toBe('/developers/webhooks?endpoint=we1');
  });

  it('finishes the wizard by returning to the Workbench with the new endpoint selected', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const back = encodeURIComponent('/workbench/o/org1/events?tab=endpoints');
    await open(`/admin/o/org1/connections/new?source=outbound&return=${back}`, []);
    await user.type(
      await screen.findByRole('textbox', { name: /URL/ }),
      'https://hooks.example.com/x',
    );
    const next = () => user.click(screen.getByRole('button', { name: 'Next' }));
    await next();
    await next();
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    await user.click(await screen.findByRole('checkbox', { name: 'I saved the secret' }));
    await next();
    await next();
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Done' })).not.toHaveAttribute('aria-disabled'),
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(await screen.findByRole('button', { name: 'Open endpoint' }));
    expect(assign).toHaveBeenCalledWith('/workbench/o/org1/events?tab=endpoints#we-new');
    vi.unstubAllGlobals();
  });

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
