import { describe, expect, it } from 'vitest';
import { WB_TOOLS } from '@/shared/workbench.ts';
import {
  ContextsSchema,
  keepTool,
  nearestTool,
  pickContext,
  toContexts,
  type WbContext,
} from '../host/contexts.ts';
import type { WbSummary } from '../host/summary.ts';
import { firstDanger, navAttention, quickstartDone } from './attention.ts';
import { GO_KEYS, ownsKeys, resolveShellKey } from './keys.ts';
import { navGroups } from './nav-model.ts';
import { originFromSearch, originLabel } from './origin.ts';

const summary = (over: Partial<WbSummary> = {}): WbSummary => ({
  quickstart: null,
  errors: 0,
  failedDeliveries: 0,
  listening: false,
  inboxNew: 0,
  keysExpiring: 0,
  ...over,
});

const contexts = toContexts(
  ContextsSchema.parse({
    sandbox: { orgId: 'sbx', name: 'dev-4f8c' },
    orgs: [
      { orgId: 'nw', name: 'Northwind', slug: 'nw', tools: ['logs', 'events', 'sandbox', 'nope'] },
      { orgId: 'ac', name: 'Acme', slug: 'ac', tools: ['passes', 'keys'] },
    ],
  }),
);

describe('contexts', () => {
  it('pins the sandbox first with every area; an org keeps its allowed ones in nav order', () => {
    expect(contexts.map((c) => c.orgId)).toEqual(['sbx', 'nw', 'ac']);
    expect(contexts[0]?.tools).toEqual(WB_TOOLS);
    // Home always; sandbox-only areas and unknown names never.
    expect(contexts[1]?.tools).toEqual(['home', 'logs', 'events']);
  });

  it('enters the remembered context, else the sandbox, else the only one, else the chooser', () => {
    const [sbx, nw, ac] = contexts as [WbContext, WbContext, WbContext];
    expect(pickContext(contexts, 'ac')?.orgId).toBe('ac');
    expect(pickContext(contexts, 'gone')?.orgId).toBe('sbx');
    expect(pickContext([nw], undefined)?.orgId).toBe('nw');
    expect(pickContext([nw, ac], undefined)).toBeNull();
    expect(keepTool(nw, 'logs')).toBe('logs');
    expect(keepTool(nw, 'passes')).toBe('home');
    expect(keepTool(sbx, 'sandbox')).toBe('sandbox');
    expect(nearestTool('inbox', nw.tools)).toBe('events');
    expect(nearestTool('design', ['home'])).toBe('home');
  });
});

describe('the nav', () => {
  it('groups make, watch, set up, and drops what a context lacks without reordering', () => {
    const groups = navGroups(contexts[1]?.tools ?? [], false);
    expect(groups.map((g) => [g.id, g.items.map((i) => i.tool)])).toEqual([
      ['top', ['home']],
      ['watch', ['logs', 'events']],
    ]);
    const sandbox = navGroups(WB_TOOLS, false).flatMap((g) => g.items.map((i) => i.tool));
    expect(sandbox).toEqual(WB_TOOLS);
    // Quickstart done: it leaves the top for the foot.
    expect(navGroups(WB_TOOLS, true)[0]?.items.map((i) => i.tool)).toEqual(['home']);
  });

  it('shows attention, never totals, and names it', () => {
    expect(navAttention(summary(), 0)).toEqual({});
    const map = navAttention(
      summary({
        quickstart: { done: 4, total: 5 },
        errors: 3,
        listening: true,
        inboxNew: 2,
        keysExpiring: 1,
      }),
      1,
    );
    expect(map.logs).toEqual({ kind: 'danger', value: 3, label: '3 new errors' });
    expect(map.events).toEqual({ kind: 'live', label: 'Listening' });
    expect(map.inbox?.label).toBe('2 new');
    expect(map.activity?.label).toBe('1 running');
    expect(map.keys?.kind).toBe('warn');
    expect(map.quickstart?.label).toBe('4 of 5 done');
    // Failed deliveries outrank the live dot.
    expect(navAttention(summary({ failedDeliveries: 1, listening: true }), 0).events?.label).toBe(
      '1 failed delivery',
    );
    expect(quickstartDone(summary({ quickstart: { done: 5, total: 5 } }))).toBe(true);
  });

  it('points the area button at the first other area with danger', () => {
    const map = navAttention(summary({ errors: 2, failedDeliveries: 1 }), 0);
    expect(firstDanger(map, 'home')).toBe('logs');
    expect(firstDanger(map, 'logs')).toBe('events');
    expect(firstDanger(navAttention(summary({ inboxNew: 4 }), 0), 'home')).toBeNull();
  });
});

describe('shell keys', () => {
  const key = (k: string, over: Partial<Parameters<typeof resolveShellKey>[0]> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: document.body,
    ...over,
  });
  const on = { chord: false, singleKeys: true, layerOpen: false };

  it('g then a letter opens an area; w is Events too', () => {
    const g = resolveShellKey(key('g'), on);
    expect(g).toEqual({ action: { kind: 'chord' }, chord: true });
    expect(resolveShellKey(key('l'), { ...on, chord: true }).action).toEqual({
      kind: 'go',
      tool: 'logs',
    });
    expect(GO_KEYS.w).toBe('events');
    expect(resolveShellKey(key('x'), { ...on, chord: true })).toEqual({
      action: null,
      chord: false,
    });
    expect(resolveShellKey(key('?'), on).action).toEqual({ kind: 'help' });
  });

  it('the off-switch stops every single key; ⌘/ still opens the sheet', () => {
    const off = { ...on, singleKeys: false };
    expect(resolveShellKey(key('g'), off).action).toBeNull();
    expect(resolveShellKey(key('?'), off).action).toBeNull();
    expect(resolveShellKey(key('/', { metaKey: true }), off).action).toEqual({ kind: 'help' });
    expect(resolveShellKey(key('k', { ctrlKey: true }), off).action).toEqual({ kind: 'palette' });
  });

  it('never fires in a field, a menu, a dialog, a wizard or the designer canvas', () => {
    document.body.innerHTML = `<input id="f"><div role="menu"><button id="m"></button></div>
      <div data-wizard><button id="w"></button></div><div data-designer-canvas><span id="d"></span></div>`;
    for (const id of ['f', 'm', 'w', 'd']) {
      const target = document.getElementById(id);
      expect(ownsKeys(target), id).toBe(true);
      expect(resolveShellKey(key('g', { target }), on).action).toBeNull();
    }
    expect(resolveShellKey(key('g'), { ...on, layerOpen: true }).action).toBeNull();
    expect(resolveShellKey(key('g', { ctrlKey: true }), on).action).toBeNull();
  });
});

describe('the origin chip', () => {
  it('takes from and return only when both are valid', () => {
    expect(
      originFromSearch('?from=admin&return=%2Fadmin%2Fo%2Fnw%2Fconnections%2Fwebhooks%2Fep1'),
    ).toEqual({
      from: 'admin',
      return: '/admin/o/nw/connections/webhooks/ep1',
    });
    expect(originFromSearch('?from=admin&return=https%3A%2F%2Fevil.example')).toBeNull();
    expect(originFromSearch('?from=elsewhere&return=%2Fadmin%2F')).toBeNull();
    expect(originFromSearch('?return=%2Fadmin%2F')).toBeNull();
  });

  it('names the origin page', () => {
    expect(originLabel({ from: 'admin', return: '/admin/o/nw/connections/webhooks/ep1' })).toBe(
      'Webhook endpoint',
    );
    expect(originLabel({ from: 'admin', return: '/admin/o/nw/passes/p1?mode=test' })).toBe('Pass');
    expect(originLabel({ from: 'admin', return: '/admin/o/nw/members' })).toBe('Admin');
    expect(originLabel({ from: 'developers', return: '/developers/errors/PASS_NOT_FOUND' })).toBe(
      'Error',
    );
    expect(originLabel({ from: 'developers', return: '/developers' })).toBe('Docs');
  });
});
