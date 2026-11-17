import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge, Button, Callout } from '../../ui/index.ts';
import { UseBlueprintDialog } from '../blueprints/use-dialog.tsx';
import { useTemplate } from '../templates/api.ts';

/**
 * A pass link that names a blueprint: say why it is not on the list and offer Use blueprint.
 * Templates on the list, and ids the reader cannot see, show nothing.
 */
export function LinkedBlueprint({
  orgId,
  listed,
}: {
  orgId: string | undefined;
  listed: readonly { id: string }[];
}) {
  const { templateId } = useSearch({ strict: false }) as { templateId?: string };
  const linked = templateId && !listed.some((t) => t.id === templateId) ? templateId : undefined;
  const template = useTemplate(orgId ? linked : undefined, orgId);
  const [using, setUsing] = useState(false);
  const b = template.data;
  if (!b?.blueprint) return null;
  return (
    <>
      <Callout
        tone="info"
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {b.name} <Badge tone="accent">Blueprint</Badge>
          </span>
        }
        actions={
          <Button size="sm" onClick={() => setUsing(true)}>
            Use blueprint
          </Button>
        }
      >
        Passes come from templates. Use this blueprint to make one first.
      </Callout>
      <UseBlueprintDialog key={String(using)} blueprint={b} open={using} onOpenChange={setUsing} />
    </>
  );
}
