import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { leafOf, type Mapping, type MappingRow, toRows } from '../mapping/mapping.ts';
import type { Lifecycle } from './lifecycle-fields.tsx';
import type { ConfigDraft } from './wizard-steps.tsx';

/**
 * Import to connection: "Keep this sheet in sync" opens the connection wizard with what the import
 * learned. A publish-to-web link is a secret, so it never travels in the address: the page that
 * started the import keeps it in this tab's session storage, and the wizard takes it once.
 */
const LINK = (importId: string) => `wallet-import-link:${importId}`;
const HANDOFF = 'wallet-import-handoff';

export interface ConnectionPrefill {
  templateId: string;
  /** Template inputs the import joined from several columns; a connection reads one field each. */
  joined?: string[];
  /** Empty when this tab did not start the import: the wizard asks for the link. */
  url: string;
  idColumn: string;
  holderEmailField: string;
  mapping: Mapping;
}

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Kept for the tab only, under the import's id. */
export function rememberImportLink(importId: string, url: string): void {
  store()?.setItem(LINK(importId), url);
}

type PlanMapping = NonNullable<PassImportDto['plan']>['mapping'];

/**
 * What a connection can carry of an import's mapping. A connection reads one upstream field per
 * input, so a `join` entry stays out and its input is named in `joined` for the admin to map.
 */
export function connectionMappingOf(plan: PlanMapping): { mapping: Mapping; joined: string[] } {
  const mapping: Mapping = {};
  const joined: string[] = [];
  for (const [input, entry] of Object.entries(plan)) {
    const t = entry.transform;
    if (t?.kind === 'join') joined.push(input);
    else if (t) mapping[input] = { from: entry.from, transform: { ...t, kind: t.kind } };
    else mapping[input] = { from: entry.from };
  }
  return { mapping, joined };
}

/** Leaves the prefill for the wizard that opens next. */
export function handOffToConnection(imp: PassImportDto): void {
  const plan = imp.plan;
  if (!plan) return;
  const { mapping, joined } = connectionMappingOf(plan.mapping);
  const prefill: ConnectionPrefill = {
    templateId: imp.templateId,
    url: store()?.getItem(LINK(imp.id)) ?? '',
    idColumn: plan.externalId ? leafOf(plan.externalId.from) : '',
    holderEmailField: plan.holderEmail?.from ?? '',
    mapping,
    ...(joined.length ? { joined } : {}),
  };
  store()?.setItem(HANDOFF, JSON.stringify(prefill));
  // The link now travels in the handoff only, which the wizard clears on reading.
  store()?.removeItem(LINK(imp.id));
}

/** Read once: a later visit to the wizard starts empty. */
export function takeConnectionPrefill(): ConnectionPrefill | null {
  const s = store();
  const raw = s?.getItem(HANDOFF);
  if (!s || !raw) return null;
  s.removeItem(HANDOFF);
  try {
    return JSON.parse(raw) as ConnectionPrefill;
  } catch {
    return null;
  }
}

/** The wizard's first state: empty, or the sheet connector at its configuration step. */
export function wizardStart(
  prefill: ConnectionPrefill | null,
  life: Lifecycle,
): {
  step: number;
  type: string | undefined;
  draft: ConfigDraft;
  rows: MappingRow[];
  life: Lifecycle;
} {
  if (!prefill)
    return {
      step: 0,
      type: undefined,
      draft: { name: '', config: {}, secrets: {} },
      rows: [],
      life,
    };
  return {
    step: 1,
    type: 'csv-url',
    draft: {
      name: 'Sheet sync',
      config: { url: prefill.url, idColumn: prefill.idColumn },
      secrets: {},
    },
    rows: toRows(prefill.mapping),
    life: {
      ...life,
      defaultTemplateId: prefill.templateId,
      holderEmailField: prefill.holderEmailField,
      autoCreate: true,
    },
  };
}
