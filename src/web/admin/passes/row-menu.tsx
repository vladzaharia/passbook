import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { Fragment, useState } from 'react';
import { PassDetailSchema, type PassSummaryDto } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from '../../ui/index.ts';
import { passKeys } from './api.ts';
import { usePassActionRunner } from './pass-actions.tsx';

/**
 * The row's action menu: the same actions and guards as the detail header (actionsFor). Opening
 * it loads the pass links, so Open, Download and Copy work inside the click.
 */
export function PassRowMenu({ pass }: { pass: PassSummaryDto }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: passKeys.detail(pass.id),
    queryFn: ({ signal }) => api.get(`/api/v1/passes/${pass.id}`, PassDetailSchema, { signal }),
    enabled: open,
    staleTime: 30_000,
  });
  const runner = usePassActionRunner(pass, detail.data, { onDeleted: () => {} });
  const firstDanger = runner.defs.findIndex((d) => d.destructive);
  const needsLinks = new Set(['open', 'download', 'copy']);
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="sm"
            label={`Actions for ${pass.title ?? pass.serial}`}
            icon={<MoreHorizontal aria-hidden />}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {runner.defs.map((d, i) => (
            <Fragment key={d.id}>
              {i === firstDanger && i > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                destructive={d.destructive}
                disabled={needsLinks.has(d.id) && !runner.links}
                onSelect={() => runner.run(d.id)}
              >
                <d.icon aria-hidden />
                {d.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {runner.dialogs}
    </>
  );
}
