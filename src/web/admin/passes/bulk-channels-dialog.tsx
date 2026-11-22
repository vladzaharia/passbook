import { useState } from 'react';
import { isDigital } from '@/shared/channels.ts';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { bulkChannelsOffConfirm } from '../../lib/confirms.ts';
import {
  Button,
  CheckboxField,
  ConfirmDialog,
  Dialog,
  DialogContent,
  SegmentedControl,
  toast,
} from '../../ui/index.ts';
import { BulkPreview } from './bulk-channels-preview.tsx';
import { useBulkChannelsPreview, useBulkPassChannels } from './channels-api.ts';

type Action = 'on' | 'off' | 'reset';
const ACTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: 'reset', label: CHANNEL_COPY.useTemplate },
] as const;

const plural = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;

/**
 * Channels for the selected passes: On, Off or Use template for the ticked channels. Off never
 * replaces codes; holders are emailed only when asked.
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
  const [action, setAction] = useState<Action>('off');
  const [picked, setPicked] = useState<Channel[]>([]);
  const [notify, setNotify] = useState(false);
  const [replace, setReplace] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const close = () => {
    onOpenChange(false);
    setAction('off');
    setPicked([]);
    setNotify(false);
    setReplace(false);
  };
  /** New codes only follow turning a digital channel off. */
  const canReplace = action === 'off' && picked.some(isDigital);
  const preview = useBulkChannelsPreview(
    {
      action,
      channels: picked,
      ids,
      notify: false,
      ...(canReplace && replace ? { replaceCodes: true } : {}),
      orgId,
    },
    open && action === 'off' && picked.length > 0,
  );
  const offConfirm = {
    ...bulkChannelsOffConfirm(
      picked.map((c) => CHANNEL_LABEL[c]),
      ids.length,
    ),
    // "Copies keep working" is wrong once new codes are issued.
    ...(canReplace && replace ? { description: undefined } : {}),
  };
  async function apply() {
    try {
      const result = await bulk.mutateAsync({
        action,
        channels: picked,
        ids,
        notify: action === 'off' && notify,
        ...(canReplace && replace ? { replaceCodes: true } : {}),
        orgId,
      });
      const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
      toast.success(
        `${plural(result.done)} updated${skipped}${canReplace && replace ? `. ${CHANNEL_COPY.bulkReplaced}` : ''}`,
      );
      close();
      onDone();
    } catch (error) {
      toast.error(error, 'Could not change channels.');
    }
  }
  const toggle = (c: Channel, on: boolean) =>
    setPicked((p) =>
      on ? CHANNELS.filter((x) => x === c || p.includes(x)) : p.filter((x) => x !== c),
    );

  return (
    <Dialog
      open={open}
      dirty={picked.length > 0}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title={CHANNEL_COPY.bulkTitle}
        description={plural(ids.length)}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={picked.length === 0}
              loading={bulk.isPending}
              onClick={() => (action === 'off' ? setConfirming(true) : void apply())}
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <SegmentedControl
            label="Change"
            options={ACTIONS}
            value={action}
            onValueChange={setAction}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium text-fg-strong">Channels</legend>
            {CHANNELS.map((c) => (
              <CheckboxField
                key={c}
                label={CHANNEL_LABEL[c]}
                checked={picked.includes(c)}
                onCheckedChange={(v) => toggle(c, v === true)}
              />
            ))}
          </fieldset>
          {action === 'off' ? (
            <CheckboxField
              label={CHANNEL_COPY.bulkNotify}
              checked={notify}
              onCheckedChange={(v) => setNotify(v === true)}
            />
          ) : null}
          {action === 'off' && picked.length > 0 && preview.data?.preview ? (
            <BulkPreview preview={preview.data.preview} replace={canReplace && replace} />
          ) : null}
          {canReplace ? (
            <div className="flex flex-col gap-1">
              <CheckboxField
                label={CHANNEL_COPY.replaceBox}
                checked={replace}
                onCheckedChange={(v) => setReplace(v === true)}
              />
              {replace ? (
                <p className="text-xs text-fg-muted">{CHANNEL_COPY.bulkReplaced}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        {...offConfirm}
        onConfirm={apply}
      />
    </Dialog>
  );
}
