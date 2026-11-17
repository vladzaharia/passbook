import { Redo2, Undo2 } from 'lucide-react';
import { Badge, IconButton, PageHeader } from '../../../ui/index.ts';
import type { CreateDesign } from './create-flow.ts';
import type { Action } from './reducer.ts';

/** Title, crumbs and undo or redo. A draft of a new template names its organization and blueprint. */
export function DesignerHeader({
  templateId,
  name,
  orgId,
  create,
  undoRedo,
}: {
  templateId: string;
  name: string;
  orgId: string | undefined;
  create: CreateDesign | undefined;
  undoRedo: { canUndo: boolean; canRedo: boolean; dispatch: (action: Action) => void } | null;
}) {
  return (
    <PageHeader
      title={create ? `Design ${name}` : name}
      breadcrumbs={
        create
          ? [
              { label: 'Blueprints', to: '/admin/blueprints' },
              { label: create.blueprintName, to: `/admin/blueprints/${templateId}` },
              { label: 'New template' },
            ]
          : [
              { label: 'Templates', to: '/admin/templates', search: { orgId } },
              { label: name, to: `/admin/templates/${templateId}`, search: { orgId } },
              { label: 'Design' },
            ]
      }
      meta={
        create ? (
          <>
            <span>{create.orgName}</span>
            <span>From {create.blueprintName}</span>
            <Badge>Not saved</Badge>
          </>
        ) : undefined
      }
      actions={
        undoRedo ? (
          <>
            <IconButton
              label="Undo"
              icon={<Undo2 aria-hidden />}
              variant="outline"
              disabled={!undoRedo.canUndo}
              onClick={() => undoRedo.dispatch({ type: 'undo' })}
            />
            <IconButton
              label="Redo"
              icon={<Redo2 aria-hidden />}
              variant="outline"
              disabled={!undoRedo.canRedo}
              onClick={() => undoRedo.dispatch({ type: 'redo' })}
            />
          </>
        ) : undefined
      }
    />
  );
}
