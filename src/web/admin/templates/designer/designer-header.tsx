import { Redo2, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, IconButton, PageHeader } from '../../../ui/index.ts';
import type { Template } from '../versions.ts';
import type { CreateDesign } from './create-flow.ts';
import { useDesignerHost } from './host.tsx';
import type { Action } from './reducer.ts';

/** Title, crumbs and undo or redo. A draft of a new template names its organization and blueprint. */
export function DesignerHeader({
  templateId,
  name,
  create,
  template,
  undoRedo,
  modes,
}: {
  templateId: string;
  name: string;
  create: CreateDesign | undefined;
  /** Its release state names the host's next step beside Undo; absent for a new template. */
  template?: Template | undefined;
  /** A phone's compact mode select, drawn in the host's head row. */
  modes?: ReactNode;
  undoRedo: { canUndo: boolean; canRedo: boolean; dispatch: (action: Action) => void } | null;
}) {
  const host = useDesignerHost();
  const step = host.useReleaseStep(templateId, template);
  const next = step?.action ?? null;
  const actions =
    undoRedo || next ? (
      <>
        {next}
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
    ) : undefined;
  if (host.extras)
    return (
      <>
        <host.extras.Head name={name} actions={actions} modes={modes} />
        {step?.dialog}
      </>
    );
  return (
    <>
      <PageHeader
        title={create ? `Design ${name}` : name}
        breadcrumbs={host.crumbs({ templateId, name, create })}
        meta={
          create ? (
            <>
              <span>{create.orgName}</span>
              <span>From {create.blueprintName}</span>
              <Badge>Not saved</Badge>
            </>
          ) : undefined
        }
        actions={actions}
      />
      {step?.dialog}
    </>
  );
}
