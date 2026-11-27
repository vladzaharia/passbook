import { json } from '../../lib/test-utils.tsx';

export const CONTEXTS = {
  sandbox: { orgId: 'sbx', name: 'dev-4f8c673e' },
  orgs: [
    {
      orgId: 'nw',
      name: 'Northwind',
      slug: 'nw',
      tools: ['design', 'passes', 'console', 'logs', 'events', 'inbox', 'activity', 'keys'],
    },
  ],
};

export function handlers(summary: Record<string, unknown> = {}, contexts: unknown = CONTEXTS) {
  return {
    '/api/v1/workbench/contexts': () => json(contexts),
    '/api/v1/workbench/token': (_url: URL, init?: RequestInit) => {
      const { orgId } = JSON.parse(String(init?.body)) as { orgId: string };
      return json({
        token: `pbtry_${orgId}`,
        orgId,
        mode: 'test',
        expiresAt: Date.now() + 900_000,
        subject: 'member',
      });
    },
    '/api/v1/workbench/summary': () =>
      json({
        now: 1_700_000_000_000,
        quickstart: null,
        errors: 0,
        failedDeliveries: 0,
        listening: false,
        inboxNew: 0,
        keysExpiring: 0,
        ...summary,
      }),
    // The Console reads the docs' operation index (a static file, not an API call).
    '/developers/run/index.json': () => json({ codes: [], groups: [] }),
    '/api/v1/operations': () => json({ items: [] }),
    // Logs reads these on arrival: an org with no calls and no keys.
    '/api/v1/request-logs': () =>
      json({ items: [], nextCursor: null, capped: null, bodiesRecorded: true }),
    '/api/v1/api-keys': () => json({ items: [], nextCursor: null, revokedCount: 0 }),
  };
}
