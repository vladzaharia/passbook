import { describe, expect, it } from 'vitest';
import { operatorSpaceOf } from './spaces.ts';
import {
  isWorkbenchPath,
  safeReturn,
  WB_TOOLS,
  wbHref,
  wbOrgOf,
  wbPath,
  wbToolOf,
} from './workbench.ts';

describe('wbPath', () => {
  it('puts the org in the path, filters in the query and the selection in the hash', () => {
    expect(wbPath('org_1', 'home')).toBe('/workbench/o/org_1');
    expect(
      wbPath('org_1', 'logs', { query: { status: '4xx', code: undefined }, hash: 'req_9' }),
    ).toBe('/workbench/o/org_1/logs?status=4xx#req_9');
    // Quickstart is the sandbox's own page, outside any context path.
    expect(wbPath('sbx', 'quickstart')).toBe('/workbench/quickstart');
  });

  it('L19: refuses to put a request body in a URL', () => {
    expect(() => wbPath('org_1', 'console', { query: { op: 'createPass', body: '{}' } })).toThrow(
      /never carries a body/,
    );
    expect(() => wbPath('org_1', 'console', { query: { Body: 'x' } })).toThrow();
    expect(wbPath('org_1', 'console', { query: { op: 'createPass', prefill: 'n1' } })).toBe(
      '/workbench/o/org_1/console?op=createPass&prefill=n1',
    );
  });

  it('wbHref names the area without a context and refuses a body the same way', () => {
    expect(wbHref('home')).toBe('/workbench');
    expect(wbHref('console', { query: { op: 'createPass', sample: 'create-pass' } })).toBe(
      '/workbench/console?op=createPass&sample=create-pass',
    );
    expect(wbHref('logs', { query: { code: 'NOT_FOUND' } })).toBe('/workbench/logs?code=NOT_FOUND');
    expect(() => wbHref('console', { query: { body: '{}' } })).toThrow(/never carries a body/);
  });

  it('lists the eleven areas in nav order', () => {
    expect(WB_TOOLS).toHaveLength(11);
    expect(WB_TOOLS[0]).toBe('home');
  });
});

describe('Workbench paths', () => {
  it('reads the area and org a path shows', () => {
    expect(wbToolOf('/workbench/o/org_1')).toBe('home');
    expect(wbToolOf('/workbench/o/org_1/events')).toBe('events');
    expect(wbToolOf('/workbench/quickstart')).toBe('quickstart');
    expect(wbToolOf('/workbench')).toBeNull();
    expect(wbToolOf('/admin/o/org_1/passes')).toBeNull();
    expect(wbOrgOf('/workbench/o/org%201/logs')).toBe('org 1');
    expect(wbOrgOf('/workbench/o/%E0%A4%A/logs')).toBeNull();
    expect(wbOrgOf('/workbench/logs')).toBeNull();
    expect(isWorkbenchPath('/workbench')).toBe(true);
    expect(isWorkbenchPath('/workbenches')).toBe(false);
    expect(operatorSpaceOf('/workbench/o/x/logs?y=1')).toBe('workbench');
  });

  it('takes a launch link return only from admin, the docs or the Workbench', () => {
    expect(safeReturn('/admin/o/org_1/passes/p1?mode=test')).toBe(
      '/admin/o/org_1/passes/p1?mode=test',
    );
    expect(safeReturn('/developers/errors/PASS_NOT_FOUND')).toBe(
      '/developers/errors/PASS_NOT_FOUND',
    );
    expect(safeReturn('/developers')).toBe('/developers');
    expect(safeReturn('/account')).toBeNull();
    expect(safeReturn('https://evil.example/admin/')).toBeNull();
    expect(safeReturn('//evil.example/admin/')).toBeNull();
    expect(safeReturn('/admin/../account')).toBeNull();
    expect(safeReturn(null)).toBeNull();
  });
});
