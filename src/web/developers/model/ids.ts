/**
 * The ids every example uses, and how a signed-in reader's own replace them. The key is never one of
 * them: it stays `$PASSBOOK_KEY` in every sample, personalized or not.
 */
export const EXAMPLE_IDS = {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  passId: '0193a1b2-7c00-7000-8000-0000000000c1',
  identityId: '0193a1b2-7c00-7000-8000-0000000000d1',
  otherId: '0193a1b2-7c00-7000-8000-0000000000e1',
} as const;

export type ExampleKind = keyof typeof EXAMPLE_IDS;

const BY_SEGMENT: Record<string, ExampleKind> = {
  orgs: 'orgId',
  templates: 'templateId',
  passes: 'passId',
  identities: 'identityId',
};

/** The blueprint the quickstart starts from. */
export const BLUEPRINT_ID = 'baked:starter-event-ticket';

/** The example value for `{name}` in `path`: ids by the segment before it, plain values for the rest. */
export function pathValue(path: string, name: string, type: string): string {
  if (/^(integer|number)/.test(type)) return '1';
  if (name === 'name') return 'icon.png';
  if (name === 'type') return 'event-ticket';
  if (name === 'recipe') return 'shopify-orders';
  if (name === 'provider') return 'google';
  if (path.endsWith('/{id}/use')) return BLUEPRINT_ID;
  const before = path.split(`{${name}}`)[0]?.split('/').filter(Boolean).pop() ?? '';
  return EXAMPLE_IDS[BY_SEGMENT[before] ?? 'otherId'];
}

/** What a reader's sandbox swaps in: their org and, once made, the quickstart template. */
export type Personal = Partial<Record<ExampleKind, string>>;

const SECRET = /\b(pb|wlt)_/;

/** `code` with the example ids replaced by the reader's. Refuses a value that looks like a key. */
export function personalize(code: string, ids: Personal): string {
  let out = code;
  for (const [kind, value] of Object.entries(ids) as [ExampleKind, string | undefined][]) {
    if (!value) continue;
    if (SECRET.test(value)) throw new Error('A key is never part of a snippet.');
    out = out.replaceAll(EXAMPLE_IDS[kind], value);
  }
  return out;
}
