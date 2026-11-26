import { ShieldPlus } from 'lucide-react';
import { useState } from 'react';
import { OptionTile, useWizard, WizardDialog, WizardReview } from '@/web/ui/index.ts';
import { type Slot, useStartPlatformSlot } from './platform-queries.ts';
import { PlatformRun } from './platform-run.tsx';

const STEPS = [
  { id: 'slot', title: 'Slot', heading: 'Pick a slot' },
  { id: 'review', title: 'Review', heading: 'Check and set up' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

export const SLOTS: Record<Slot, { label: string; id: string }> = {
  root: { label: 'Root', id: 'pass.mobile.passbook' },
  devtest: { label: 'Device test', id: 'pass.mobile.passbook.devtest' },
};

/** Sets up a platform slot through the connector; the result is the run, live. */
export function PlatformSetupWizard({
  open,
  onOpenChange,
  slots,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The slots with no identity yet. */
  slots: readonly Slot[];
}) {
  const start = useStartPlatformSlot();
  const [picked, setPicked] = useState<Slot | undefined>();
  const [runId, setRunId] = useState<string>();
  const slot = picked ?? (slots.length === 1 ? slots[0] : undefined);
  const w = useWizard<StepId>({
    open,
    steps: STEPS.map((s) => ({
      ...s,
      ...(s.id === 'slot' && slot ? { summary: SLOTS[slot].label } : {}),
    })),
    errors: { slot: slot ? undefined : { slot: 'Pick a slot.' } },
    hints: { slot: 'Pick a slot.' },
    fieldStep: { slot: 'slot' },
    onFinish: async () => {
      if (slot) setRunId((await start.mutateAsync(slot)).id);
    },
  });
  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Set up identity"
      wizard={w}
      dirty={picked !== undefined}
      finishLabel="Set up"
      busy={start.isPending}
      onClose={() => {
        setPicked(undefined);
        setRunId(undefined);
      }}
      result={
        runId
          ? {
              title: 'Setting up',
              icon: <ShieldPlus aria-hidden />,
              body: <PlatformRun runId={runId} />,
              onDone: () => onOpenChange(false),
            }
          : undefined
      }
    >
      {w.id === 'slot' ? (
        <fieldset className="flex min-w-0 flex-col">
          <legend className="mb-2 text-sm font-medium text-fg">Slot</legend>
          <div className="grid gap-3 @md:grid-cols-2">
            {slots.map((s) => (
              <OptionTile
                key={s}
                name="platform-slot"
                value={s}
                label={SLOTS[s].label}
                description={<span className="break-all font-mono text-xs">{SLOTS[s].id}</span>}
                checked={slot === s}
                onSelect={(v) => setPicked(v as Slot)}
              />
            ))}
          </div>
          {w.errors.slot ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {w.errors.slot}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {w.id === 'review' && slot ? (
        <WizardReview<StepId>
          onEdit={w.go}
          sections={[
            {
              id: 'slot',
              title: 'Slot',
              items: [
                { label: 'Slot', value: SLOTS[slot].label },
                { label: 'Pass type ID', value: SLOTS[slot].id, mono: true },
              ],
            },
          ]}
          note="Apple takes a few minutes."
        />
      ) : null}
    </WizardDialog>
  );
}
