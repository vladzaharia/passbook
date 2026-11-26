import { MailPlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { errorMessage, UserMessageError } from '@/web/lib/errors.ts';
import {
  CopyButton,
  type KeyValueItem,
  ListRow,
  ListRows,
  useWizard,
  WizardDialog,
  WizardReview,
} from '@/web/ui/index.ts';
import { EmailChips } from '../../orgs/email-chips.tsx';
import { addEmails, type EmailChip } from '../../orgs/invite-emails.ts';
import { INVITE_HINTS, inviteSteps, maskEmail } from './invite-steps.ts';

/** What one address came to: the PassBook link (shown once) or the reason it was refused. */
export interface InviteOutcome {
  email: string;
  link?: string | undefined;
  error?: string | undefined;
}

/** The step that differs between orgs and the platform: org roles or Polaris ID groups. */
export interface InviteAccessStep {
  title: string;
  heading: string;
  hint: string;
  /** Why the access cannot be sent yet, or undefined. */
  error: string | undefined;
  summary: string | undefined;
  /** Anything chosen: the dialog asks before it is closed. */
  dirty: boolean;
  review: KeyValueItem[];
  /** The step's controls; `errors` holds the step's blocking problems once a Next is refused. */
  node: (errors: Record<string, string | undefined>) => ReactNode;
}

export interface InviteWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  access: InviteAccessStep;
  /** Sends one invitation. Throw the refusal; return false when the answer is no longer the person's to see. */
  send: (email: string) => Promise<{ link?: string } | boolean | undefined>;
  /** Clears the access the parent holds. */
  onClose: () => void;
}

/** The one Invite wizard: Person, Access (roles or groups), Review, Done. Org admins and platform admins share it. */
export function InviteWizard({
  open,
  onOpenChange,
  title,
  access,
  send,
  onClose,
}: InviteWizardProps) {
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [draft, setDraft] = useState('');
  const [outcomes, setOutcomes] = useState<InviteOutcome[]>();
  const all = addEmails(chips, draft);
  const emails =
    all.length === 0
      ? 'Enter an email address.'
      : all.some((chip) => !chip.valid)
        ? 'Enter valid email addresses.'
        : undefined;
  const w = useWizard({
    open,
    steps: inviteSteps(access, all.length),
    errors: { person: { emails }, access: { access: access.error } },
    hints: { ...INVITE_HINTS, access: access.hint },
    fieldStep: {
      email: 'person',
      emails: 'person',
      roles: 'access',
      groups: 'access',
      developer: 'access',
    },
    onFinish: async () => {
      const done: InviteOutcome[] = [];
      for (const chip of all) {
        try {
          const sent = await send(chip.email);
          if (sent === false) return;
          done.push({ email: chip.email, link: typeof sent === 'object' ? sent.link : undefined });
        } catch (cause) {
          done.push({ email: chip.email, error: errorMessage(cause) });
        }
      }
      // Nothing went: stay on Review with the reason instead of a Done that lists only refusals.
      const first = done.find((o) => o.error);
      if (first && done.every((o) => o.error))
        throw new UserMessageError(`${first.email}: ${first.error}`);
      setOutcomes(done);
    },
  });
  const reset = () => {
    setChips([]);
    setDraft('');
    setOutcomes(undefined);
    onClose();
  };
  const sent = outcomes?.filter((o) => !o.error) ?? [];

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      wizard={w}
      dirty={chips.length > 0 || draft.trim() !== '' || access.dirty}
      finishLabel={all.length > 1 ? `Send ${all.length}` : 'Send invitation'}
      onClose={reset}
      result={
        outcomes
          ? {
              title:
                sent.length === 1 && outcomes.length === 1 ? 'Invitation sent' : 'Invitations sent',
              icon: <MailPlus aria-hidden />,
              onDone: () => onOpenChange(false),
              body: (
                <ListRows label="Invitations">
                  {outcomes.map((o) => (
                    <ListRow
                      key={o.email}
                      title={o.error ? o.email : `Invitation sent to ${maskEmail(o.email)}.`}
                      meta={o.error}
                      trailing={o.link ? <CopyButton value={o.link} label="Copy link" /> : null}
                    />
                  ))}
                </ListRows>
              ),
            }
          : undefined
      }
    >
      {w.id === 'person' ? (
        <EmailChips
          chips={chips}
          onChange={setChips}
          draft={draft}
          onDraft={setDraft}
          error={w.errors.emails}
        />
      ) : null}
      {w.id === 'access' ? access.node(w.errors) : null}
      {w.id === 'review' ? (
        <WizardReview
          onEdit={w.go}
          sections={[
            {
              id: 'person',
              title: 'Person',
              items: [
                {
                  label: all.length > 1 ? 'Emails' : 'Email',
                  value: all.map((c) => c.email).join(', '),
                },
              ],
            },
            { id: 'access', title: access.title, items: access.review },
          ]}
        />
      ) : null}
    </WizardDialog>
  );
}
