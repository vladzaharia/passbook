import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import { SIMULATE_EVENTS } from '@/shared/contracts/events.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { buttonVariants } from '../../ui/button-variants.ts';
import { BenchMenu } from '../bench/menu.tsx';

/**
 * Simulate (design §3.5): the menu of events a Test pass can have, each a real Test event down the
 * normal path. The bench's own popover, so it opens inside a sheet; its footnote says what it does.
 */
export function SimulateMenu({
  onPick,
  busy,
}: {
  onPick: (event: (typeof SIMULATE_EVENTS)[number]) => void;
  busy: boolean;
}) {
  const items = useMemo(
    () =>
      SIMULATE_EVENTS.map((event) => ({
        key: event,
        label: WB_PASSES.simulate.events[event],
        disabled: busy,
        onSelect: () => onPick(event),
      })),
    [onPick, busy],
  );
  return (
    <BenchMenu
      label={WB_PASSES.simulate.label}
      items={items}
      footer={WB_PASSES.simulate.note}
      triggerClassName={buttonVariants({ variant: 'outline', size: 'sm' })}
      trigger={
        <>
          {WB_PASSES.simulate.label}
          <ChevronDown aria-hidden />
        </>
      }
    />
  );
}
