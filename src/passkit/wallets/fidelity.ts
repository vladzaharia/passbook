/**
 * The fidelity report engine (architecture 4.2). Compilers list what they did not carry natively;
 * this turns the lists of every sample into one report: severities, author choices, `required`
 * blocks, a status, and a canonical order so the same input always gives the same report and hash.
 */
import type { WalletsManifest } from '../template/wallets/schema.ts';
import type {
  FidelityItem,
  FidelityReport,
  ItemGroup,
  ItemSeverity,
  ReportItem,
  ReportStatus,
  WalletCompiler,
  WalletPassView,
  WalletTarget,
} from './types.ts';

/** Bump with any change to how reports are built (severity, status, order). It joins the release pipeline pin. */
export const FIDELITY_REVISION = 2;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A required id covers itself and everything under it: `barcode.format` covers `barcode.format.pdf417`. */
const covers = (required: string, capability: string): boolean =>
  capability === required || capability.startsWith(`${required}.`);

/** `<target>.omit` names a field by path, by bare key, or a capability id. */
const isChosen = (omit: readonly string[], item: FidelityItem): boolean =>
  omit.some(
    (entry) => entry === item.capability || entry === item.path || item.path.endsWith(`.${entry}`),
  );

const DOOR = ['barcode.', 'image.personal', 'sharing', 'nfc'];
const LOOK = ['type', 'colors.', 'localization.images', 'text.length'];
const startsWithAny = (capability: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => (p.endsWith('.') ? capability.startsWith(p) : capability === p));

/** Who notices the loss (architecture 4.2). A feature the wallet lacks is `absent`, except NFC: staff at the door lose it. */
export function groupOf(item: Pick<FidelityItem, 'capability' | 'support'>): ItemGroup {
  if (item.capability === 'nfc') return 'door';
  if (item.support === 'unsupported') return 'absent';
  if (startsWithAny(item.capability, DOOR)) return 'door';
  if (item.support === 'difference' || startsWithAny(item.capability, LOOK)) return 'look';
  return 'holder';
}

/** Only losses a customer or the door would notice are approved. */
const needsApproval = (item: Pick<ReportItem, 'severity' | 'group'>): boolean =>
  item.severity === 'omission' && (item.group === 'holder' || item.group === 'door');

function classify(
  item: FidelityItem,
  required: readonly string[],
  omit: readonly string[],
): ReportItem | null {
  const unmet = required.some((r) => covers(r, item.capability));
  let severity: ItemSeverity;
  if (item.support === 'native') return null;
  if (unmet) severity = 'blocked';
  else if (item.support === 'text') return null;
  else severity = item.support === 'difference' ? 'difference' : 'omission';
  return {
    capability: item.capability,
    path: item.path,
    support: item.support,
    severity,
    group: groupOf(item),
    chosen: severity === 'omission' && isChosen(omit, item),
    message: item.message,
  };
}

const itemOrder = (a: ReportItem, b: ReportItem): number =>
  compare(a.capability, b.capability) ||
  compare(a.path, b.path) ||
  compare(a.support, b.support) ||
  compare(a.message, b.message);

export interface ReportInput {
  target: WalletTarget;
  compiler: WalletCompiler;
  /** The sample view and one per `x-examples` value, in a fixed order. */
  views: readonly WalletPassView[];
  wallets?: WalletsManifest;
  /** The version's creation time, so a report never depends on the clock. */
  now: Date;
}

export function fidelityReport(input: ReportInput): FidelityReport {
  const { target, compiler, views, wallets, now } = input;
  const config = wallets?.[target];
  const base = { schema: 1 as const, target, compilerRevision: compiler.revision };
  if (config?.type === 'off') return { ...base, type: 'off', status: { kind: 'off' }, items: [] };

  const required: readonly string[] = wallets?.required ?? [];
  const omit: readonly string[] = config?.omit ?? [];
  const results = views.map((view) => compiler.compile(view, { now, omit }));

  const seen = new Set<string>();
  const items: ReportItem[] = [];
  for (const result of results)
    for (const item of result.items) {
      const reported = classify(item, required, omit);
      if (!reported) continue;
      const key = `${reported.capability}|${reported.path}|${reported.support}|${reported.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(reported);
    }
  items.sort(itemOrder);

  const blocked = results.find((r) => r.blocked)?.blocked;
  const firstBlocked = items.find((i) => i.severity === 'blocked');
  const omissions = items.filter(needsApproval).length;
  let status: ReportStatus = { kind: 'ready' };
  if (blocked) status = { kind: 'blocked', reason: blocked.message };
  else if (firstBlocked)
    status = {
      kind: 'blocked',
      reason: `${firstBlocked.capability} is required: ${firstBlocked.message}`,
    };
  else if (omissions > 0) status = { kind: 'omissions', count: omissions };
  return { ...base, type: results[0]?.type ?? '', status, items };
}

export function statusLabel(status: ReportStatus): string {
  switch (status.kind) {
    case 'off':
      return 'Off';
    case 'ready':
      return 'Ready';
    case 'omissions':
      return `Ready with omissions (${status.count})`;
    case 'blocked':
      return `Blocked: ${status.reason}`;
  }
}

/** The key a release approval stores for one omission. */
export const omissionKey = (item: Pick<ReportItem, 'capability' | 'path'>): string =>
  item.path ? `${item.capability}@${item.path}` : item.capability;

/** The omissions an approval covers, sorted. Differences, blocks and `look`/`absent` items are not approved. */
export function omissionKeys(report: FidelityReport): string[] {
  return [...new Set(report.items.filter(needsApproval).map(omissionKey))].sort(compare);
}

/** JSON with object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => compare(a, b))
          .map(([k, x]) => [k, sort(x)]),
      );
    return v;
  };
  return JSON.stringify(sort(value));
}

/** SHA-256 hex of the canonical report: what a release candidate pins. */
export async function reportHash(report: FidelityReport): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(report)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
