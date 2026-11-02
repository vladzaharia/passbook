import { Fragment } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { Button, DropdownMenuItem, DropdownMenuSeparator, MoreMenu } from '../../../ui/index.ts';
import { type PassActionRunner, usePassActionRunner } from '../pass-actions.tsx';

export function HeaderActionsView({ runner }: { runner: PassActionRunner }) {
  const bar = runner.defs.filter((d) => d.bar);
  const more = runner.defs.filter((d) => !d.bar);
  const firstDanger = more.findIndex((d) => d.destructive);
  return (
    <>
      {bar.map((d) => {
        const Icon = d.icon;
        const short =
          d.id === 'open' ? 'Open' : d.id === 'update' ? 'Update' : d.id === 'pull' ? 'Pull' : null;
        const text = short ? (
          <span>
            {short}
            <span className="max-md:sr-only">{d.label.slice(short.length)}</span>
          </span>
        ) : (
          d.label
        );
        if (d.id === 'open' && runner.links)
          return (
            <Button key={d.id} asChild variant="outline" iconStart={<Icon aria-hidden />}>
              <a
                href={runner.links.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={d.label}
              >
                {text}
              </a>
            </Button>
          );
        return (
          <Button
            key={d.id}
            variant="outline"
            iconStart={<Icon aria-hidden />}
            loading={runner.pending[d.id]}
            busy={d.id === 'pull' ? 'spin' : undefined}
            done={runner.done[d.id]}
            disabled={(d.id === 'open' && !runner.links) || undefined}
            aria-label={short ? d.label : undefined}
            onClick={() => runner.run(d.id)}
          >
            {text}
          </Button>
        );
      })}
      <MoreMenu>
        {more.map((d, i) => {
          const Icon = d.icon;
          return (
            <Fragment key={d.id}>
              {i === firstDanger && i > 0 ? <DropdownMenuSeparator /> : null}
              {d.id === 'download' && runner.links ? (
                <DropdownMenuItem asChild>
                  <a href={runner.links.downloadUrl} download>
                    <Icon aria-hidden />
                    {d.label}
                  </a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem destructive={d.destructive} onSelect={() => runner.run(d.id)}>
                  <Icon aria-hidden />
                  {d.label}
                </DropdownMenuItem>
              )}
            </Fragment>
          );
        })}
      </MoreMenu>
      {runner.dialogs}
    </>
  );
}
