import { useQuery } from '@tanstack/react-query';
import { type MessageRuleDto, MessageRuleListSchema } from '@/shared/contracts/message-rules.ts';
import { missedLine, RULE_COPY, ruleSummary } from '@/shared/copy/message-rules.ts';
import { api } from '../../lib/api.ts';
import { Card, CardBody, CardHeader, StatusPill } from '../../ui/index.ts';

/** "renewsOn" -> "Renews on": the input's key, as a label. */
const keyLabel = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const anchorLabel = (rule: MessageRuleDto) =>
  rule.anchor.kind === 'lastScan' ? 'the last scan' : keyLabel(rule.anchor.input);

/** Automatic messages, read only: they are set up through the API; this says what is running. */
export function RulesSection({ orgId }: { orgId: string }) {
  const rules = useQuery({
    queryKey: ['admin', 'message-rules', orgId] as const,
    queryFn: ({ signal }) =>
      api.get('/api/v1/message-rules', MessageRuleListSchema, { query: { orgId }, signal }),
  });
  // No access or nothing set up: no section, not an empty card.
  const items = rules.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="Automatic messages" />
      <CardBody>
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
              <StatusPill status={rule.state === 'on' ? 'active' : 'paused'}>
                {rule.state === 'on' ? 'On' : 'Paused'}
              </StatusPill>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
