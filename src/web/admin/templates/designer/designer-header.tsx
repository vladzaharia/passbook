import { Link } from '@tanstack/react-router';
import { Redo2, Undo2 } from 'lucide-react';
import { orgPath } from '../../../lib/scope.ts';
import { Badge, Button, IconButton, PageHeader } from '../../../ui/index.ts';
import { isPrimary, nextAction } from '../releases/next-action.ts';
import { type Template, vOf } from '../versions.ts';
import type { CreateDesign } from './create-flow.ts';
import type { Action } from './reducer.ts';

/** Title, crumbs and undo or redo. A draft of a new template names its organization and blueprint. */
export function DesignerHeader({
  templateId,
  name,
  orgId,
  create,
  template,
  undoRedo,
}: {
  templateId: string;
  name: string;
  orgId: string | undefined;
  create: CreateDesign | undefined;
  /** Its release state names the next step beside Undo; absent for a new template. */
  template?: Template | undefined;
  undoRedo: { canUndo: boolean; canRedo: boolean; dispatch: (action: Action) => void } | null;
}) {
  const draft = template?.release?.draft?.version;
  const action = template?.release
    ? nextAction(template.release.next, draft ? vOf(template, draft) : '')
    : null;
  const next = action && isPrimary(action) && action.kind !== 'design' ? action : null;
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
              { label: 'Templates', to: orgId ? orgPath(orgId, '/templates') : undefined },
              { label: name, to: orgId ? orgPath(orgId, `/templates/${templateId}`) : undefined },
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
        undoRedo || next ? (
          <>
            {next?.kind === 'wait' ? <Badge tone="warning">{next.label}</Badge> : null}
            {next && next.kind !== 'wait' ? (
              <Button asChild className="whitespace-nowrap">
                <Link to="/admin/templates/$templateId" params={{ templateId }} search={{ orgId }}>
                  {next.label}
                </Link>
              </Button>
            ) : null}
            {undoRedo ? (
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
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
