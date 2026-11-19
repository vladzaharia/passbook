import { useState } from 'react';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import {
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  SegmentedControl,
  toast,
} from '../../ui/index.ts';
import { useBulkPassChannels } from './channels-api.ts';

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

  const close = () => {
    onOpenChange(false);
    setAction('off');
    setPicked([]);
    setNotify(false);
  };
  async function apply() {
    try {
      const result = await bulk.mutateAsync({
        action,
        channels: picked,
        ids,
        notify: action === 'off' && notify,
        orgId,
      });
      const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
      toast.success(`${plural(result.done)} updated${skipped}`);
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
              onClick={() => void apply()}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
