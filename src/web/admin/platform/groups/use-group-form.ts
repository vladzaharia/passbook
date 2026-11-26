import { useState } from 'react';
import { GroupFriendlyNameSchema, GroupNewKeySchema } from '@/shared/contracts/idp-access.ts';
import type { OrgRole } from '@/shared/contracts/org-membership.ts';
import { keyFromName } from '@/shared/copy/idp-platform.ts';

export const STEPS = [
  { id: 'name', title: 'Name', heading: 'Name the group' },
  { id: 'rules', title: 'Rules', heading: 'Who joins' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export const HINTS: Partial<Record<StepId, string>> = { name: 'Name the group.' };
export const FIELD_STEP: Record<string, StepId> = {
  key: 'name',
  friendlyName: 'name',
  rules: 'rules',
};
/** PassBook allows five org rules on a group. */
export const MAX_RULES = 5;

export interface DraftRule {
  orgId: string;
  orgRoles: OrgRole[];
}

/** What the New group wizard collects. The key follows the name until it is typed over. */
export function useGroupForm() {
  const [name, setName] = useState('');
  const [typedKey, setTypedKey] = useState<string | null>(null);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const key = typedKey ?? keyFromName(name);
  const nameOk = GroupFriendlyNameSchema.safeParse(name);
  const keyOk = GroupNewKeySchema.safeParse(key);
  return {
    name,
    setName,
    key,
    setKey: (next: string) => setTypedKey(next.toLowerCase()),
    rules,
    addRule: (rule: DraftRule) => setRules((all) => [...all, rule]),
    removeRule: (orgId: string) => setRules((all) => all.filter((r) => r.orgId !== orgId)),
    errors: {
      name: nameOk.success
        ? keyOk.success
          ? undefined
          : { key: keyOk.error.issues[0]?.message ?? 'Use another key.' }
        : { friendlyName: 'Use 2 to 50 characters.' },
      rules: undefined,
      review: undefined,
    },
    nameError: nameOk.success ? undefined : 'Use 2 to 50 characters.',
    keyError: keyOk.success ? undefined : (keyOk.error.issues[0]?.message ?? 'Use another key.'),
    dirty: name.trim() !== '' || rules.length > 0,
    reset: () => {
      setName('');
      setTypedKey(null);
      setRules([]);
    },
  };
}
export type GroupForm = ReturnType<typeof useGroupForm>;
