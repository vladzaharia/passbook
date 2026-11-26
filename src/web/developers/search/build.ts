import { gzipSync } from 'node:zlib';
import { DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { opPath, pagePath } from '../model/markdown.ts';
import type { Site } from '../model/types.ts';
import type { ActionDoc, GuideDoc, HintDoc, SearchIndex } from './types.ts';

/** The index is fetched on the first ⌘K; this is what it may weigh on the wire. */
export const INDEX_BUDGET_GZIP = 150_000;

const DESC_MAX = 220;
const API = /^\/api\/v1/;

/** The first sentence or two, short enough to preview. */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DESC_MAX) return flat;
  const cut = flat.slice(0, DESC_MAX);
  const stop = cut.lastIndexOf('. ');
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

const actions = (): ActionDoc[] => [
  {
    id: 'playground',
    label: 'Open the playground',
    line: 'Edit a pass, watch every wallet change',
    sandbox: false,
    words: 'edit preview pass wallet apple google',
    href: PATHS.playground,
  },
  {
    id: 'builder',
    label: 'Open the API builder',
    line: 'Run any operation against your sandbox',
    sandbox: true,
    words: 'console try run request send',
    href: PATHS.console,
  },
  {
    id: 'logs',
    label: 'Open the request log',
    line: 'Your sandbox key’s calls',
    sandbox: true,
    words: 'requests history debug',
    href: PATHS.logs,
  },
  {
    id: 'test-webhook',
    label: 'Send a test webhook',
    line: 'Capture a signed delivery',
    sandbox: true,
    words: 'event capture tester endpoint signature',
    href: PATHS.webhooks,
  },
  {
    id: 'test-key',
    label: 'Create a test key',
    line: 'A sandbox and its key',
    sandbox: true,
    words: 'sandbox api secret token start',
    href: PATHS.quickstart,
  },
  {
    id: 'roll-key',
    label: 'Roll a key',
    line: 'Replace a key that was shared',
    sandbox: true,
    words: 'rotate secret leaked revoke token',
    href: '/admin/api-keys',
  },
];

const PAGES: readonly { id: string; title: string; line: string; href: string }[] = [
  {
    id: 'quickstart',
    title: 'Quickstart',
    line: 'Sandbox, first request, your pass live',
    href: PATHS.quickstart,
  },
  {
    id: 'reference',
    title: 'API reference',
    line: 'Every operation, one page per resource',
    href: PATHS.reference,
  },
  {
    id: 'playground',
    title: 'Playground',
    line: 'Edit a pass and watch the wallets change',
    href: PATHS.playground,
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    line: 'Events, signatures, the tester',
    href: PATHS.webhooks,
  },
  { id: 'logs', title: 'Request log', line: 'Your sandbox key’s calls', href: PATHS.logs },
  { id: 'errors', title: 'Errors', line: 'Every code and its fix', href: PATHS.errors },
  { id: 'changelog', title: 'Changelog', line: 'What changed, by date', href: PATHS.changelog },
  { id: 'status', title: 'Status', line: 'Components and incidents', href: PATHS.status },
  {
    id: 'protocols',
    title: 'Protocols',
    line: 'Apple, scanner and public routes',
    href: PATHS.protocols,
  },
];

/** Answers for words that find nothing. Each link names an SDK call or a guide and is dropped if it does not resolve. */
const HINTS: readonly { terms: string[]; text: string; links: { label: string; to: string }[] }[] =
  [
    {
      terms: ['refund', 'refunds', 'chargeback', 'payment'],
      text: 'Passes are voided or removed, not refunded.',
      links: [
        { label: 'Void a pass', to: 'pb.passes.void' },
        { label: 'Remove a pass', to: 'pb.passes.remove' },
        { label: 'Pass lifecycle', to: 'guide:pass-lifecycle' },
      ],
    },
  ];

export function buildSearchIndex(site: Site): SearchIndex {
  const ops = site.pages.flatMap((page) =>
    page.ops.map((o) => ({
      id: o.operationId,
      method: o.method.toUpperCase(),
      path: o.path.replace(API, '') || '/',
      title: o.title,
      sdk: o.sdkCall,
      desc: brief(o.description),
      idempotent: o.idempotent,
      scopes: o.scopes,
      href: opPath(page, o),
    })),
  );
  const guides: GuideDoc[] = [
    ...DEV_GUIDES.map((g) => ({
      id: g.id,
      title: g.title,
      line: g.line,
      kind: 'guide' as const,
      href: `${PATHS.guides}#${g.id}`,
    })),
    ...PAGES.map((p) => ({ ...p, kind: 'page' as const })),
    ...site.pages.map((p) => ({
      id: `ref:${p.slug}`,
      title: p.label,
      line: `${p.ops.length} operations`,
      kind: 'reference' as const,
      href: pagePath(p),
    })),
  ];
  const hints: HintDoc[] = HINTS.map((h) => ({
    terms: h.terms,
    text: h.text,
    links: h.links.flatMap(({ label, to }) => {
      const href =
        ops.find((o) => o.sdk === to)?.href ?? guides.find((g) => `guide:${g.id}` === to)?.href;
      return href ? [{ label, href }] : [];
    }),
  }));
  return {
    v: 1,
    errors: site.errors.map((e) => ({
      code: e.code,
      status: e.status,
      title: e.title,
      when: brief(e.when),
      fix: brief(e.fix),
      retryable: e.retryable,
      href: `${PATHS.errors}/${e.code}`,
    })),
    ops,
    guides,
    events: site.webhookEvents.map((e) => ({
      type: e.type,
      summary: e.summary,
      href: `${PATHS.webhooks}?type=${e.type}`,
    })),
    actions: actions(),
    hints,
    secretHelp: ['ref:api-keys', 'roll-key'],
  };
}

/** The index as a file, and its size on the wire; the build fails when it outgrows its budget. */
export function searchIndexFile(site: Site): { file: string; body: string; gzip: number } {
  const body = JSON.stringify(buildSearchIndex(site));
  const gzip = gzipSync(body).length;
  if (gzip > INDEX_BUDGET_GZIP)
    throw new Error(`search index is ${gzip} bytes gzip; the budget is ${INDEX_BUDGET_GZIP}`);
  return { file: PATHS.searchIndex, body, gzip };
}
