import { WizardReview } from '@/web/ui/index.ts';
import type { SessionDraft } from './draft.ts';
import { ruleLabel, type SessionStepId } from './session-steps.ts';

const yes = (on: boolean) => (on ? 'On' : 'Off');

/** What the session will do, by step, each with a way back to change it. */
export function SessionReview({
  draft,
  orgName,
  onEdit,
}: {
  draft: SessionDraft;
  orgName: string | undefined;
  onEdit: (id: SessionStepId) => void;
}) {
  const n = draft.templateIds.length + draft.eventIds.length;
  return (
    <WizardReview<SessionStepId>
      onEdit={onEdit}
      sections={[
        {
          id: 'passes',
          title: 'Passes',
          items: [
            { label: 'Name', value: draft.name.trim() },
            ...(orgName ? [{ label: 'Organization', value: orgName }] : []),
            {
              label: 'Admits',
              value: draft.accepts === 'all' ? 'Any pass type' : `${n} selected`,
            },
            { label: 'Hours', value: draft.hoursOn ? 'Set hours' : 'Always open' },
          ],
        },
        { id: 'rules', title: 'Admission', items: [{ label: 'Rule', value: ruleLabel(draft) }] },
        {
          id: 'access',
          title: 'Access',
          items: [
            { label: 'Direction', value: draft.direction },
            { label: 'Desk actions', value: yes(draft.deskActions) },
          ],
        },
        {
          id: 'customer',
          title: 'Customer screen',
          items: [{ label: 'Greeting', value: draft.customer?.welcome?.trim() || 'Default' }],
        },
        {
          id: 'defaults',
          title: 'Device defaults',
          items: [
            {
              label: 'On scan',
              value: draft.flow === 'choose' ? 'Review before check-in' : 'Check in automatically',
            },
            { label: 'Reader', value: draft.reader === 'barcode' ? 'Hardware scanner' : 'Camera' },
            { label: 'Look up people', value: yes(draft.lookup) },
          ],
        },
      ]}
    />
  );
}
