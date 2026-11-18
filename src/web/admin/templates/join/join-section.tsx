import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { useMode } from '../../../lib/mode.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { JoinCard } from './join-card.tsx';

/** The overview's join card for the console's org and mode; blueprints have none (they are starters). */
export function JoinSection({ template: t }: { template: z.infer<typeof TemplateDetailSchema> }) {
  const scope = useOrgScope();
  const mode = useMode();
  const caps = scope.membership?.capabilities ?? [];
  if (t.blueprint || !scope.orgId || !caps.includes('passes:read')) return null;
  return (
    <JoinCard
      key={`${t.id}:${scope.orgId}:${mode}`}
      templateId={t.id}
      orgId={t.orgId === null ? scope.orgId : undefined}
      scopeOrgId={scope.orgId}
      mode={mode}
      canOperate={caps.includes('passes:operate')}
      canPublish={caps.includes('templates:publish')}
    />
  );
}
