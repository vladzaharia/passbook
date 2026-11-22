import { afterEach, beforeEach, vi } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import { baseHandlers, json, ORG } from './import-test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
export const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
export const body = (init?: RequestInit) => JSON.parse(String(init?.body));

export type Handler = (u: URL, init?: RequestInit) => Response;

/** Opens /admin/passes/import/imp1 with `imp` served until a handler changes it. */
export async function open(
  imp: Record<string, unknown>,
  extra: Record<string, Handler> = {},
  caps?: string[],
) {
  return renderApp('/admin/passes/import/imp1', {
    session: 'admin',
    memberships: [caps ? membershipFixture(ORG.id, { capabilities: caps as never }) : membership],
    selectedOrg: ORG.id,
    handlers: { ...baseHandlers(), '/api/v1/pass-imports/imp1': () => json(imp), ...extra },
  });
}

/** Downloads and object URLs are inert in jsdom; restores everything after each test. */
export function setupImportDom() {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetModeForTests();
  });
}
