import { Fragment, type ReactNode } from 'react';
import { Button, DropdownMenuItem, DropdownMenuSeparator, MoreMenu } from '../../../ui/index.ts';
import type { PassActionRunner } from '../pass-actions.tsx';

export function HeaderActionsView({
  runner,
  lead,
}: {
  runner: PassActionRunner;
  /** Shown first, in the same wrapping row. */
  lead?: ReactNode;
}) {
  const bar = runner.defs.filter((d) => d.bar);
  const more = runner.defs.filter((d) => !d.bar);
  const firstDanger = more.findIndex((d) => d.destructive);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {lead}
      {bar.map((d) => {
        const Icon = d.icon;
        const text = d.label;
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
            className={d.id === 'void' ? 'text-danger' : undefined}
            iconStart={<Icon aria-hidden />}
            loading={runner.pending[d.id]}
            busy={d.id === 'pull' ? 'spin' : undefined}
            done={runner.done[d.id]}
            disabled={d.disabled || (d.id === 'open' && !runner.links) || undefined}
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
              {d.id === 'download' && runner.links && !d.disabled ? (
                <DropdownMenuItem asChild>
                  <a href={runner.links.downloadUrl} download>
                    <Icon aria-hidden />
                    {d.label}
                  </a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  destructive={d.destructive}
                  disabled={d.disabled}
                  title={d.reason}
                  onSelect={() => runner.run(d.id)}
                >
                  <Icon aria-hidden />
                  {d.label}
                  {d.reason ? <span className="text-fg-muted text-xs">{d.reason}</span> : null}
                </DropdownMenuItem>
              )}
            </Fragment>
          );
        })}
      </MoreMenu>
      {runner.dialogs}
    </div>
  );
}
