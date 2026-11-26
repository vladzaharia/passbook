import type { ViewGroup } from '@/passkit/wallets/vocab.ts';
import { capabilityLabel, GROUP_NAME } from '@/shared/copy/wallets.ts';

/** Field label by path (`backFields.terms`), from the view when the host has one. */
export type FieldLabels = Readonly<Record<string, string>>;

const FIELD_PATH = /^(header|primary|secondary|auxiliary|additionalInfo|footer|back)Fields\.(.+)$/;

/** Where a report item points, in words: `Back · Terms` for a field, the capability name otherwise. */
export function describeItem(
  item: { capability: string; path: string },
  labels: FieldLabels = {},
): string {
  const field = FIELD_PATH.exec(item.path);
  if (field) {
    const group = GROUP_NAME[field[1] as ViewGroup];
    return `${group} · ${labels[item.path] ?? field[2]}`;
  }
  return capabilityLabel(item.capability);
}
