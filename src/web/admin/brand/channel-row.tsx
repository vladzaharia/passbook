import { Link } from '@tanstack/react-router';
import { ChevronDown, Nfc, Printer, Smartphone, Wallet } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import type { Channel } from '@/shared/contracts/channels.ts';
import type { SetupChannel, SetupTemplate } from '@/shared/contracts/pass-setup.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { cn } from '@/web/lib/cn.ts';
import { Button, StatusPill, Switch } from '@/web/ui/index.ts';

export const CHANNEL_ICON = {
  apple: Wallet,
  mobile: Smartphone,
  google: Wallet,
  samsung: Wallet,
  paper: Printer,
  nfc: Nfc,
} as const;
const COPY = PASS_SETUP_COPY.page;

function TemplateList({
  orgId,
  channel,
  templates,
}: {
  orgId: string;
  channel: Channel;
  templates: readonly SetupTemplate[];
}) {
  if (templates.length === 0) return <p className="text-sm text-fg-muted">{COPY.noTemplates}</p>;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-fg-muted">{COPY.templates}</h3>
      <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border p-0">
        {templates.map((t) => {
          const e = t.channels[channel];
          return (
            <li key={t.id} className="flex min-h-11 items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-fg-strong">{t.name}</span>
              <StatusPill status={e.on ? 'on' : 'off'} tone={e.on ? 'success' : 'neutral'}>
                {e.on ? 'On' : e.reason === 'never' ? 'Never' : 'Off'}
              </StatusPill>
              <Button asChild variant="ghost" size="sm">
                <Link
                  to="/admin/o/$orgId/templates/$templateId"
                  params={{ orgId, templateId: t.id }}
                >
                  {COPY.edit}
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One channel the org can use: icon, name, one fact (the templates that use it) and the Allowed
 * switch; the channel's own part and its templates open under it. A channel PassBook or the plan
 * stops never reaches this row: the card hides it.
 */
export function ChannelRow({
  orgId,
  channel,
  row,
  templates,
  open,
  onToggle,
  canEdit,
  onAllowed,
  part,
}: {
  orgId: string;
  channel: Channel;
  row: SetupChannel;
  templates: readonly SetupTemplate[];
  open: boolean;
  onToggle: () => void;
  canEdit: boolean;
  onAllowed: (allowed: boolean) => void;
  /** The channel's own part: the Apple ID, a wallet account. */
  part?: ReactNode;
}) {
  const id = useId();
  const Icon = CHANNEL_ICON[channel];
  const stop = stoppingLevel(row.levels);
  const state = row.on ? 'on' : (stop?.state ?? 'off');
  const using = templates.filter((t) => t.channels[channel].on).map((t) => t.name);
  const fact =
    stop?.state === 'needs'
      ? PASS_SETUP_COPY.status.accountNeeded
      : using.length > 0
        ? using.join(', ')
        : COPY.noTemplates;
  // Allowed, but no template uses it: the dot reads as off.
  const unused = row.on && using.length === 0;
  return (
    <li
      data-channel={channel}
      data-state={state}
      {...(unused ? { 'data-unused': '' } : {})}
      className="py-3 first:pt-0 last:pb-0"
    >
      <div className="flex min-h-11 items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-strong text-fg-muted"
          >
            <Icon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-fg-strong">
              {CHANNEL_LABEL[channel]}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  row.on && !unused
                    ? 'bg-success'
                    : stop?.state === 'needs'
                      ? 'bg-warning'
                      : 'bg-border-strong',
                )}
              />
              <span className="truncate">{fact}</span>
            </span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-fg-muted transition-transform duration-(--wl-dur-enter) ease-(--wl-ease-spring)',
              open && 'rotate-180',
            )}
          />
        </button>
        <Switch
          aria-label={`${CHANNEL_LABEL[channel]} ${PASS_SETUP_COPY.allowed.toLowerCase()}`}
          checked={row.allowed}
          disabled={!canEdit}
          onCheckedChange={onAllowed}
        />
      </div>
      {open ? (
        <div id={id} className="wl-rise flex flex-col gap-4 pt-3 pl-[3.25rem] max-sm:pl-0">
          {part}
          <TemplateList orgId={orgId} channel={channel} templates={templates} />
        </div>
      ) : null}
    </li>
  );
}
