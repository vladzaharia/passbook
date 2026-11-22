import { Link } from '@tanstack/react-router';
import { ChevronDown, CircleHelp, Nfc, Printer, Smartphone, Wallet } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import type { Channel } from '@/shared/contracts/channels.ts';
import type { SetupChannel, SetupTemplate } from '@/shared/contracts/pass-setup.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { channelStatusLine, PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { cn } from '@/web/lib/cn.ts';
import { Button, StatusPill, Switch } from '@/web/ui/index.ts';
import { ChainBadge, LockPill } from './chain-badge.tsx';

const ICON = {
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
 * One channel: icon, name, the lock pill of a level above the org, a status line, the one Allowed
 * switch (hidden while a level above stops the channel, so it never saves what cannot take
 * effect), and the chain, the channel's own part and its templates once open.
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
  ask,
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
  /** Plan-locked: where to ask for it. */
  ask?: ReactNode;
}) {
  const id = useId();
  const Icon = ICON[channel];
  const stop = stoppingLevel(row.levels);
  const above = stop?.state === 'locked';
  const status = channelStatusLine({ levels: row.levels, templates: row.templates });
  const state = row.on ? 'on' : (stop?.state ?? 'off');
  return (
    <li data-channel={channel} data-state={state} className="py-3 first:pt-0 last:pb-0">
      <div className="flex min-h-11 items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-strong text-fg-muted"
          >
            <Icon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-strong">
              {CHANNEL_LABEL[channel]}
              <LockPill levels={row.levels} />
            </span>
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  row.on
                    ? 'bg-success'
                    : stop?.state === 'needs'
                      ? 'bg-warning'
                      : 'bg-border-strong',
                )}
              />
              {status}
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
        {above ? null : (
          <Switch
            aria-label={`${CHANNEL_LABEL[channel]} ${PASS_SETUP_COPY.allowed.toLowerCase()}`}
            checked={row.allowed}
            disabled={!canEdit}
            onCheckedChange={onAllowed}
          />
        )}
      </div>
      {open ? (
        <div id={id} className="wl-rise flex flex-col gap-4 pt-3 pl-[3.25rem] max-sm:pl-0">
          <ChainBadge levels={row.levels} templates={row.templates} />
          {part}
          {above ? ask : <TemplateList orgId={orgId} channel={channel} templates={templates} />}
        </div>
      ) : null}
    </li>
  );
}

/** Ask PassBook: a mailto to PassBook's support, for a channel the plan does not include. */
export function AskPassbook({ channel, orgName }: { channel: Channel; orgName: string }) {
  const subject = encodeURIComponent(`${CHANNEL_LABEL[channel]} for ${orgName}`);
  return (
    <div>
      <Button asChild variant="outline" size="sm" iconStart={<CircleHelp aria-hidden />}>
        <a href={`mailto:${PASS_SETUP_COPY.support.emailPlaceholder}?subject=${subject}`}>
          {COPY.askPassbook}
        </a>
      </Button>
    </div>
  );
}
