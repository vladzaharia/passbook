import { useState } from 'react';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { bulkChannelsOffConfirm } from '../../lib/confirms.ts';
import { toast, useWizard, WizardDialog, WizardReview } from '../../ui/index.ts';
import { trackStarted } from '../operations/admin-operation.tsx';
import { BulkPreview } from './bulk-channels-preview.tsx';
import {
  ACTION_WORD,
  BULK_FIELD_STEP,
  BULK_HINTS,
  BULK_STEPS,
  type BulkAction,
  canReplaceCodes,
  StepChannels,
  StepHolders,
} from './bulk-channels-steps.tsx';
import { useBulkChannelsPreview, useBulkPassChannels } from './channels-api.ts';

const plural = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;

/**
 * Channels for the selected passes: On, Off or Use template for the ticked channels, then a
 * review. Off never replaces codes; holders are emailed only when asked.
 */
export function BulkChannelsDialog({
  open,
  onOpenChange,
  orgId,
  ids,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  ids: string[];
  onDone: () => void;
}) {
  const bulk = useBulkPassChannels();
  const [action, setAction] = useState<BulkAction>('off');
  const [picked, setPicked] = useState<Channel[]>([]);
  const [notify, setNotify] = useState(false);
  const [replace, setReplace] = useState(false);

  const canReplace = canReplaceCodes(action, picked);
  const replacing = canReplace && replace;
  const off = action === 'off';
  const preview = useBulkChannelsPreview(
    {
      action,
      channels: picked,
      ids,
      notify: false,
      ...(replacing ? { replaceCodes: true } : {}),
      orgId,
    },
    open && off && picked.length > 0,
  );

  const w = useWizard({
    open,
    steps: BULK_STEPS.map((s) => ({
      ...s,
      ...(s.id === 'holders' ? { skip: !off } : {}),
      summary:
        s.id === 'channels' && picked.length
          ? `${ACTION_WORD[action]}: ${picked.map((c) => CHANNEL_LABEL[c]).join(', ')}`
          : s.id === 'holders'
            ? notify
              ? 'Emailed'
              : 'Not emailed'
            : undefined,
    })),
    errors: { channels: picked.length ? undefined : { channels: 'Pick a channel.' } },
    hints: BULK_HINTS,
    fieldStep: BULK_FIELD_STEP,
    onFinish: async () => {
      const result = await bulk.mutateAsync({
        action,
        channels: picked,
        ids,
        notify: off && notify,
        ...(replacing ? { replaceCodes: true } : {}),
        orgId,
      });
      // The code replacements run on in the background: the tray shows them and says when they end.
      if (result.operationId) void trackStarted(result.operationId).catch(() => undefined);
      const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
      toast.success(
        `${plural(result.done)} updated${skipped}${replacing ? `. ${CHANNEL_COPY.bulkReplaced}` : ''}`,
      );
      onOpenChange(false);
      onDone();
    },
  });

  const toggle = (c: Channel, on: boolean) =>
    setPicked((p) =>
      on ? CHANNELS.filter((x) => x === c || p.includes(x)) : p.filter((x) => x !== c),
    );
  const labels = picked.map((c) => CHANNEL_LABEL[c]);
  const ask = bulkChannelsOffConfirm(labels, ids.length);

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={CHANNEL_COPY.bulkTitle}
      wizard={w}
      dirty={picked.length > 0}
      finishLabel={off ? ask.confirmLabel : action === 'on' ? 'Turn on' : CHANNEL_COPY.useTemplate}
      {...(off ? { finishTone: 'danger' as const } : {})}
      busy={bulk.isPending}
      onClose={() => {
        setAction('off');
        setPicked([]);
        setNotify(false);
        setReplace(false);
      }}
    >
      {w.id === 'channels' ? (
        <StepChannels
          action={action}
          onAction={setAction}
          picked={picked}
          onToggle={(c, on) => {
            toggle(c, on);
            w.clearServer('channels');
          }}
          replace={replace}
          onReplace={setReplace}
          error={w.errors.channels}
        />
      ) : null}
      {w.id === 'holders' ? <StepHolders notify={notify} onNotify={setNotify} /> : null}
      {w.id === 'review' ? (
        <WizardReview
          onEdit={w.go}
          sections={[
            {
              id: 'channels',
              title: 'Channels',
              items: [
                { label: 'Passes', value: plural(ids.length) },
                { label: 'Change', value: ACTION_WORD[action] },
                { label: 'Channels', value: labels.join(', ') },
                ...(canReplace ? [{ label: 'New codes', value: replace ? 'Yes' : 'No' }] : []),
              ],
            },
            ...(off
              ? [
                  {
                    id: 'holders' as const,
                    title: 'Holders',
                    items: [{ label: 'Email holders', value: notify ? 'Yes' : 'No' }],
                  },
                ]
              : []),
          ]}
          preview={
            off && preview.data?.preview ? (
              <BulkPreview preview={preview.data.preview} replace={replacing} />
            ) : null
          }
          {...(off && !replacing ? { note: ask.description } : {})}
        />
      ) : null}
    </WizardDialog>
  );
}
