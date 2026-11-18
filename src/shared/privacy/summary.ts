import {
  DATA_CLASSES,
  ON_EXPIRY_TEXT,
  PLATFORM_ONLY_RETENTION,
  RETENTION_CLASSES,
  type RetentionClass,
} from './data-classes.ts';

export const SUB_PROCESSORS: readonly string[] = [
  'Cloudflare (hosting, database, storage, email)',
  'Apple (push notifications, Wallet)',
  'Google Wallet and Samsung Wallet (when enabled)',
];

export interface SummaryClass {
  cls: RetentionClass;
  label: string;
  holds: string;
  days: number;
  source: 'org' | 'platform';
  onExpiry: string;
  /** Epoch ms when a shorter value starts, while a floor still holds the old one. */
  pendingShorterFrom?: number;
}

export interface PrivacySummary {
  org: { id: string; name: string };
  contacts: { legalName: string | null; email: string | null; url: string | null };
  classes: SummaryClass[];
  platformOnly: { label: string; text: string }[];
  subProcessors: string[];
  holds: number;
  lastReceipts: { cls: string; ranAt: number; deleted: number }[];
}

export interface SummaryInput {
  org: { id: string; name: string };
  contacts: PrivacySummary['contacts'];
  /** Effective days per class and whether the org chose it. A skipped class is left out. */
  effective: Partial<
    Record<
      RetentionClass,
      { days: number; source: 'org' | 'platform'; pendingShorterFrom?: number }
    >
  >;
  holds: number;
  lastReceipts: PrivacySummary['lastReceipts'];
}

/** Holds are counted, never explained: the summary does not disclose why. */
export function buildSummary(input: SummaryInput): PrivacySummary {
  const classes: SummaryClass[] = [];
  for (const cls of RETENTION_CLASSES) {
    const e = input.effective[cls];
    if (!e) continue;
    const c = DATA_CLASSES[cls];
    classes.push({
      cls,
      label: c.label,
      holds: c.holds,
      days: e.days,
      source: e.source,
      onExpiry: ON_EXPIRY_TEXT[c.onExpiry],
      ...(e.pendingShorterFrom !== undefined ? { pendingShorterFrom: e.pendingShorterFrom } : {}),
    });
  }
  return {
    org: input.org,
    contacts: input.contacts,
    classes,
    platformOnly: [...PLATFORM_ONLY_RETENTION],
    subProcessors: [...SUB_PROCESSORS],
    holds: input.holds,
    lastReceipts: input.lastReceipts,
  };
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Markdown an org can attach to its DPA. Deterministic: same summary, same text. */
export function renderSummaryMarkdown(s: PrivacySummary): string {
  const lines = [`# Data processing summary: ${s.org.name}`, ''];
  const contacts = [
    s.contacts.legalName && `Legal name: ${s.contacts.legalName}`,
    s.contacts.email && `Privacy contact: ${s.contacts.email}`,
    s.contacts.url && `Privacy notice: ${s.contacts.url}`,
  ].filter((x): x is string => Boolean(x));
  if (contacts.length) lines.push(...contacts.map((c) => `- ${c}`), '');
  lines.push('## Retention', '', '| Data | Kept | Then | Source |', '| --- | --- | --- | --- |');
  for (const c of s.classes) {
    const days = c.pendingShorterFrom
      ? `${c.days} days (shorter from ${date(c.pendingShorterFrom)})`
      : `${c.days} days`;
    lines.push(`| ${cell(c.label)}: ${cell(c.holds)} | ${days} | ${c.onExpiry} | ${c.source} |`);
  }
  lines.push('', '## Kept by PassBook', '');
  lines.push(...s.platformOnly.map((p) => `- ${p.label}: ${p.text}`));
  lines.push('', '## Sub-processors', '', ...s.subProcessors.map((p) => `- ${p}`));
  lines.push('', `Legal holds in force: ${s.holds}`);
  if (s.lastReceipts.length) {
    lines.push('', '## Last deletion runs', '');
    lines.push(...s.lastReceipts.map((r) => `- ${r.cls}: ${date(r.ranAt)}, ${r.deleted} removed`));
  }
  return `${lines.join('\n')}\n`;
}
