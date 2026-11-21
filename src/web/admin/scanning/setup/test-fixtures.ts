import { vi } from 'vitest';
import { json, membershipFixture, type RenderAppOptions } from '@/web/lib/test-utils.tsx';

const eligible = (templateId: string, name: string) => ({
  templateId,
  name,
  templateOrgId: 'o1',
  origin: 'uploaded',
  releaseId: `r-${templateId}`,
  releaseGeneration: 1,
  version: '1',
  candidateHash: 'h',
  supportsCheckIn: true,
  rule: null,
});
const empty = () => json({ items: [], nextCursor: null });

export const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });

/** The admin APIs the wizard loads its facts from. */
export const factHandlers: NonNullable<RenderAppOptions['handlers']> = {
  '/api/v1/templates/eligible': () =>
    json({
      items: [eligible('t1', 'Monthly'), eligible('t2', 'Day pass')],
      nextCursor: null,
    }),
  '/api/v1/scan-zones': empty,
  '/api/v1/scan-events': empty,
  '/api/v1/scan-staff': empty,
  '/api/v1/scanning-sessions': empty,
  '/api/v1/scan-setups': empty,
};

export const appOptions = {
  session: 'admin' as const,
  memberships: [northwind],
  selectedOrg: 'o1',
};

/** The wizard stage (the summary aside) only shows from 1024 up. */
export function stubDesktop(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      query.includes('min-width: 1024px') || query.includes('prefers-reduced-motion: reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

export const pairing = (code: string, expiresAt = Date.now() + 600_000) => ({
  code,
  url: `https://example.test/scan#pair=${code}`,
  expiresAt,
});

/** What apply answers: one door, two devices, two people with PINs. */
export const appliedResult = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  mode: 'live',
  sessions: [
    {
      id: 's-new',
      ref: 'door-1',
      name: 'Front desk',
      devices: [
        { id: 'dev-1', name: 'Front desk 1', pairing: pairing('ABCDEFGHJK') },
        { id: 'dev-2', name: 'Front desk 2', pairing: pairing('KLMNPQRSTU') },
      ],
    },
  ],
  zones: [],
  events: [],
  staff: [
    { id: 'st-1', name: 'Sam Ortiz', role: 'manager', pin: '482913' },
    { id: 'st-2', name: 'Priya Nair', role: 'door', pin: '730561' },
  ],
  checks: [],
  ...over,
});
