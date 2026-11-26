import type { WizardStepDef } from '@/web/ui/index.ts';

type Access = { title: string; heading: string; summary: string | undefined };

export const INVITE_HINTS = { person: 'Enter an email.' } as const;

/** Mask the local part: the Done step shows who it went to without echoing the whole address. */
export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 1)}•••@${domain}`;
}

export function inviteSteps(
  access: Access,
  count: number,
): WizardStepDef<'person' | 'access' | 'review'>[] {
  return [
    {
      id: 'person',
      title: 'Person',
      heading: 'Who to invite',
      summary: count > 0 ? `${count} ${count === 1 ? 'address' : 'addresses'}` : undefined,
    },
    { id: 'access', title: access.title, heading: access.heading, summary: access.summary },
    { id: 'review', title: 'Review', heading: 'Check and send' },
  ];
}
