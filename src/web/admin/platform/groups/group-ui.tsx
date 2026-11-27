import type { Group } from '@/shared/contracts/idp-access.ts';
import { GROUP_COPY, GROUP_FLAG } from '@/shared/copy/idp-platform.ts';
import { StatusPill } from '@/web/ui/index.ts';

export const GroupKindPill = ({ kind }: { kind: Group['kind'] }) => (
  <StatusPill status={`group_${kind}`} />
);

/** The group's own name, else its key: roles have no friendly name until set. */
export const groupLabel = (g: Pick<Group, 'friendlyName' | 'name' | 'key'>): string =>
  g.friendlyName ?? g.name ?? g.key;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the members come from: PassBook's live sources, else Polaris ID alone. */
export function setBy(g: Pick<Group, 'kind' | 'rules' | 'manual'>): string {
  if (g.kind === 'role') return 'Memberships and grants';
  const parts = [
    g.rules > 0 ? plural(g.rules, 'org rule') : null,
    g.manual > 0 ? `${g.manual} manual` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Polaris ID';
}

export const flagText = (flag: string): string => GROUP_FLAG[flag] ?? flag.replace(/_/g, ' ');

/** A role group the binding found no group for: **Create in Polaris ID** makes it. */
export const needsCreate = (g: Pick<Group, 'kind' | 'flags'>): boolean =>
  g.kind === 'role' && g.flags.includes('group_not_found');

/**
 * `hidden`: roles and adopted groups are never deleted. A reason: delete is off until it is
 * gone. null: the server decides (Polaris ID may still refuse a group its owner filled).
 */
export function deleteBlock(
  g: Pick<Group, 'kind' | 'rules' | 'manual' | 'otherClients'>,
): 'hidden' | string | null {
  if (g.kind !== 'custom') return 'hidden';
  if (g.manual > 0) return GROUP_COPY.hasMembers;
  if (g.rules > 0) return GROUP_COPY.hasRules;
  if ((g.otherClients ?? 0) > 0) return GROUP_COPY.usedByOthers;
  return null;
}
