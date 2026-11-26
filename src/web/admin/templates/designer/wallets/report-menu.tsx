import { MoreHorizontal } from 'lucide-react';
import type { FidelityReportDto } from '@/shared/contracts/wallet-fidelity.ts';
import { capabilityLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { ACTION_ICON as I } from '../../../../lib/action-icons.ts';
import { removeWithTransition } from '../../../../lib/motion.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import type { GroupId } from '../model.ts';
import { selectionFor } from './blocked-fixes.ts';
import type { WalletEnv } from './wallets-env.ts';
import { targetBlock } from './wallets-env.ts';

type Item = FidelityReportDto['items'][number];
const C = WALLETS_COPY.report;
const FIELD = /^(header|primary|secondary|auxiliary|additionalInfo|footer|back)Fields\.(.+)$/;

/** The row menu of an author report: go to its source, leave it out on purpose, require it. */
export function ReportRowMenu({ item, env, where }: { item: Item; env: WalletEnv; where: string }) {
  const { focusTarget } = useDesigner();
  const { target, block, edit } = env;
  const field = FIELD.exec(item.path);
  const go = field
    ? { section: `${field[1]}Fields` as GroupId, key: field[2] as string }
    : selectionFor(item.capability, target);
  const entry = item.path || item.capability;
  const omit = (targetBlock(block, target).omit ?? []) as string[];
  const left = omit.includes(entry) || omit.includes(item.capability);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${where}: actions`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:size-11"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {go ? (
          <DropdownMenuItem onSelect={() => focusTarget(go)}>
            <I.goTo aria-hidden />
            {C.goTo.replace('{label}', where)}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() =>
            removeWithTransition(() =>
              edit({
                op: 'wallets-omit',
                target,
                entry: left ? (omit.includes(entry) ? entry : item.capability) : entry,
                on: !left,
              }),
            )
          }
        >
          {left ? <I.showAgain aria-hidden /> : <I.leaveOut aria-hidden />}
          {left ? C.showAgain : C.leaveOut}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => edit({ op: 'wallets-required', id: item.capability, on: true })}
        >
          <I.require aria-hidden />
          {C.requireEvery}
          <span className="sr-only"> {capabilityLabel(item.capability)}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
