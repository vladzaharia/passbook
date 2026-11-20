import { MoreHorizontal, Pause, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { MessageRuleDto } from '@/shared/contracts/message-rules.ts';
import { missedLine, RULE_COPY, ruleSummary } from '@/shared/copy/message-rules.ts';
import { deleteConfirm } from '../../lib/confirms.ts';
import { ENTITY } from '../../lib/entities.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  StatusPill,
  toast,
} from '../../ui/index.ts';
import { RuleEditor } from './rule-editor.tsx';
import { anchorLabel } from './rule-state.ts';
import { useRuleActions, useRules } from './rules-api.ts';

type Editing = { rule?: MessageRuleDto } | null;

/** Automatic messages: what is running, and where to set one up, edit, pause or delete it. */
export function RulesSection({ orgId }: { orgId: string }) {
  const rules = useRules(orgId);
  const scope = useOrgScope();
  const canManage = scope.membership?.capabilities.includes('messages:manage') === true;
  const actions = useRuleActions(orgId);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<MessageRuleDto | null>(null);
  const items = rules.data?.items ?? [];
  // No access to read them: no section.
  if (!rules.data || (items.length === 0 && !canManage)) return null;
  const confirm = deleting ? deleteConfirm('rule', deleting.name) : null;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Automatic messages"
        actions={
          canManage ? (
            <Button size="sm" variant="outline" onClick={() => setEditing({})}>
              <Plus aria-hidden /> New
            </Button>
          ) : null
        }
      />
      <CardBody>
        {items.length === 0 ? (
          <EmptyState
            inline
            art={ENTITY.broadcast.art}
            title="No automatic messages"
            description="Send on a date or after a scan."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg-strong">{rule.name}</p>
                  <p className="text-xs text-fg-muted">
                    {ruleSummary({
                      anchorLabel: anchorLabel(rule),
                      offset: rule.offset,
                      yearly: rule.yearly,
                      sendAt: rule.sendAt,
                    })}
                    {' · '}
                    {rule.sent} sent · {missedLine(rule.skipped)}
                  </p>
                  {rule.pausedCode ? (
                    <p className="text-xs text-fg-muted">{RULE_COPY.paused[rule.pausedCode]}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <StatusPill status={rule.state === 'on' ? 'active' : 'paused'}>
                    {rule.state === 'on' ? 'On' : 'Paused'}
                  </StatusPill>
                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          size="sm"
                          label={`Actions for ${rule.name}`}
                          icon={<MoreHorizontal aria-hidden />}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing({ rule })}>
                          <Pencil aria-hidden /> Edit
                        </DropdownMenuItem>
                        {rule.state === 'on' ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              actions.pause.mutate(rule.id, {
                                onSuccess: () => toast.success('Paused'),
                                onError: (e) => toast.error(e, 'Could not pause'),
                              })
                            }
                          >
                            <Pause aria-hidden /> Pause
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem destructive onSelect={() => setDeleting(rule)}>
                          <Trash2 aria-hidden /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {editing ? (
        <RuleEditor
          key={editing.rule?.id ?? 'new'}
          orgId={orgId}
          rule={editing.rule}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {confirm && deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          destructive
          onConfirm={async () => {
            try {
              await actions.remove.mutateAsync(deleting.id);
              toast.success('Deleted');
              setDeleting(null);
            } catch (e) {
              toast.error(e, 'Could not delete');
            }
          }}
        />
      ) : null}
    </Card>
  );
}
